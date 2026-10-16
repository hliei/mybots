import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { loadHostSettings } from "../packages/host/src/config/host.ts";
import { applyOperatorEnvironment } from "../packages/host/src/config/operator-env.ts";
import { runHost } from "../packages/host/src/index.ts";
import { OPERATOR_ENV_KEYS } from "../setup/env.ts";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const roots: string[] = [];

beforeEach(() => {
  for (const key of OPERATOR_ENV_KEYS) vi.stubEnv(key, undefined);
  vi.stubGlobal("fetch", () => {
    throw new Error("Unexpected network request");
  });
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function hostFile(): Promise<{ root: string; file: string }> {
  const root = await mkdtemp(join(tmpdir(), "mybots-operator-"));
  roots.push(root);
  const settings = JSON.parse(readFileSync(join(projectRoot, "examples/host/host.json"), "utf8"));
  settings.websocket.port = 0;
  const file = join(root, "host.json");
  await writeFile(file, JSON.stringify(settings));
  return { root, file };
}

it("overlays model and gateway values from the operator env without keeping the management key", async () => {
  const { file } = await hostFile();
  const settings = await loadHostSettings(file);
  const prepared = applyOperatorEnvironment(settings, {
    MODEL_ID: "deepseek-reasoner",
    MODEL_BASE_URL: "https://api.deepseek.com/v1",
    ONECLI_URL: "http://127.0.0.1:10254",
    ONECLI_API_KEY: "oc_test_key",
    CONTAINER_NETWORK: "mybots-isolated",
  });
  expect(prepared.settings.configuration.agent.model.id).toBe("deepseek-reasoner");
  expect(prepared.settings.configuration.agent.model.baseUrl).toBe("https://api.deepseek.com/v1");
  expect(prepared.settings.gateway.url).toBe("http://127.0.0.1:10254/");
  expect(prepared.credentials.apiKey).toBe("oc_test_key");
  expect(JSON.stringify(prepared.settings)).not.toContain("oc_test_key");
});

it("refuses to start when egress lockdown is turned off", async () => {
  const { root, file } = await hostFile();
  await writeFile(join(root, ".env"), "EGRESS_LOCKDOWN=false\n", { mode: 0o600 });
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await expect(runHost(["--root", root, "--config", file])).resolves.toBe(1);
    expect(error.mock.calls.flat().join("\n")).toContain("EGRESS_LOCKDOWN cannot be disabled");
  } finally {
    error.mockRestore();
  }
});

it("refuses a Docker network that is not internal", async () => {
  const { root, file } = await hostFile();
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await expect(
      runHost(["--root", root, "--config", file], { inspectNetwork: async () => "open" }),
    ).resolves.toBe(1);
    expect(error.mock.calls.flat().join("\n")).toContain("must exist and be internal");
  } finally {
    error.mockRestore();
  }
});

it("fails startup when Telegram is enabled and TELEGRAM_BOT_TOKEN is missing", async () => {
  const { root, file } = await hostFile();
  const settings = JSON.parse(
    await import("node:fs/promises").then((fs) => fs.readFile(file, "utf8")),
  );
  settings.telegram = { instance: "telegram" };
  await writeFile(file, JSON.stringify(settings));
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await expect(
      runHost(["--root", root, "--config", file], {
        inspectNetwork: async () => "internal",
        createTelegramApi: () => {
          throw new Error("Unexpected Bot API initialization");
        },
      }),
    ).resolves.toBe(1);
    expect(error.mock.calls.flat().join("\n")).toContain("TELEGRAM_BOT_TOKEN");
  } finally {
    error.mockRestore();
  }
});
