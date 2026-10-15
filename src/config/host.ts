import { readFile } from "node:fs/promises";
import type { HostConfiguration } from "../host.ts";
import {
  resolveWebTools,
  validateAgentResources,
  validateWebConfiguration,
} from "../mailbox/index.ts";

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
  if (!Array.isArray(source.owners) || source.owners.length === 0)
    throw new Error("Configure at least one owner identity");
  const owners = source.owners.map((value) => {
    const owner = text(value);
    if (!/^[a-zA-Z0-9_-]+:.+$/.test(owner))
      throw new Error("Owner identity must be platform-qualified");
    return owner;
  });
  if (new Set(owners).size !== owners.length) throw new Error("Owner identities must be unique");
  const resources = validateAgentResources(agent.resources);
  const web = resolveWebTools(resources, validateWebConfiguration(agent.web));
  return {
    owners,
    agent: {
      id: name(agent.id),
      name: text(agent.name),
      folder: name(agent.folder),
      instructions: agent.instructions === undefined ? undefined : text(agent.instructions),
      resources,
      web,
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

export interface TelegramSettings {
  /** Messaging-group instance served by one Telegram polling channel. */
  instance: string;
  /** Host environment variable holding the Bot API token; never persisted or mounted. */
  botTokenEnv: string;
}

export interface HostSettings {
  configuration: HostConfiguration;
  image: string;
  network: string;
  gateway: { url: string; proxyHost: string };
  cliDestinationId: string;
  telegram?: TelegramSettings;
  websocket?: { host: string; port: number; path: string };
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

function websocketSettings(
  value: unknown,
  configuration: HostConfiguration,
): { host: string; port: number; path: string } {
  const section = object(value);
  const host = text(section.host);
  if (!LOOPBACK_HOSTS.has(host)) throw new Error();
  const port = section.port;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error();
  const path = section.path === undefined ? "/ws" : text(section.path);
  if (!path.startsWith("/") || /\s/u.test(path)) throw new Error();
  const destinations = configuration.destinations.filter(
    (destination) => destination.channelType === "websocket",
  );
  if (destinations.length === 0) throw new Error();
  if (new Set(destinations.map((destination) => destination.instance)).size !== 1)
    throw new Error();
  return { host, port, path };
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
    if (configuration.owners.filter((owner) => owner.startsWith("cli:")).length !== 1)
      throw new Error();
    const telegramDestinations = configuration.destinations.filter(
      (destination) => destination.channelType === "telegram",
    );
    let telegram: TelegramSettings | undefined;
    if (source.telegram !== undefined || telegramDestinations.length > 0) {
      const settings = object(source.telegram);
      const instance = name(settings.instance);
      const botTokenEnv = text(settings.botTokenEnv);
      if (!/^[A-Z][A-Z0-9_]*$/.test(botTokenEnv)) throw new Error();
      if (telegramDestinations.length === 0) throw new Error();
      for (const destination of telegramDestinations) {
        if (destination.instance !== instance) throw new Error();
        if (!configuration.owners.includes(`telegram:${destination.platformId}`)) throw new Error();
      }
      telegram = { instance, botTokenEnv };
    }
    return {
      configuration,
      image: text(container.image),
      network: name(container.network),
      gateway: { url: url.href, proxyHost },
      cliDestinationId,
      ...(source.websocket === undefined
        ? {}
        : { websocket: websocketSettings(source.websocket, configuration) }),
      ...(telegram ? { telegram } : {}),
    };
  } catch {
    throw new Error(
      "Invalid host configuration; check the host JSON file, model endpoint, CLI destination, container, gateway and Telegram settings",
    );
  }
}
