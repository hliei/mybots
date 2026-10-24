import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import { type ApiServer, startApi } from "../apps/api/src/server.ts";
import { startDurableModel } from "./durable-model-fixture.ts";

export async function apiFixture(
  respond: Parameters<typeof startDurableModel>[0] = () => ({ text: "Persistent answer" }),
  options?: Parameters<typeof startDurableModel>[1],
) {
  const root = await mkdtemp(join(tmpdir(), "mybots-durable-api-"));
  let service: Awaited<ReturnType<typeof startDurableModel>> | undefined;
  let api: ApiServer | undefined;
  async function close(): Promise<void> {
    try {
      await api?.close();
    } finally {
      try {
        await service?.close();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  }
  try {
    service = await startDurableModel(respond, options);
    await writeFile(join(root, "models.json"), JSON.stringify([service.config]), { mode: 0o600 });
    api = await startApi(root);
    const credential = (await readFile(join(root, "data", "client-credential"), "utf8")).trim();
    const request = async (path: string, body?: unknown, method = body ? "POST" : "GET") => {
      if (!api) throw new Error("API is closed");
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
        if (!api) throw new Error("API is closed");
        return api.url;
      },
      async reopen() {
        const previous = api;
        api = undefined;
        await previous?.close();
        api = await startApi(root);
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
