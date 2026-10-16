import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** Values requested from the install-root env file. The file is never copied into `process.env`. */
export async function readEnvFile(
  root: string,
  keys: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<Record<string, string>> {
  const requested = new Set(keys);
  const fromFile = new Map<string, string>();
  let text = "";
  try {
    text = await readFile(join(root, ".env"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const body = trimmed.startsWith("export ") ? trimmed.slice("export ".length).trim() : trimmed;
    const separator = body.indexOf("=");
    if (separator <= 0) continue;
    const key = body.slice(0, separator).trim();
    if (!requested.has(key)) continue;
    const value = unquote(body.slice(separator + 1).trim());
    if (value) fromFile.set(key, value);
  }
  const values: Record<string, string> = {};
  for (const key of keys) {
    const processValue = env[key];
    if (typeof processValue === "string" && processValue.trim()) values[key] = processValue;
    else {
      const fileValue = fromFile.get(key);
      if (fileValue) values[key] = fileValue;
    }
  }
  return values;
}

function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value.at(-1);
    if ((first === '"' || first === "'") && first === last) return value.slice(1, -1);
  }
  return value;
}
