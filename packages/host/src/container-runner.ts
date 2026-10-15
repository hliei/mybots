import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { AgentResources, SessionKey, WebConfiguration } from "@mybots/mailbox";
import { resolveWebTools, validateAgentResources, validateWebConfiguration } from "@mybots/mailbox";
import { initializeMailbox } from "@mybots/mailbox/node";
import type { ModelConfiguration, SessionMaterial } from "./drivers/types.ts";

function legalName(value: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value);
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
  const resources = validateAgentResources(input.resources);
  const web = resolveWebTools(resources, validateWebConfiguration(input.web));
  const contextFile = join(contextDirectory, `${input.key.sessionId}.json`);
  const context = `${JSON.stringify({
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
  })}\n`;
  await writeFile(contextFile, context, { mode: 0o444, flag: "wx" }).catch(async (error) => {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (
      (await lstat(contextFile)).isSymbolicLink() ||
      (await readFile(contextFile, "utf8")) !== context
    )
      throw new Error(
        "Immutable runner context differs; stop the session and replace its context explicitly",
      );
  });
  return { root, key: input.key, folder: input.folder, directory, workspace, contextFile };
}
