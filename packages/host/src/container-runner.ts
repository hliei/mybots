import { lstatSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { AgentResources, RunContext, SessionKey, WebConfiguration } from "@mybots/mailbox";
import { resolveWebTools, validateAgentResources, validateWebConfiguration } from "@mybots/mailbox";
import { initializeMailbox } from "@mybots/mailbox/node";
import type { ModelConfiguration, SessionMaterial } from "./drivers/types.ts";

function legalName(value: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value);
}

function runnerContext(input: {
  model: ModelConfiguration;
  instructions?: string;
  resources?: AgentResources;
  web?: WebConfiguration;
  runContext?: RunContext;
  configurationVersion: number;
}): string {
  const endpoint = new URL(input.model.baseUrl);
  const resources = validateAgentResources(input.resources);
  const web = resolveWebTools(resources, validateWebConfiguration(input.web));
  return `${JSON.stringify({
    configurationVersion: input.configurationVersion,
    model: {
      provider: input.model.provider,
      id: input.model.id,
      baseUrl: endpoint.href,
      contextWindow: input.model.contextWindow,
      maxTokens: input.model.maxTokens,
    },
    instructions: input.instructions,
    resources,
    web,
    runContext: input.runContext,
  })}\n`;
}

/** Creates only the selected session's material; host identity/routing is supplied by the caller. */
export async function provisionSession(input: {
  root: string;
  key: SessionKey;
  folder: string;
  model: ModelConfiguration;
  instructions?: string;
  resources?: AgentResources;
  web?: WebConfiguration;
  runContext?: RunContext;
  configurationVersion?: number;
  /** Keep a stopped Run's previous file so Attempt startup can replace it explicitly. */
  retainExistingContext?: boolean;
}): Promise<SessionMaterial> {
  if (![input.key.agentGroupId, input.key.sessionId, input.folder].every(legalName))
    throw new Error("Invalid Agent/session path identity");
  const endpoint = new URL(input.model.baseUrl);
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  )
    throw new Error("Model endpoint must be HTTPS without credentials");
  if (
    !input.model.provider ||
    !input.model.id ||
    !Number.isSafeInteger(input.model.contextWindow) ||
    !Number.isSafeInteger(input.model.maxTokens) ||
    input.model.maxTokens <= 0 ||
    input.model.contextWindow < input.model.maxTokens
  )
    throw new Error("Invalid model configuration");
  await mkdir(resolve(input.root), { recursive: true });
  const root = await realpath(input.root);
  const directory = join(root, "data", "sessions", input.key.agentGroupId, input.key.sessionId);
  const workspace = join(root, "groups", input.folder);
  const contextDirectory = join(root, "data", "sessions", input.key.agentGroupId, ".context");
  for (const path of [directory, workspace, contextDirectory]) {
    // Refuse symlink ancestors before creating or mounting material.
    let current = root;
    for (const part of path.slice(root.length + 1).split("/")) {
      current = join(current, part);
      await mkdir(current).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      });
      if ((await lstat(current)).isSymbolicLink() || !(await lstat(current)).isDirectory())
        throw new Error("Session material must use real directories");
    }
  }
  initializeMailbox(directory);
  const contextFile = join(contextDirectory, `${input.key.sessionId}.json`);
  const context = runnerContext({
    ...input,
    configurationVersion: input.configurationVersion ?? 1,
  });
  await writeFile(contextFile, context, { mode: 0o444, flag: "wx" }).catch(async (error) => {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (
      (await lstat(contextFile)).isSymbolicLink() ||
      ((await readFile(contextFile, "utf8")) !== context && !input.retainExistingContext)
    )
      throw new Error(
        "Immutable runner context differs; stop the session and replace its context explicitly",
      );
  });
  return { root, key: input.key, folder: input.folder, directory, workspace, contextFile };
}

/** Replace a stopped session's immutable context while preserving its Run ledger and references. */
export function replaceSessionContext(
  contextFile: string,
  input: {
    model: ModelConfiguration;
    instructions?: string;
    resources?: AgentResources;
    web?: WebConfiguration;
    configurationVersion: number;
  },
): void {
  const info = lstatSync(contextFile);
  if (info.isSymbolicLink() || !info.isFile())
    throw new Error(
      "Immutable runner context differs; stop the session and replace its context explicitly",
    );
  const existing = JSON.parse(readFileSync(contextFile, "utf8")) as { runContext?: RunContext };
  const next = runnerContext({ ...input, runContext: existing.runContext });
  if (readFileSync(contextFile, "utf8") === next) return;
  rmSync(contextFile);
  writeFileSync(contextFile, next, { mode: 0o444, flag: "wx" });
}
