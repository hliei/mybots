import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import { startApi } from "../apps/api/src/server.ts";
import { startDurableModel } from "./durable-model-fixture.ts";

export async function apiFixture(
  respond: Parameters<typeof startDurableModel>[0] = () => ({ text: "Persistent answer" }),
) {
  const root = await mkdtemp(join(tmpdir(), "mybots-durable-api-"));
  const service = await startDurableModel(respond);
  await writeFile(join(root, "models.json"), JSON.stringify([service.config]), { mode: 0o600 });
  let api = await startApi(root);
  const credential = (await readFile(join(root, "data", "client-credential"), "utf8")).trim();
  const request = async (path: string, body?: unknown, method = body ? "POST" : "GET") => {
    const response = await fetch(new URL(`api/${path}`, api.url), {
      method,
      headers: { Authorization: `Bearer ${credential}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    expect(response.status).toBeLessThan(300);
    return response.json();
  };
  return {
    root,
    service,
    credential,
    request,
    get url() {
      return api.url;
    },
    async reopen() {
      await api.close();
      api = await startApi(root);
    },
    async close() {
      await api.close();
      await service.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
