import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { resolveWebTools, validateAgentResources, validateWebConfiguration } from "@mybots/mailbox";
import { expect, test } from "vitest";
import { validateHostConfiguration } from "../packages/host/src/config/host.ts";
import { HostStore } from "../packages/host/src/db/index.ts";
import { schema } from "../packages/host/src/db/migrations/001-initial.ts";
import { resourceSchema } from "../packages/host/src/db/migrations/002-agent-resources.ts";
import { deliveryAttemptSchema } from "../packages/host/src/db/migrations/003-delivery-attempts.ts";
import { recoverySchema } from "../packages/host/src/db/migrations/004-session-recovery.ts";

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

test.each([2, 3, 4])(
  "web configuration upgrades schema %s without losing operational state",
  async (version) => {
    const root = await mkdtemp(join(tmpdir(), "mybots-web-upgrade-"));
    const file = join(root, "host.db");
    try {
      const previous = new DatabaseSync(file);
      previous.exec(schema);
      previous.exec(resourceSchema);
      if (version >= 3) {
        previous.exec(deliveryAttemptSchema);
        previous.exec(
          "INSERT INTO delivery_attempts (message_id, session_id, attempts) VALUES ('saved-reply', 'saved-session', 2)",
        );
      }
      if (version === 4) {
        previous.exec(recoverySchema);
        previous.exec(
          "INSERT INTO host_instances VALUES ('previous-host', 123, 'start', 'beat', 'stop')",
        );
      }
      previous.close();
      const configuration = validateHostConfiguration({
        ...hostBase,
        agent: { ...hostBase.agent, resources: { tools: ["fetch_content"] }, web: { fetch: true } },
      });
      const store = new HostStore(file, configuration);
      try {
        expect(store.ownerDestination("terminal", "cli:local")).toBe(hostBase.agent.id);
        if (version >= 3) expect(store.deliveryAttempt("saved-reply")?.attempts).toBe(2);
      } finally {
        store.close();
      }
      const upgraded = new DatabaseSync(file);
      try {
        expect(upgraded.prepare("PRAGMA user_version").get()?.user_version).toBe(9);
        if (version === 4)
          expect(upgraded.prepare("SELECT instance_id FROM host_instances").all()).toEqual([
            { instance_id: "previous-host" },
          ]);
      } finally {
        upgraded.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

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
