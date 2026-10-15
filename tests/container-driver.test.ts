import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { provisionSession } from "../src/container-runner.ts";
import { DockerDriver } from "../src/drivers/docker-driver.ts";

test("an unavailable gateway fails before any session runtime is launched", async () => {
  const root = await mkdtemp(join(tmpdir(), "mybots-driver-"));
  try {
    const material = await provisionSession({
      root,
      key: { agentGroupId: "personal", sessionId: "cli" },
      folder: "personal",
      model: {
        provider: "deepseek",
        id: "deepseek-chat",
        baseUrl: "https://api.deepseek.com",
        contextWindow: 65536,
        maxTokens: 8192,
      },
    });
    const driver = new DockerDriver({
      gateway: {
        ensure: async () => {
          throw new Error("Gateway unavailable");
        },
      },
      image: "mybots-agent",
      network: "session-network",
    });
    await expect(driver.start(material, new AbortController().signal)).rejects.toThrow(
      "Gateway unavailable",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("provisioned immutable context cannot silently accept a different model endpoint", async () => {
  const root = await mkdtemp(join(tmpdir(), "mybots-context-"));
  const input = {
    root,
    key: { agentGroupId: "personal", sessionId: "cli" },
    folder: "personal",
    model: {
      provider: "deepseek",
      id: "deepseek-chat",
      baseUrl: "https://api.deepseek.com",
      contextWindow: 65536,
      maxTokens: 8192,
    },
  };
  try {
    await provisionSession(input);
    await expect(
      provisionSession({ ...input, model: { ...input.model, baseUrl: "https://other.test" } }),
    ).rejects.toThrow("Immutable runner context differs");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("adoption rejects an observation that does not match the session", async () => {
  const root = await mkdtemp(join(tmpdir(), "mybots-driver-adopt-"));
  try {
    const material = await provisionSession({
      root,
      key: { agentGroupId: "personal", sessionId: "cli" },
      folder: "personal",
      model: {
        provider: "deepseek",
        id: "deepseek-chat",
        baseUrl: "https://api.deepseek.com",
        contextWindow: 65536,
        maxTokens: 8192,
      },
    });
    const driver = new DockerDriver({
      gateway: { ensure: async () => ({ env: {}, trustFile: "" }) },
      image: "mybots-agent",
      network: "session-network",
    });
    const signal = new AbortController().signal;
    await expect(
      driver.adopt(
        { key: { agentGroupId: "other", sessionId: "cli" }, ref: "mybots-other-cli-x" },
        material,
        signal,
      ),
    ).rejects.toThrow("does not belong to this session");
    await expect(
      driver.adopt({ key: material.key, ref: "foreign-container" }, material, signal),
    ).rejects.toThrow("does not belong to this session");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
