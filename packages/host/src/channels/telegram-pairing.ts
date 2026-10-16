import { randomInt } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const TELEGRAM_PAIRING_FILE = join("data", "telegram-pairing.json");

/** Wrong guesses that replace the code. The next wrong guess ends the attempt. */
const MAXIMUM_REPLACEMENTS = 5;

interface PairingState {
  code: string;
  wrongs: number;
}

export type PairingAttempt =
  | { kind: "absent" }
  | { kind: "matched" }
  | { kind: "replaced" }
  | { kind: "exhausted" };

export function createPairingCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

export function pairingMessageMatches(text: string, code: string): boolean {
  const spaced = code.split("").join("\\s*");
  return new RegExp(String.raw`^\s*${spaced}\s*$`, "u").test(text);
}

export async function writePairingState(root: string, state: PairingState): Promise<void> {
  const file = join(root, TELEGRAM_PAIRING_FILE);
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, `${JSON.stringify(state)}\n`, { mode: 0o600 });
}

export async function readPairingState(root: string): Promise<PairingState | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(join(root, TELEGRAM_PAIRING_FILE), "utf8"));
    if (
      !value ||
      typeof value !== "object" ||
      !("code" in value) ||
      !("wrongs" in value) ||
      typeof value.code !== "string" ||
      !/^\d{6}$/u.test(value.code) ||
      typeof value.wrongs !== "number" ||
      !Number.isInteger(value.wrongs) ||
      value.wrongs < 0
    )
      return undefined;
    return { code: value.code, wrongs: value.wrongs };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return undefined;
  }
}

/**
 * Compare one private-chat message with the pending code.
 * A match leaves the file in place until the caller finishes registration.
 */
export async function takePairingAttempt(root: string, text: string): Promise<PairingAttempt> {
  const state = await readPairingState(root);
  if (!state) return { kind: "absent" };
  if (!text.trim()) return { kind: "absent" };
  if (pairingMessageMatches(text, state.code)) return { kind: "matched" };
  const wrongs = state.wrongs + 1;
  if (wrongs > MAXIMUM_REPLACEMENTS) {
    await rm(join(root, TELEGRAM_PAIRING_FILE), { force: true });
    return { kind: "exhausted" };
  }
  await writePairingState(root, { code: createPairingCode(), wrongs });
  return { kind: "replaced" };
}

export async function completePairing(root: string): Promise<void> {
  await rm(join(root, TELEGRAM_PAIRING_FILE), { force: true });
}
