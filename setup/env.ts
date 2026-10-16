import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { readEnvFile } from "../packages/host/src/config/env-file.ts";

export const OPERATOR_ENV_KEYS = [
  "ONECLI_URL",
  "ONECLI_API_KEY",
  "ONECLI_PROJECT_ID",
  "TELEGRAM_BOT_TOKEN",
  "MODEL_PROVIDER",
  "MODEL_ID",
  "MODEL_BASE_URL",
  "MODEL_CONTEXT_WINDOW",
  "MODEL_MAX_TOKENS",
  "CONTAINER_IMAGE",
  "CONTAINER_NETWORK",
  "GATEWAY_PROXY_HOST",
  "EGRESS_LOCKDOWN",
  "WEB_SEARCH_PROVIDER",
  "WEB_SEARCH_ENDPOINT",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
] as const;

const DEFAULTS: Record<string, string> = {
  MODEL_PROVIDER: "deepseek",
  MODEL_ID: "deepseek-chat",
  MODEL_BASE_URL: "https://api.deepseek.com",
  MODEL_CONTEXT_WINDOW: "128000",
  MODEL_MAX_TOKENS: "4096",
  CONTAINER_IMAGE: "mybots-agent:mailbox",
  CONTAINER_NETWORK: "mybots-isolated",
  GATEWAY_PROXY_HOST: "onecli",
  EGRESS_LOCKDOWN: "true",
};

/** Insert or replace operator assignments. Existing unrelated lines stay put. */
export async function upsertEnv(root: string, updates: Record<string, string>): Promise<void> {
  const file = join(root, ".env");
  let text = "";
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const pending = new Map(Object.entries(updates));
  const lines = text.length === 0 ? [] : text.split(/\r?\n/u);
  if (lines.at(-1) === "") lines.pop();
  const next = lines.map((line) => {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/u.exec(line);
    const key = match?.[1];
    if (!key || !pending.has(key)) return line;
    const value = pending.get(key) ?? "";
    pending.delete(key);
    return `${key}=${value}`;
  });
  for (const [key, value] of pending) next.push(`${key}=${value}`);
  await writeFile(file, `${next.join("\n")}\n`, { mode: 0o600 });
  await chmod(file, 0o600);
}

export async function ensureOperatorDefaults(
  root: string,
  env: NodeJS.ProcessEnv,
): Promise<Record<string, string>> {
  const current = await readEnvFile(root, Object.keys(DEFAULTS), env);
  const missing: Record<string, string> = {};
  for (const [key, value] of Object.entries(DEFAULTS)) {
    if (!current[key]) missing[key] = value;
  }
  if (Object.keys(missing).length > 0) await upsertEnv(root, missing);
  return readEnvFile(root, OPERATOR_ENV_KEYS, env);
}

export { readEnvFile };
