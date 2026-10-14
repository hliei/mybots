import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { ModelConfiguration } from "../drivers/types.ts";
import type { HostConfiguration } from "../host.ts";
import type { AgentResources } from "../mailbox/types.ts";
import { schema } from "./migrations/001-initial.ts";
import { resourceSchema } from "./migrations/002-agent-resources.ts";

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
}

export class HostStore {
  private readonly db: DatabaseSync;
  constructor(file: string, configuration: HostConfiguration) {
    this.db = new DatabaseSync(file);
    try {
      this.db.exec(
        "PRAGMA foreign_keys = ON; PRAGMA journal_mode = DELETE; PRAGMA busy_timeout = 5000;",
      );
      const { user_version } = this.db.prepare("PRAGMA user_version").get() as {
        user_version: number;
      };
      if (user_version === 0) this.db.exec(schema);
      if (user_version === 0 || user_version === 1) this.db.exec(resourceSchema);
      else if (user_version !== 2) throw new Error("Unsupported host schema version");
      this.seed(configuration);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  private seed(configuration: HostConfiguration): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const now = new Date().toISOString();
      const { agent, owner } = configuration;
      this.db
        .prepare("INSERT INTO users VALUES (?, ?, NULL, ?) ON CONFLICT(id) DO NOTHING")
        .run(owner, owner.split(":")[0], now);
      this.db
        .prepare("INSERT INTO user_roles VALUES (?, 'owner', NULL, ?, ?) ON CONFLICT DO NOTHING")
        .run(owner, owner, now);
      this.db
        .prepare(
          `INSERT INTO agent_groups VALUES (?, ?, ?, 'pi', ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, folder = excluded.folder`,
        )
        .run(agent.id, agent.name, agent.folder, now);
      this.db
        .prepare(
          `INSERT INTO container_configs (agent_group_id, provider, model, model_config, instructions, resources, updated_at) VALUES (?, 'pi', ?, ?, ?, ?, ?) ON CONFLICT(agent_group_id) DO UPDATE SET model = excluded.model, model_config = excluded.model_config, instructions = excluded.instructions, resources = excluded.resources, updated_at = excluded.updated_at`,
        )
        .run(
          agent.id,
          `${agent.model.provider}/${agent.model.id}`,
          JSON.stringify(agent.model),
          agent.instructions ?? null,
          agent.resources ? JSON.stringify(agent.resources) : null,
          now,
        );
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
          .run(randomUUID(), destination.id, agent.id, now);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  resolve(destinationId: string, userId: string): SessionRoute {
    this.db.exec("BEGIN IMMEDIATE");
    try {
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
          `SELECT a.id AS agent_group_id FROM messaging_group_agents w JOIN agent_groups a ON a.id = w.agent_group_id WHERE w.messaging_group_id = ? AND w.engage_mode = 'pattern' AND w.engage_pattern = '.' AND w.sender_scope = 'known' AND w.session_mode = 'shared' AND w.threads = 0`,
        )
        .all(destinationId);
      if (routes.length !== 1) throw new Error("Destination must be wired to one personal Agent");
      const agentId = routes[0].agent_group_id as string;
      let session = this.db
        .prepare(
          "SELECT * FROM sessions WHERE agent_group_id = ? AND messaging_group_id = ? AND thread_id IS NULL AND status = 'active'",
        )
        .get(agentId, destinationId) as unknown as SavedSession | undefined;
      const now = new Date().toISOString();
      if (!session) {
        const id = randomUUID();
        this.db
          .prepare(
            "INSERT INTO sessions (id, agent_group_id, messaging_group_id, created_at, last_active) VALUES (?, ?, ?, ?, ?)",
          )
          .run(id, agentId, destinationId, now, now);
        session = this.db
          .prepare("SELECT * FROM sessions WHERE id = ?")
          .get(id) as unknown as SavedSession;
      }
      this.db.prepare("UPDATE sessions SET last_active = ? WHERE id = ?").run(now, session.id);
      const route = this.route(session);
      this.db.exec("COMMIT");
      return route;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  route(session: SavedSession): SessionRoute {
    const row = this.db
      .prepare(
        `SELECT a.folder, m.channel_type, m.platform_id, m.instance, c.model_config, c.instructions, c.resources FROM agent_groups a JOIN container_configs c ON c.agent_group_id = a.id JOIN messaging_groups m ON m.id = ? WHERE a.id = ?`,
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
    };
  }

  sessions(): SavedSession[] {
    return this.db
      .prepare("SELECT * FROM sessions ORDER BY created_at, id")
      .all() as unknown as SavedSession[];
  }

  containerStatus(id: string, status: "starting" | "running" | "stopped" | "failed"): void {
    this.db.prepare("UPDATE sessions SET container_status = ? WHERE id = ?").run(status, id);
  }

  close(): void {
    this.db.close();
  }
}
