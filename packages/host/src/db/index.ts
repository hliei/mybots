import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AgentResources, WebConfiguration } from "@mybots/mailbox";
import {
  type BotConfigurationView,
  BotRequestError,
  type BotSettings,
  type ManagedBot,
} from "../bots.ts";
import type { ModelConfiguration } from "../drivers/types.ts";
import type { HostConfiguration } from "../host.ts";
import { LocalSkills, type SkillSelection } from "../skills.ts";
import { schema } from "./migrations/001-initial.ts";
import { resourceSchema } from "./migrations/002-agent-resources.ts";
import { deliveryAttemptSchema } from "./migrations/003-delivery-attempts.ts";
import { recoverySchema } from "./migrations/004-session-recovery.ts";
import { webSchema } from "./migrations/005-web-tools.ts";
import { managedBotSchema } from "./migrations/006-managed-bots.ts";
import { chatSchema } from "./migrations/007-chat-work.ts";
import { threadExecutionSchema } from "./migrations/008-thread-execution.ts";
import { runStopSchema } from "./migrations/009-run-stop.ts";
import { botConfigurationSchema } from "./migrations/010-bot-configuration.ts";
import { chatBackgroundSchema } from "./migrations/011-chat-background.ts";
import { fairAdmissionSchema } from "./migrations/012-fair-admission.ts";
import { runBudgetSchema } from "./migrations/013-run-budgets.ts";
import { taskAttachmentSchema } from "./migrations/014-task-attachments.ts";
import { agentPublicationSchema } from "./migrations/015-agent-publications.ts";
import { deliveredArtifactSchema } from "./migrations/016-delivered-artifacts.ts";
import { ownerQuestionSchema } from "./migrations/017-owner-questions.ts";
import { oneShotRoutineSchema } from "./migrations/018-one-shot-routines.ts";
import { cronRoutineSchema } from "./migrations/019-cron-routines.ts";
import { delegationSchema } from "./migrations/020-delegations.ts";
import { RoutineStore } from "./routines.ts";
import { ThreadStore } from "./threads.ts";

export interface HostInstance {
  instance_id: string;
  pid: number;
  started_at: string;
  heartbeat_at: string;
  stopped_at: string | null;
}

export interface SessionClaim {
  session_id: string;
  incarnation: number;
  claimed_by: string | null;
  claimed_at: string | null;
  container_ref: string | null;
  updated_at: string;
}

/** Session routing plus the persisted lifecycle observed for it. */
export interface SavedSession {
  id: string;
  agent_group_id: string;
  messaging_group_id: string;
  thread_id: string | null;
  agent_provider: string | null;
  status: string;
  container_status: string;
  last_active: string | null;
  created_at: string;
  name: string;
  purpose: string;
}

export interface SessionRoute {
  session: SavedSession;
  folder: string;
  channel_type: string;
  platform_id: string;
  instance: string;
  model: ModelConfiguration;
  instructions?: string;
  resources?: AgentResources;
  web?: WebConfiguration;
  configurationVersion: number;
}

/** Persisted platform-delivery bookkeeping for one outbound mailbox row. */
export interface DeliveryAttempt {
  message_id: string;
  session_id: string;
  attempts: number;
  last_attempt_at: string | null;
  next_attempt_at: string | null;
  last_error: string | null;
}

