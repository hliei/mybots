import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect } from "vitest";
import type { ApiServer } from "../apps/api/src/server.ts";
import { startDurableModel } from "./durable-model-fixture.ts";
import { configureFixture, startFixtureApi } from "./provider-fixture.ts";

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
    configureFixture(root);
    api = await startFixtureApi(root, service);
    const credential = (await readFile(join(root, "client-credential"), "utf8")).trim();
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
      async crashWorker() {
        // Select only this fixture's direct worker, never an installation process.
        const { stdout } = await promisify(execFile)("pgrep", [
          "-P",
          String(process.pid),
          "-f",
          root,
        ]);
        const pids = stdout.trim().split(/\s+/).map(Number);
        expect(pids).toHaveLength(1);
        const pid = pids[0] as number;
        process.kill(pid, "SIGKILL");
        await expect
          .poll(
            () => {
              try {
                process.kill(pid, 0);
                return false;
              } catch {
                return true;
              }
            },
            { timeout: 5000 },
          )
          .toBe(true);
      },
      async reopen() {
        const previous = api;
        api = undefined;
        await previous?.close();
        if (!service) throw new Error("Model service closed");
        api = await startFixtureApi(root, service);
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
