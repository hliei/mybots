import { randomUUID } from "node:crypto";
import type { FSWatcher } from "node:fs";
import { watch } from "node:fs";
import { rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { stringify } from "yaml";
import type { AgentDefinition, WorkspaceSettings } from "./workspace.ts";
import {
  loadAgentDefinition,
  mergeSettings,
  parseSettingsSource,
  readSettingsFile,
  readWorkspaceSettings,
  validateSettings,
} from "./workspace.ts";

const restartFields = [
  "agents_path",
  "skills_path",
  "history_path",
  "logging_path",
  "event_path",
  "channels",
  "api",
] as const;

/** A runtime owns one configuration store; Agents take independent turn snapshots. */
export class WorkspaceConfiguration {
  private settings: WorkspaceSettings;
  private readonly startup: WorkspaceSettings;
  private definitions: Map<string, AgentDefinition>;
  private queue: Promise<void> = Promise.resolve();
  private watcher: FSWatcher | undefined;
  private stopped = false;
  private reloadQueued = false;
  lastError: string | undefined;

  private constructor(settings: WorkspaceSettings, definitions: Map<string, AgentDefinition>) {
    this.settings = settings;
    this.startup = structuredClone(settings);
    this.definitions = definitions;
  }

  static async open(workspace: string, agentId?: string): Promise<WorkspaceConfiguration> {
    const settings = await readWorkspaceSettings(resolve(workspace));
    const definitions = new Map<string, AgentDefinition>();
    for (const id of new Set([settings.default_agent, agentId ?? settings.default_agent])) {
      definitions.set(id, await loadAgentDefinition(settings, id));
    }
    return new WorkspaceConfiguration(settings, definitions);
  }

  startWatching(): void {
    if (this.stopped) throw new Error("Configuration store is stopped.");
    if (this.watcher) return;
    this.watcher = watch(this.startup.workspace, { persistent: false }, (_event, filename) => {
      if (
        filename !== null &&
        !["config.user.yaml", "config.runtime.yaml"].includes(String(filename))
      )
        return;
      if (this.stopped || this.reloadQueued) return;
      this.reloadQueued = true;
      void this.serialize(async () => {
        this.reloadQueued = false;
        if (!this.stopped) await this.reloadSettings();
      });
    });
    this.watcher.on("error", (error) => {
      this.lastError = error.message;
      this.watcher?.close();
      this.watcher = undefined;
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.watcher?.close();
    this.watcher = undefined;
    await this.queue;
  }

  get config(): WorkspaceSettings {
    return structuredClone(this.settings);
  }

  get activeConfig(): WorkspaceSettings {
    return this.active(this.settings);
  }

  get restartRequired(): string[] {
    return restartFields.filter(
      (field) => JSON.stringify(this.settings[field]) !== JSON.stringify(this.startup[field]),
    );
  }

  private active(settings: WorkspaceSettings): WorkspaceSettings {
    return structuredClone({
      ...settings,
      ...Object.fromEntries(restartFields.map((field) => [field, this.startup[field]])),
    });
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    if (this.stopped) return Promise.reject(new Error("Configuration store is stopped."));
    const result = this.queue.then(operation);
    this.queue = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  private async candidate(settings: WorkspaceSettings): Promise<Map<string, AgentDefinition>> {
    const definitions = new Map<string, AgentDefinition>();
    for (const id of new Set([...this.definitions.keys(), settings.default_agent])) {
      definitions.set(id, await loadAgentDefinition(this.active(settings), id));
    }
    return definitions;
  }

  private async reloadSettings(): Promise<boolean> {
    try {
      const settings = await readWorkspaceSettings(this.startup.workspace);
      const definitions = await this.candidate(settings);
      this.settings = settings;
      this.definitions = definitions;
      this.lastError = undefined;
      return true;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      return false;
    }
  }

  updateRuntime(patch: Record<string, unknown>): Promise<void> {
    return this.serialize(async () => {
      if (!patch || typeof patch !== "object" || Array.isArray(patch))
        throw new Error("Runtime update must be a mapping.");
      const path = resolve(this.startup.workspace, "config.runtime.yaml");
      const serialized = stringify(mergeSettings(await readSettingsFile(path), patch));
      const runtime = parseSettingsSource(serialized, "runtime update");
      const settings = validateSettings(
        this.startup.workspace,
        mergeSettings(
          await readSettingsFile(resolve(this.startup.workspace, "config.user.yaml")),
          runtime,
        ),
      );
      const definitions = await this.candidate(settings);
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, serialized, { flag: "wx", mode: 0o600 });
        await rename(temporary, path);
      } finally {
        await rm(temporary, { force: true });
      }
      this.settings = settings;
      this.definitions = definitions;
      this.lastError = undefined;
    });
  }

  reload(): Promise<boolean> {
    return this.serialize(() => this.reloadSettings());
  }

  snapshot(agentId?: string): Promise<{ config: WorkspaceSettings; definition: AgentDefinition }> {
    return this.serialize(async () => {
      await this.reloadSettings();
      const id = agentId ?? this.settings.default_agent;
      let definition = this.definitions.get(id);
      if (!definition) {
        definition = await loadAgentDefinition(this.activeConfig, id);
        this.definitions.set(id, definition);
      }
      return { config: this.activeConfig, definition: structuredClone(definition) };
    });
  }
}
