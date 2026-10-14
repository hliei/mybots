import { readFile } from "node:fs/promises";
import type { HostConfiguration } from "../host.ts";
import { validateAgentResources } from "../mailbox/index.ts";

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid host configuration");
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("Invalid host configuration");
  return value;
}
function name(value: unknown): string {
  const result = text(value);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(result))
    throw new Error("Invalid host path identity");
  return result;
}

export function validateHostConfiguration(value: unknown): HostConfiguration {
  const source = object(value);
  const agent = object(source.agent);
  const model = object(agent.model);
  const endpoint = new URL(text(model.baseUrl));
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  )
    throw new Error("Model endpoint must be HTTPS without credentials");
  if (
    !Number.isSafeInteger(model.contextWindow) ||
    !Number.isSafeInteger(model.maxTokens) ||
    (model.maxTokens as number) <= 0 ||
    (model.contextWindow as number) < (model.maxTokens as number)
  )
    throw new Error("Invalid model limits");
  if (!Array.isArray(source.destinations) || source.destinations.length === 0)
    throw new Error("Configure at least one messaging destination");
  const destinations = source.destinations.map((value) => {
    const destination = object(value);
    return {
      id: name(destination.id),
      channelType: name(destination.channelType),
      platformId: text(destination.platformId),
      instance: name(destination.instance),
    };
  });
  if (
    new Set(destinations.map((destination) => destination.id)).size !== destinations.length ||
    new Set(
      destinations.map((destination) =>
        JSON.stringify([destination.channelType, destination.platformId, destination.instance]),
      ),
    ).size !== destinations.length
  )
    throw new Error("Messaging destinations must be unique");
  const owner = text(source.owner);
  if (!/^[a-zA-Z0-9_-]+:.+$/.test(owner))
    throw new Error("Owner identity must be platform-qualified");
  return {
    owner,
    agent: {
      id: name(agent.id),
      name: text(agent.name),
      folder: name(agent.folder),
      instructions: agent.instructions === undefined ? undefined : text(agent.instructions),
      resources: validateAgentResources(agent.resources),
      model: {
        provider: name(model.provider),
        id: text(model.id),
        baseUrl: endpoint.href,
        contextWindow: model.contextWindow as number,
        maxTokens: model.maxTokens as number,
      },
    },
    destinations,
  };
}

export interface HostSettings {
  configuration: HostConfiguration;
  image: string;
  network: string;
  gateway: { url: string; proxyHost: string };
  cliDestinationId: string;
}

export async function loadHostSettings(file: string): Promise<HostSettings> {
  try {
    const source = object(JSON.parse(await readFile(file, "utf8")));
    const configuration = validateHostConfiguration(source);
    const container = object(source.container);
    const gateway = object(source.gateway);
    const url = new URL(text(gateway.url));
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error();
    const proxyHost = text(gateway.proxyHost);
    if (!/^[a-zA-Z0-9.-]+$/.test(proxyHost)) throw new Error();
    const cliDestinationId = text(source.cliDestinationId);
    const destination = configuration.destinations.find(
      (destination) => destination.id === cliDestinationId,
    );
    if (destination?.channelType !== "cli" || destination.platformId !== "local") throw new Error();
    return {
      configuration,
      image: text(container.image),
      network: name(container.network),
      gateway: { url: url.href, proxyHost },
      cliDestinationId,
    };
  } catch {
    throw new Error(
      "Invalid host configuration; check the host JSON file, model endpoint, CLI destination, container and gateway settings",
    );
  }
}
