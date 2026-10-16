#!/usr/bin/env node
import { existsSync } from "node:fs";
import { homedir, platform, release, userInfo } from "node:os";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";

import { runSetup } from "./auto.ts";
import { SETUP_STEPS, type SetupContext, type SetupStepName } from "./steps.ts";

const args = process.argv.slice(2);
const stepFlag = args.indexOf("--step");
const selected = stepFlag === -1 ? undefined : args[stepFlag + 1];
if (stepFlag !== -1 && (!selected || !SETUP_STEPS.includes(selected as SetupStepName))) {
  console.error(`Unknown setup step. Use one of: ${SETUP_STEPS.join(", ")}.`);
  process.exitCode = 1;
} else {
  try {
    await runSetup(productionContext(), selected ? [selected as SetupStepName] : undefined);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

function productionContext(): SetupContext {
  const wsl = Boolean(process.env.WSL_DISTRO_NAME) || release().toLowerCase().includes("microsoft");
  let detected: SetupContext["platform"] = "linux";
  if (platform() === "darwin") detected = "darwin";
  else if (wsl && !existsSync("/run/systemd/system")) detected = "wsl";
  return {
    root: process.cwd(),
    env: process.env,
    platform: detected,
    uid: userInfo().uid,
    home: homedir(),
    nodePath: process.execPath,
    isTTY: Boolean(stdin.isTTY),
    fetch: globalThis.fetch,
    exec: execFile,
    prompt,
    log(line) {
      console.log(line);
    },
  };
}

async function execFile(command: string, args: string[]) {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  try {
    const result = await promisify(execFile)(command, args, {
      timeout: 30 * 60 * 1000,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return {
      code: typeof failed.code === "number" ? failed.code : 1,
      stdout: failed.stdout ?? "",
      stderr: failed.stderr ?? "",
    };
  }
}

async function prompt(spec: { secret: boolean; message: string }): Promise<string> {
  if (!spec.secret) {
    const prompts = createInterface({ input: stdin, output: stdout });
    try {
      return await prompts.question(spec.message);
    } finally {
      prompts.close();
    }
  }
  stdout.write(spec.message);
  return await new Promise((resolve, reject) => {
    const input = stdin;
    input.setRawMode?.(true);
    input.resume();
    let value = "";
    const onData = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      if (text === "\u0003") {
        cleanup();
        reject(new Error("Setup cancelled."));
        return;
      }
      if (text === "\r" || text === "\n" || text === "\u0004") {
        cleanup();
        stdout.write("\n");
        resolve(value);
        return;
      }
      if (text === "\u007f") {
        value = value.slice(0, -1);
        return;
      }
      value += text;
    };
    const cleanup = () => {
      input.setRawMode?.(false);
      input.pause();
      input.off("data", onData);
    };
    input.on("data", onData);
  });
}
