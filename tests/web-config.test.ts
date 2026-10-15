import { expect, test } from "vitest";
import { validateHostConfiguration } from "../src/config/host.ts";
import {
  resolveWebTools,
  validateAgentResources,
  validateWebConfiguration,
} from "../src/mailbox/index.ts";

test("Agent resource selection includes the configured web tool names", () => {
  expect(validateAgentResources({ tools: ["read", "web_search", "fetch_content"] })).toEqual({
    tools: ["read", "web_search", "fetch_content"],
  });
  expect(() => validateAgentResources({ tools: ["websearch"] })).toThrow(
    "Invalid Agent tool selection",
  );
});

test("web configuration requires an explicit provider and endpoint", () => {
  expect(
    validateWebConfiguration({
      search: { provider: "brave", endpoint: "https://api.search.brave.test/res/v1/web/search" },
      fetch: true,
    }),
  ).toEqual({
    search: { provider: "brave", endpoint: "https://api.search.brave.test/res/v1/web/search" },
    fetch: true,
  });
  expect(validateWebConfiguration({ fetch: true })).toEqual({ fetch: true });
  expect(validateWebConfiguration(undefined)).toBeUndefined();
});

test("web configuration rejects provider discovery, credentials and unsafe endpoints", () => {
  for (const value of [
    { search: { provider: "auto", endpoint: "https://example.test/search" } },
    { search: { provider: "brave" } },
    { search: { provider: "brave", endpoint: "ftp://example.test/search" } },
    { search: { provider: "brave", endpoint: "https://user:pass@example.test/search" } },
    { search: { provider: "brave", endpoint: "https://example.test/search?key=1" } },
    { search: { provider: "brave", endpoint: "https://example.test/search#top" } },
    { search: { provider: "brave", endpoint: "not-a-url" } },
    { fetch: "yes" },
    { search: { provider: "brave", endpoint: "https://example.test/search" }, extra: 1 },
  ])
    expect(() => validateWebConfiguration(value)).toThrow("Invalid web configuration");
});

test("selected web tools require matching configuration", () => {
  expect(
    resolveWebTools(
      { tools: ["web_search"] },
      { search: { provider: "serpapi", endpoint: "https://serpapi.test/search.json" } },
    ),
  ).toEqual({ search: { provider: "serpapi", endpoint: "https://serpapi.test/search.json" } });
  expect(resolveWebTools({ tools: ["read"] }, undefined)).toBeUndefined();
  expect(resolveWebTools(undefined, { fetch: true })).toEqual({ fetch: true });
  expect(() => resolveWebTools({ tools: ["web_search"] }, undefined)).toThrow(
    "Web search requires a configured provider and endpoint",
  );
  expect(() =>
    resolveWebTools(
      { tools: ["fetch_content"] },
      { search: { provider: "brave", endpoint: "https://example.test/search" } },
    ),
  ).toThrow("Content fetching requires configured web access");
});

const hostBase = {
  owners: ["cli:local"],
  agent: {
    id: "personal",
    name: "Personal",
    folder: "personal",
    model: {
      provider: "deepseek",
      id: "deepseek-chat",
      baseUrl: "https://api.deepseek.com",
      contextWindow: 128000,
      maxTokens: 4096,
    },
  },
  destinations: [{ id: "terminal", channelType: "cli", platformId: "local", instance: "cli" }],
};

test("the host configuration accepts explicit web tool selection and configuration", () => {
  const configuration = validateHostConfiguration({
    ...hostBase,
    agent: {
      ...hostBase.agent,
      resources: { tools: ["read", "web_search", "fetch_content"] },
      web: {
        search: { provider: "brave", endpoint: "https://api.search.brave.test/res/v1/web/search" },
        fetch: true,
      },
    },
  });
  expect(configuration.agent.web).toEqual({
    search: { provider: "brave", endpoint: "https://api.search.brave.test/res/v1/web/search" },
    fetch: true,
  });
  expect(configuration.agent.resources).toEqual({
    tools: ["read", "web_search", "fetch_content"],
  });
});

test("the host configuration rejects selected web tools without matching configuration", () => {
  expect(() =>
    validateHostConfiguration({
      ...hostBase,
      agent: { ...hostBase.agent, resources: { tools: ["web_search"] } },
    }),
  ).toThrow("Web search requires a configured provider and endpoint");
  expect(() =>
    validateHostConfiguration({
      ...hostBase,
      agent: {
        ...hostBase.agent,
        resources: { tools: ["fetch_content"] },
        web: { search: { provider: "brave", endpoint: "https://example.test/search" } },
      },
    }),
  ).toThrow("Content fetching requires configured web access");
});
