import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { runSetupStep, SETUP_STEPS, type SetupContext, type SetupStepName } from "./steps.ts";

export function skippedSteps(value: string | undefined): Set<string> {
  const names = (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const unknown = names.filter((name) => !SETUP_STEPS.includes(name as SetupStepName));
  if (unknown.length > 0) {
    throw new Error(`Unknown MYBOTS_SKIP step: ${unknown.join(", ")}.`);
  }
  return new Set(names);
}

/** Run the wizard steps, writing one progression line and one verbatim step log. */
export async function runSetup(
  context: SetupContext,
  steps: readonly SetupStepName[] = SETUP_STEPS,
): Promise<void> {
  const skip = skippedSteps(context.env.MYBOTS_SKIP);
  await mkdir(join(context.root, "logs", "setup-steps"), { recursive: true });
  const progression = join(context.root, "logs", "setup.log");
  for (const [index, step] of steps.entries()) {
    const number = String(index + 1).padStart(2, "0");
    if (skip.has(step)) {
      await appendFile(progression, `${number} ${step} skipped\n`);
      continue;
    }
    const lines: string[] = [];
    const scoped: SetupContext = {
      ...context,
      log(line: string) {
        lines.push(line);
        context.log(line);
      },
    };
    try {
      await runSetupStep(step, scoped);
      await appendFile(progression, `${number} ${step} ok\n`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      lines.push(message);
      await writeFile(
        join(context.root, "logs", "setup-steps", `${number}-${step}.log`),
        `${lines.join("\n")}\n`,
      );
      await appendFile(progression, `${number} ${step} failed\n`);
      throw new Error(`${message}\nSee logs/setup.log and logs/setup-steps.`);
    }
    await writeFile(
      join(context.root, "logs", "setup-steps", `${number}-${step}.log`),
      `${lines.join("\n")}\n`,
    );
  }
}