export class HostStore {
  private readonly db: DatabaseSync;
  readonly threads: ThreadStore;
  readonly routines: RoutineStore;
  constructor(file: string, configuration: HostConfiguration) {
    this.db = new DatabaseSync(file);
    try {
      this.db.exec(
        "PRAGMA foreign_keys = ON; PRAGMA journal_mode = DELETE; PRAGMA busy_timeout = 5000;",
      );
      const { user_version } = this.db.prepare("PRAGMA user_version").get() as {
        user_version: number;
      };
      if (user_version > 20) throw new Error("Unsupported host schema version");
      if (
        user_version > 0 &&
        user_version < 8 &&
        this.db.prepare("SELECT id FROM sessions LIMIT 1").get()
      )
        throw new Error(
          "Fresh execution state required: stop the Host and remove data/host.db and data/sessions; retain deployment credentials and groups.",
        );
      if (user_version === 0) this.db.exec(schema);
      if (user_version <= 1) this.db.exec(resourceSchema);
      if (user_version <= 2) this.db.exec(deliveryAttemptSchema);
      if (user_version <= 3) this.db.exec(recoverySchema);
      if (user_version <= 4) this.db.exec(webSchema);
      if (user_version <= 5) this.db.exec(managedBotSchema);
      if (user_version <= 6) this.db.exec(chatSchema);
      if (user_version <= 7) this.db.exec(threadExecutionSchema);
      if (user_version <= 8) this.db.exec(runStopSchema);
      if (user_version <= 9) this.db.exec(botConfigurationSchema);
      if (user_version <= 10) this.db.exec(chatBackgroundSchema);
      if (user_version <= 11) this.db.exec(fairAdmissionSchema);
      if (user_version <= 12) this.db.exec(runBudgetSchema);
      if (user_version <= 13) this.db.exec(taskAttachmentSchema);
      if (user_version <= 14) this.db.exec(agentPublicationSchema);
      if (user_version <= 15) this.db.exec(deliveredArtifactSchema);
      if (user_version <= 16) this.db.exec(ownerQuestionSchema);
      if (user_version <= 17) this.db.exec(oneShotRoutineSchema);
      if (user_version <= 18) this.db.exec(cronRoutineSchema);
      if (user_version <= 19) this.db.exec(delegationSchema);
      this.routines = new RoutineStore(this.db);
      this.seed(configuration, dirname(dirname(file)));
      this.threads = new ThreadStore(this.db);
      this.threads.ensureThreads(new Date().toISOString());
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  private seed(configuration: HostConfiguration, root: string): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const now = new Date().toISOString();
      const { agent, owners } = configuration;
      for (const owner of owners) {
        this.db
          .prepare("INSERT INTO users VALUES (?, ?, NULL, ?) ON CONFLICT(id) DO NOTHING")
          .run(owner, owner.split(":")[0], now);
        this.db
          .prepare("INSERT INTO user_roles VALUES (?, 'owner', NULL, ?, ?) ON CONFLICT DO NOTHING")
          .run(owner, owner, now);
      }
      let bootstrapId = this.db
        .prepare("SELECT agent_group_id FROM bot_bootstrap WHERE singleton = 1")
        .get()?.agent_group_id as string | undefined;
      if (!bootstrapId) {
        const resources = agent.resources ? { ...agent.resources } : undefined;
        if (resources?.skills?.length && !resources.skillRevisions) {
          const library = new LocalSkills(root);
          resources.skillRevisions = Object.fromEntries(
            resources.skills.map((id) => {
              const revision = library.import(agent.id, {
                id,
                path: join(root, "groups", agent.folder, "skills", id),
              });
              return [id, revision.revision];
            }),
          );
        }
        this.db
          .prepare(`INSERT INTO agent_groups VALUES (?, ?, ?, 'pi', ?) ON CONFLICT(id) DO NOTHING`)
          .run(agent.id, agent.name, agent.folder, now);
        this.db
          .prepare(
            `INSERT INTO container_configs (agent_group_id, provider, model, model_config, instructions, resources, web, updated_at) VALUES (?, 'pi', ?, ?, ?, ?, ?, ?) ON CONFLICT(agent_group_id) DO NOTHING`,
          )
          .run(
            agent.id,
            `${agent.model.provider}/${agent.model.id}`,
            JSON.stringify(agent.model),
            agent.instructions ?? null,
            resources ? JSON.stringify(resources) : null,
            agent.web ? JSON.stringify(agent.web) : null,
            now,
          );
        this.db.prepare("INSERT INTO bot_bootstrap VALUES (1, ?)").run(agent.id);
        bootstrapId = agent.id;
      }
      this.db
        .prepare(`INSERT INTO configuration_versions
        (agent_group_id, version, instructions, model_config, resources, web, created_at)
        SELECT agent_group_id, version, instructions, model_config, resources, web, updated_at
        FROM container_configs WHERE NOT EXISTS (
          SELECT 1 FROM configuration_versions v
          WHERE v.agent_group_id = container_configs.agent_group_id AND v.version = container_configs.version
        )`)
        .run();
      for (const destination of configuration.destinations) {
        const existing = this.db
          .prepare("SELECT channel_type, platform_id, instance FROM messaging_groups WHERE id = ?")
          .get(destination.id);
        if (
          existing &&
          (existing.channel_type !== destination.channelType ||
            existing.platform_id !== destination.platformId ||
            existing.instance !== destination.instance)
        )
          throw new Error("Configured destination identity changed");
        this.db
          .prepare(
            "INSERT INTO messaging_groups (id, channel_type, platform_id, instance, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING",
          )
          .run(
            destination.id,
            destination.channelType,
            destination.platformId,
            destination.instance,
            now,
          );
        this.db
          .prepare(
            "INSERT INTO messaging_group_agents (id, messaging_group_id, agent_group_id, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(messaging_group_id, agent_group_id) DO NOTHING",
          )
          .run(randomUUID(), destination.id, bootstrapId, now);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  ownerDestination(destinationId: string, userId: string): string {
    if (
      !this.db
        .prepare(
          "SELECT 1 FROM user_roles WHERE user_id = ? AND role = 'owner' AND agent_group_id IS NULL",
        )
        .get(userId)
    )
      throw new Error("Owner identity required");
    const routes = this.db
      .prepare(
        `SELECT agent_group_id FROM messaging_group_agents WHERE messaging_group_id = ? AND engage_mode = 'pattern' AND engage_pattern = '.' AND sender_scope = 'known' AND session_mode = 'shared' AND threads = 0`,
      )
      .all(destinationId);
    if (routes.length !== 1) throw new Error("Destination must be wired to one personal Agent");
    return routes[0]?.agent_group_id as string;
  }

  route(session: SavedSession): SessionRoute {
    const row = this.db
      .prepare(
        `SELECT a.folder, m.channel_type, m.platform_id, m.instance, c.model_config, c.instructions, c.resources, c.web, c.version FROM agent_groups a JOIN container_configs c ON c.agent_group_id = a.id JOIN messaging_groups m ON m.id = ? WHERE a.id = ?`,
      )
      .get(session.messaging_group_id, session.agent_group_id);
    if (!row) throw new Error("Session routing is unavailable");
    return {
      session,
      folder: row.folder as string,
      channel_type: row.channel_type as string,
      platform_id: row.platform_id as string,
      instance: row.instance as string,
      model: JSON.parse(row.model_config as string) as ModelConfiguration,
      instructions: (row.instructions as string | null) ?? undefined,
      resources: row.resources
        ? (JSON.parse(row.resources as string) as AgentResources)
        : undefined,
      web: row.web ? (JSON.parse(row.web as string) as WebConfiguration) : undefined,
      configurationVersion: row.version as number,
    };
  }

  bots(): { id: string; name: string }[] {
    return this.db
      .prepare("SELECT id, name FROM agent_groups ORDER BY created_at, id")
      .all() as unknown as { id: string; name: string }[];
  }

  private configurationView(
    instructions: string | null,
    modelConfig: string,
    resourcesJson: string | null,
  ): BotConfigurationView {
    const model = JSON.parse(modelConfig) as ModelConfiguration;
    const resources = resourcesJson ? (JSON.parse(resourcesJson) as AgentResources) : undefined;
    return {
      instructions: instructions ?? "",
      model: { provider: model.provider, id: model.id },
      skills: Object.entries(resources?.skillRevisions ?? {}).map(([id, revision]) => ({
        id,
        revision,
      })),
      tools: [...(resources?.tools ?? ["read", "write", "edit", "bash"])],
    };
  }

  managedBots(): ManagedBot[] {
    return this.db
      .prepare(`SELECT a.id, a.name, a.folder, c.instructions, c.model_config, c.resources, c.version
      FROM agent_groups a JOIN container_configs c ON c.agent_group_id = a.id ORDER BY a.created_at, a.id`)
      .all()
      .map((row) => {
        const saved = this.configurationView(
          row.instructions as string | null,
          row.model_config as string,
          row.resources as string | null,
        );
        const open = this.db
          .prepare(`SELECT a.configuration_version AS version FROM attempts a
          JOIN sessions s ON s.id = a.run_id
          WHERE s.agent_group_id = ? AND a.ended_at IS NULL ORDER BY a.rowid DESC LIMIT 1`)
          .get(row.id) as { version: number } | undefined;
        const effectiveVersion = open?.version ?? (row.version as number);
        const effectiveRow =
          effectiveVersion === row.version
            ? undefined
            : (this.db
                .prepare(`SELECT instructions, model_config, resources FROM configuration_versions
            WHERE agent_group_id = ? AND version = ?`)
                .get(row.id, effectiveVersion) as
                | { instructions: string | null; model_config: string; resources: string | null }
                | undefined);
        return {
          id: row.id as string,
          name: row.name as string,
          workspace: `groups/${row.folder}`,
          ...saved,
          savedVersion: row.version as number,
          effectiveVersion,
          effective: effectiveRow
            ? this.configurationView(
                effectiveRow.instructions,
                effectiveRow.model_config,
                effectiveRow.resources,
              )
            : saved,
        };
      });
  }

  botCreation(input: BotSettings & { requestId: string }): ManagedBot | undefined {
    const row = this.db
      .prepare("SELECT agent_group_id, payload FROM bot_creations WHERE request_id = ?")
      .get(input.requestId);
    if (!row) return undefined;
    if (row.payload !== JSON.stringify(input))
      throw new BotRequestError("This requestId already belongs to different Bot settings.", 409);
    return this.managedBots().find((bot) => bot.id === row.agent_group_id);
  }

  createBot(
    input: BotSettings & { requestId: string },
    id: string,
    folder: string,
    model: ModelConfiguration,
    web: WebConfiguration | undefined,
  ): ManagedBot {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const now = new Date().toISOString();
      this.db
        .prepare("INSERT INTO agent_groups VALUES (?, ?, ?, 'pi', ?)")
        .run(id, input.name, folder, now);
      this.db
        .prepare(`INSERT INTO container_configs
        (agent_group_id, provider, model, model_config, instructions, resources, web, updated_at)
        VALUES (?, 'pi', ?, ?, ?, ?, ?, ?)`)
        .run(
          id,
          `${model.provider}/${model.id}`,
          JSON.stringify(model),
          input.instructions,
          JSON.stringify({ tools: input.tools, skills: [] }),
          web ? JSON.stringify(web) : null,
          now,
        );
      this.db
        .prepare(`INSERT INTO configuration_versions
        (agent_group_id, version, instructions, model_config, resources, web, created_at)
        VALUES (?, 1, ?, ?, ?, ?, ?)`)
        .run(
          id,
          input.instructions,
          JSON.stringify(model),
          JSON.stringify({ tools: input.tools, skills: [] }),
          web ? JSON.stringify(web) : null,
          now,
        );
      this.db
        .prepare("INSERT INTO bot_creations VALUES (?, ?, ?)")
        .run(input.requestId, id, JSON.stringify(input));
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.managedBots().find((bot) => bot.id === id) as ManagedBot;
  }

  savedConfigurationVersion(botId: string): number {
    const row = this.db
      .prepare("SELECT version FROM container_configs WHERE agent_group_id = ?")
      .get(botId) as { version: number } | undefined;
    if (!row) throw new BotRequestError("Bot not found.", 404);
    return row.version;
  }

  configurationSnapshot(botId: string, version: number) {
    const row = this.db
      .prepare(`SELECT instructions, model_config, resources, web FROM configuration_versions
      WHERE agent_group_id = ? AND version = ?`)
      .get(botId, version) as
      | {
          instructions: string | null;
          model_config: string;
          resources: string | null;
          web: string | null;
        }
      | undefined;
    if (!row) throw new Error("Configuration version is unavailable");
    return {
      configurationVersion: version,
      instructions: row.instructions ?? undefined,
      model: JSON.parse(row.model_config) as ModelConfiguration,
      resources: row.resources ? (JSON.parse(row.resources) as AgentResources) : undefined,
      web: row.web ? (JSON.parse(row.web) as WebConfiguration) : undefined,
    };
  }

  updateBot(
    botId: string,
    input: {
      requestId: string;
      instructions: string;
      model: { provider: string; id: string };
      tools: string[];
      skills?: SkillSelection[];
    },
    model: ModelConfiguration,
  ): { bot: ManagedBot; replayed: boolean } {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const payload = JSON.stringify(input);
      const saved = this.db
        .prepare("SELECT agent_group_id, payload FROM bot_updates WHERE request_id = ?")
        .get(input.requestId) as { agent_group_id: string; payload: string } | undefined;
      if (saved) {
        if (saved.agent_group_id !== botId || saved.payload !== payload)
          throw new BotRequestError(
            "This requestId already belongs to different Bot settings.",
            409,
          );
        this.db.exec("COMMIT");
        const bot = this.managedBots().find((item) => item.id === botId);
        if (!bot) throw new BotRequestError("Bot not found.", 404);
        return { bot, replayed: true };
      }
      const current = this.db
        .prepare("SELECT version, resources, web FROM container_configs WHERE agent_group_id = ?")
        .get(botId) as
        | { version: number; resources: string | null; web: string | null }
        | undefined;
      if (!current) throw new BotRequestError("Bot not found.", 404);
      const resources = JSON.parse(current.resources ?? "{}") as AgentResources;
      const nextResources = {
        ...resources,
        tools: input.tools,
        skills: input.skills?.map((skill) => skill.id) ?? resources.skills ?? [],
        ...(input.skills
          ? {
              skillRevisions: Object.fromEntries(
                input.skills.map((skill) => [skill.id, skill.revision]),
              ),
            }
          : {}),
      };
      const version = current.version + 1;
      const now = new Date().toISOString();
      this.db
        .prepare(`UPDATE container_configs
        SET model = ?, model_config = ?, instructions = ?, resources = ?, version = ?, updated_at = ?
        WHERE agent_group_id = ?`)
        .run(
          `${model.provider}/${model.id}`,
          JSON.stringify(model),
          input.instructions,
          JSON.stringify(nextResources),
          version,
          now,
          botId,
        );
      this.db
        .prepare(`INSERT INTO configuration_versions
        (agent_group_id, version, instructions, model_config, resources, web, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(
          botId,
          version,
          input.instructions,
          JSON.stringify(model),
          JSON.stringify(nextResources),
          current.web,
          now,
        );
      this.db
        .prepare("INSERT INTO bot_updates VALUES (?, ?, ?, ?)")
        .run(input.requestId, botId, payload, version);
      this.threads.armCutoff(botId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    const bot = this.managedBots().find((item) => item.id === botId);
    if (!bot) throw new BotRequestError("Bot not found.", 404);
    return { bot, replayed: false };
  }

  sessions(): SavedSession[] {
    return this.db
      .prepare("SELECT * FROM sessions ORDER BY created_at, id")
      .all() as unknown as SavedSession[];
  }

  containerStatus(id: string, status: "starting" | "running" | "stopped" | "failed"): void {
    this.db.prepare("UPDATE sessions SET container_status = ? WHERE id = ?").run(status, id);
  }

  containerStatusOf(id: string): string | undefined {
    return (
      this.db.prepare("SELECT container_status FROM sessions WHERE id = ?").get(id) as
        | { container_status: string }
        | undefined
    )?.container_status;
  }

  registerHostInstance(instanceId: string, pid: number, now: string): void {
    this.db
      .prepare(
        "INSERT INTO host_instances VALUES (?, ?, ?, ?, NULL) ON CONFLICT(instance_id) DO UPDATE SET pid = excluded.pid, heartbeat_at = excluded.heartbeat_at, stopped_at = NULL",
      )
      .run(instanceId, pid, now, now);
  }

  touchHostInstance(instanceId: string, now: string): void {
    this.db
      .prepare(
        "UPDATE host_instances SET heartbeat_at = ? WHERE instance_id = ? AND stopped_at IS NULL",
      )
      .run(now, instanceId);
  }

  /** Replace the single Telegram owner and the `owner-chat` destination. */
  registerTelegramOwner(platformId: string, instance: string): void {
    if (!/^\d+$/u.test(platformId)) throw new Error("Telegram owner must be a numeric user id");
    const now = new Date().toISOString();
    const owner = `telegram:${platformId}`;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const agent = this.db
        .prepare("SELECT agent_group_id AS id FROM bot_bootstrap WHERE singleton = 1")
        .get() as { id: string } | undefined;
      if (!agent) throw new Error("Telegram pairing requires the personal Agent");
      this.db.prepare("DELETE FROM user_roles WHERE user_id LIKE 'telegram:%'").run();
      this.db.prepare("DELETE FROM users WHERE id LIKE 'telegram:%'").run();
      this.db.prepare("INSERT INTO users VALUES (?, 'telegram', NULL, ?)").run(owner, now);
      this.db
        .prepare("INSERT INTO user_roles VALUES (?, 'owner', NULL, ?, ?)")
        .run(owner, owner, now);
      const existing = this.db
        .prepare("SELECT id FROM messaging_groups WHERE id = 'owner-chat'")
        .get();
      if (existing) {
        this.db
          .prepare(
            "UPDATE messaging_groups SET channel_type = 'telegram', platform_id = ?, instance = ? WHERE id = 'owner-chat'",
          )
          .run(platformId, instance);
      } else {
        this.db
          .prepare(
            "INSERT INTO messaging_groups (id, channel_type, platform_id, instance, created_at) VALUES ('owner-chat', 'telegram', ?, ?, ?)",
          )
          .run(platformId, instance, now);
      }
      this.db
        .prepare(
          "INSERT INTO messaging_group_agents (id, messaging_group_id, agent_group_id, created_at) VALUES (?, 'owner-chat', ?, ?) ON CONFLICT(messaging_group_id, agent_group_id) DO NOTHING",
        )
        .run(randomUUID(), agent.id, now);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  stopHostInstance(instanceId: string, now: string): void {
    this.db
      .prepare(
        "UPDATE host_instances SET stopped_at = ? WHERE instance_id = ? AND stopped_at IS NULL",
      )
      .run(now, instanceId);
  }

  /** Records instances left open by an abnormal exit; the new host owns the data directory. */
  stopOpenHostInstances(now: string): void {
    this.db.prepare("UPDATE host_instances SET stopped_at = ? WHERE stopped_at IS NULL").run(now);
  }

  currentClaim(sessionId: string): SessionClaim | undefined {
    return this.db.prepare("SELECT * FROM session_claims WHERE session_id = ?").get(sessionId) as
      | SessionClaim
      | undefined;
  }

  /**
   * Fenced claim of one session. Bumps the incarnation only when the caller's
   * expected incarnation still holds, so a superseded host cannot take over.
   */
  tryClaimSession(input: {
    sessionId: string;
    instanceId: string;
    expectedIncarnation: number;
    containerRef: string | null;
    now: string;
  }): number | undefined {
    const next = input.expectedIncarnation + 1;
    if (input.expectedIncarnation === 0) {
      const inserted = this.db
        .prepare(
          "INSERT INTO session_claims VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(session_id) DO NOTHING",
        )
        .run(input.sessionId, next, input.instanceId, input.now, input.containerRef, input.now);
      if (inserted.changes > 0) return next;
    }
    const updated = this.db
      .prepare(
        "UPDATE session_claims SET incarnation = ?, claimed_by = ?, claimed_at = ?, container_ref = ?, updated_at = ? WHERE session_id = ? AND incarnation = ?",
      )
      .run(
        next,
        input.instanceId,
        input.now,
        input.containerRef,
        input.now,
        input.sessionId,
        input.expectedIncarnation,
      );
    return updated.changes > 0 ? next : undefined;
  }

  markContainerRef(sessionId: string, containerRef: string | null, now: string): void {
    this.db
      .prepare("UPDATE session_claims SET container_ref = ?, updated_at = ? WHERE session_id = ?")
      .run(containerRef, now, sessionId);
  }

  releaseClaims(instanceId: string, now: string): void {
    this.db
      .prepare(
        "UPDATE session_claims SET claimed_by = NULL, claimed_at = NULL, container_ref = NULL, updated_at = ? WHERE claimed_by = ?",
      )
      .run(now, instanceId);
  }

  /** Record one platform-delivery failure; returns the total attempts for the message. */
  recordDeliveryAttempt(input: {
    messageId: string;
    sessionId: string;
    at: string;
    nextAttemptAt: string | null;
    error?: string;
  }): number {
    this.db
      .prepare(
        `INSERT INTO delivery_attempts (message_id, session_id, attempts, last_attempt_at, next_attempt_at, last_error)
         VALUES (?, ?, 1, ?, ?, ?)
         ON CONFLICT(message_id) DO UPDATE SET session_id = excluded.session_id,
           attempts = delivery_attempts.attempts + 1, last_attempt_at = excluded.last_attempt_at,
           next_attempt_at = excluded.next_attempt_at, last_error = excluded.last_error`,
      )
      .run(input.messageId, input.sessionId, input.at, input.nextAttemptAt, input.error ?? null);
    const row = this.db
      .prepare("SELECT attempts FROM delivery_attempts WHERE message_id = ?")
      .get(input.messageId) as { attempts: number };
    return row.attempts;
  }

  deliveryAttempt(messageId: string): DeliveryAttempt | undefined {
    return this.db.prepare("SELECT * FROM delivery_attempts WHERE message_id = ?").get(messageId) as
      | DeliveryAttempt
      | undefined;
  }

  /** The message reached a terminal delivery state; its attempt row is no longer needed. */
  clearDeliveryAttempt(messageId: string): void {
    this.db.prepare("DELETE FROM delivery_attempts WHERE message_id = ?").run(messageId);
  }

  close(): void {
    this.db.close();
  }
}

/** The paired Telegram private chat, when host state already has one. */
export function readPairedTelegram(
  root: string,
): { platformId: string; instance: string } | undefined {
  const file = join(root, "data", "host.db");
  if (!existsSync(file)) return undefined;
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const row = db
      .prepare(
        "SELECT platform_id, instance FROM messaging_groups WHERE id = 'owner-chat' AND channel_type = 'telegram'",
      )
      .get() as { platform_id: string; instance: string } | undefined;
    if (!row || !/^\d+$/u.test(row.platform_id)) return undefined;
    const owner = db
      .prepare("SELECT 1 AS ok FROM user_roles WHERE user_id = ? AND role = 'owner'")
      .get(`telegram:${row.platform_id}`) as { ok: number } | undefined;
    if (!owner) return undefined;
    return { platformId: row.platform_id, instance: row.instance };
  } finally {
    db.close();
  }
}
