import type { WebConfiguration } from "@mybots/mailbox";
import type { HostConfiguration } from "../host.ts";
import type { HostSettings } from "./host.ts";

export interface OperatorCredentials {
  apiKey?: string;
  projectId?: string;
  telegramToken?: string;
}

export interface PreparedHost {
  settings: HostSettings;
  credentials: OperatorCredentials;
}

/** Overlay operator env values onto host settings. Process values are already preferred by the env reader. */
export function applyOperatorEnvironment(
  settings: HostSettings,
  values: Record<string, string>,
): PreparedHost {
  if (values.EGRESS_LOCKDOWN !== undefined && values.EGRESS_LOCKDOWN !== "true") {
    throw new Error(
      "EGRESS_LOCKDOWN cannot be disabled. Set it to true or leave it unset, then restart the service.",
    );
  }
  const configuration = structuredClone(settings.configuration);
  const model = configuration.agent.model;
  if (values.MODEL_PROVIDER) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/u.test(values.MODEL_PROVIDER))
      throw new Error("Invalid model provider");
    model.provider = values.MODEL_PROVIDER;
  }
  if (values.MODEL_ID) model.id = values.MODEL_ID;
  if (values.MODEL_BASE_URL) model.baseUrl = httpsEndpoint(values.MODEL_BASE_URL);
  if (values.MODEL_CONTEXT_WINDOW)
    model.contextWindow = positiveInteger(values.MODEL_CONTEXT_WINDOW);
  if (values.MODEL_MAX_TOKENS) model.maxTokens = positiveInteger(values.MODEL_MAX_TOKENS);
  if (
    !Number.isSafeInteger(model.contextWindow) ||
    !Number.isSafeInteger(model.maxTokens) ||
    model.maxTokens <= 0 ||
    model.contextWindow < model.maxTokens
  )
    throw new Error("Invalid model limits");
  configuration.agent.web = searchOverlay(configuration.agent.web, values);
  const gatewayUrl = values.ONECLI_URL ? managementUrl(values.ONECLI_URL) : settings.gateway.url;
  const proxyHost = values.GATEWAY_PROXY_HOST ?? settings.gateway.proxyHost;
  if (!/^[a-zA-Z0-9.-]+$/u.test(proxyHost)) throw new Error("Invalid gateway proxy hostname");
  const network = values.CONTAINER_NETWORK ?? settings.network;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/u.test(network))
    throw new Error("Invalid container network name");
  return {
    settings: {
      ...settings,
      configuration,
      image: values.CONTAINER_IMAGE ?? settings.image,
      network,
      gateway: { url: gatewayUrl, proxyHost },
    },
    credentials: {
      ...(values.ONECLI_API_KEY ? { apiKey: values.ONECLI_API_KEY } : {}),
      ...(values.ONECLI_PROJECT_ID ? { projectId: values.ONECLI_PROJECT_ID } : {}),
      ...(values.TELEGRAM_BOT_TOKEN ? { telegramToken: values.TELEGRAM_BOT_TOKEN } : {}),
    },
  };
}

/** Startup view of a Telegram owner recorded in host state. */
export function mergePairedTelegram(
  configuration: HostConfiguration,
  instance: string,
  platformId: string,
): HostConfiguration {
  return {
    ...configuration,
    owners: [
      ...configuration.owners.filter((owner) => !owner.startsWith("telegram:")),
      `telegram:${platformId}`,
    ],
    destinations: [
      ...configuration.destinations.filter((destination) => destination.channelType !== "telegram"),
      { id: "owner-chat", channelType: "telegram", platformId, instance },
    ],
  };
}

function searchOverlay(
  web: WebConfiguration | undefined,
  values: Record<string, string>,
): WebConfiguration | undefined {
  const provider = values.WEB_SEARCH_PROVIDER;
  const endpoint = values.WEB_SEARCH_ENDPOINT;
  if (!provider && !endpoint) return web;
  if (!provider || !endpoint || (provider !== "brave" && provider !== "serpapi")) {
    throw new Error("Web search requires WEB_SEARCH_PROVIDER and WEB_SEARCH_ENDPOINT.");
  }
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error("Invalid web configuration");
  }
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  )
    throw new Error("Invalid web configuration");
  return { ...web, search: { provider, endpoint: parsed.href } };
}

function httpsEndpoint(value: string): string {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error("Model endpoint must be HTTPS without credentials");
  }
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  )
    throw new Error("Model endpoint must be HTTPS without credentials");
  return endpoint.href;
}

function managementUrl(value: string): string {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error("Invalid OneCLI management URL");
  }
  if (
    !["https:", "http:"].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  )
    throw new Error("Invalid OneCLI management URL");
  return endpoint.href;
}

function positiveInteger(value: string): number {
  if (!/^[1-9]\d*$/u.test(value)) throw new Error("Invalid model limits");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error("Invalid model limits");
  return parsed;
}
