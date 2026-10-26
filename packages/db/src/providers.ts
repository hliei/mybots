import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProviderId, ProviderStatus } from "@mybots/contracts";

const providers = [
  { id: "deepseek", name: "DeepSeek" },
  { id: "opencode-go", name: "OpenCode Go" },
] as const;

export class ProviderSettings {
  private readonly directory: string;
  private readonly file: string;

  constructor(root: string) {
    this.directory = join(root, "providers");
    this.file = join(this.directory, "credentials.json");
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    chmodSync(this.directory, 0o700);
    if (existsSync(this.file)) chmodSync(this.file, 0o600);
  }

  private read(): Partial<Record<ProviderId, string>> {
    if (!existsSync(this.file)) return {};
    const value: unknown = JSON.parse(readFileSync(this.file, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Invalid provider credential storage");
    const keys: Partial<Record<ProviderId, string>> = {};
    for (const { id } of providers) {
      const key = (value as Record<string, unknown>)[id];
      if (key !== undefined && typeof key !== "string")
        throw new Error("Invalid provider credential storage");
      if (typeof key === "string") keys[id] = key;
    }
    return keys;
  }

  key(id: ProviderId): string | undefined {
    return this.read()[id];
  }

  status(): ProviderStatus[] {
    const keys = this.read();
    return providers.map((provider) => ({ ...provider, configured: Boolean(keys[provider.id]) }));
  }

  update(id: ProviderId, value: unknown, remove = false): ProviderStatus[] {
    if (!providers.some((provider) => provider.id === id)) throw new Error("Unknown provider");
    if (!remove && (typeof value !== "string" || value.length > 4096 || /[^\x21-\x7e]/.test(value)))
      throw new Error("Invalid provider key");
    if (!remove && value === "") return this.status();
    const keys = this.read();
    if (remove) delete keys[id];
    else keys[id] = value as string;
    const temporary = join(this.directory, "credentials.tmp");
    writeFileSync(temporary, JSON.stringify(keys), { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, this.file);
    return this.status();
  }
}
