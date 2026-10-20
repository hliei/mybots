import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunnerMailbox } from "@mybots/mailbox/node";
import { afterEach, expect, it, vi } from "vitest";
import { PiProvider } from "../packages/agent-runner/src/providers/pi.ts";
import { WebSocketChannel } from "../packages/host/src/channels/websocket.ts";
import { loadHostSettings } from "../packages/host/src/config/host.ts";
import type { SessionDriver } from "../packages/host/src/drivers/types.ts";
import { Host } from "../packages/host/src/host.ts";
import { MailboxDriver } from "./host-fixture.ts";
import { startPiService } from "./pi-fixture.ts";
import { piRunDriver } from "./pi-run-driver.ts";

let root: string;
let host: Host;
let channel: WebSocketChannel;
let base: string;
let headers: Record<string, string>;
afterEach(async () => {
  await channel?.close();
  await host?.stop();
  if (root) await rm(root, { recursive: true, force: true });
});

async function start(driver: SessionDriver = new MailboxDriver(), files?: { maxBytes: number }) {
  root = await mkdtemp(join(tmpdir(), "mybots-artifacts-"));
  const loaded = await loadHostSettings("examples/host/host.json");
  const configuration = files ? { ...loaded.configuration, files } : loaded.configuration;
  host = await Host.start({ root, configuration, driver });
  channel = await WebSocketChannel.listen({ root, host, configuration, port: 0 });
  base = `http://127.0.0.1:${channel.address.port}`;
  headers = {
    Authorization: `Bearer ${(await readFile(join(root, "data", "client-credential"), "utf8")).trim()}`,
  };
  return configuration;
}

function post(path: string, body: unknown) {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function get(path: string) {
  const response = await fetch(`${base}${path}`, { headers });
  expect(response.status).toBe(200);
  return response.json();
}

function ask(mailbox: RunnerMailbox, id: string, operation: string, input: unknown) {
  mailbox.requestHistory({
    id,
    operation,
    input,
    incarnation: mailbox.executionIncarnation(),
  });
  return vi.waitFor(() => {
    const response = mailbox.historyResponse(id);
    expect(response).toBeDefined();
    return response as { result?: Record<string, unknown>; error?: string };
  });
}

async function holdRun(files?: { maxBytes: number }) {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const driver = new MailboxDriver();
  driver.respond = async (_input, _material, signal) => {
    entered.resolve();
    await Promise.race([
      release.promise,
      new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      ),
    ]);
    return "Authoritative reply";
  };
  const configuration = await start(driver, files);
  const sent = await (
    await post("/api/bots/personal/thread/messages", {
      requestId: "artifact-source",
      text: "Write the archive report",
    })
  ).json();
  await entered.promise;
  const mailbox = new RunnerMailbox(driver.launches[0]?.material.directory as string);
  return { configuration, release, sent, mailbox };
}

it("downloads the delivered snapshot after the working file changes and after restart", async () => {
  const { configuration, release, sent, mailbox } = await holdRun();
  const original = Buffer.from("Archive report v1\n");
  const workspace = join(root, "groups", "personal", "reports");
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "report.md"), original);
  const published = await ask(mailbox, "report", "publish_result", {
    requestId: "report",
    text: "The 1962 ledger is in the attached report.",
    files: ["reports/report.md"],
  });
  expect(published.error).toBeUndefined();
  expect(published.result).toMatchObject({
    kind: "result",
    text: "The 1962 ledger is in the attached report.",
    botId: "personal",
    taskId: sent.taskId,
    runId: sent.runId,
    delegationId: null,
    artifacts: [{ name: "reports/report.md", bytes: original.length }],
  });
  const artifactId = (published.result?.artifacts as { id: string }[] | undefined)?.[0]
    ?.id as string;
  expect(JSON.stringify(published.result)).not.toContain(root);
  const downloadPath = `/api/bots/personal/runs/${sent.runId}/artifacts/${artifactId}`;
  const first = await fetch(`${base}${downloadPath}`, { headers });
  expect(first.status).toBe(200);
  expect(first.headers.get("content-type")).toBe("application/octet-stream");
  expect(Buffer.from(await first.arrayBuffer())).toEqual(original);
  await writeFile(join(workspace, "report.md"), "Archive report replaced\n");
  const second = await fetch(`${base}${downloadPath}`, { headers });
  expect(Buffer.from(await second.arrayBuffer())).toEqual(original);
  const detail = await get("/api/bots/personal/thread");
  expect(detail.tasks[0].runs[0].selectedResults).toEqual([
    expect.objectContaining({
      id: "report",
      botId: "personal",
      taskId: sent.taskId,
      runId: sent.runId,
      delegationId: null,
      artifacts: [expect.objectContaining({ id: artifactId, name: "reports/report.md" })],
    }),
  ]);
  expect(JSON.stringify(detail)).not.toContain(root);
  release.resolve();
  await channel.close();
  await host.stop();
  host = await Host.start({ root, configuration, driver: new MailboxDriver() });
  channel = await WebSocketChannel.listen({ root, host, configuration, port: 0 });
  base = `http://127.0.0.1:${channel.address.port}`;
  headers = {
    Authorization: `Bearer ${(await readFile(join(root, "data", "client-credential"), "utf8")).trim()}`,
  };
  const restored = await fetch(`${base}${downloadPath}`, { headers });
  expect(restored.status).toBe(200);
  expect(Buffer.from(await restored.arrayBuffer())).toEqual(original);
});

it("keeps delivery inside the Bot workspace, the file limit, and the owner credential", async () => {
  const { release, sent, mailbox } = await holdRun();
  const workspace = join(root, "groups", "personal");
  await mkdir(join(workspace, "reports"), { recursive: true });
  const original = Buffer.from("scoped report\n");
  await writeFile(join(workspace, "reports", "report.md"), original);
  await symlink(join(root, "data", "client-credential"), join(workspace, "linked-secret"));
  const rejected = async (id: string, files: unknown) =>
    (
      await ask(mailbox, id, "publish_result", {
        requestId: id,
        text: "Rejected selection",
        files,
      })
    ).error;
  expect(await rejected("outside", ["../data/client-credential"])).toMatch(/workspace/i);
  expect(
    await rejected("absolute", [join(root, "groups", "personal", "reports", "report.md")]),
  ).toMatch(/workspace/i);
  expect(await rejected("link", ["linked-secret"])).toMatch(/workspace/i);
  expect(await rejected("attachment-mount", [".task-attachments/secret.txt"])).toMatch(
    /workspace/i,
  );
  expect(await rejected("twice", ["reports/report.md", "reports/report.md"])).toBe(
    "Select each workspace file once.",
  );
  expect(
    await rejected(
      "many",
      Array.from({ length: 17 }, (_, index) => `file-${index}.txt`),
    ),
  ).toBe("A selected result accepts at most 16 workspace files.");
  expect(
    (
      await ask(mailbox, "progress-file", "publish_progress", {
        requestId: "progress-file",
        text: "Still reading",
        files: ["reports/report.md"],
      })
    ).error,
  ).toBe("Unknown history field.");
  await writeFile(join(workspace, "reports", "huge.bin"), Buffer.alloc(25 * 1024 * 1024 + 1));
  expect(await rejected("huge", ["reports/huge.bin"])).toBe("File exceeds the 25 MiB limit.");
  const published = await ask(mailbox, "kept", "publish_result", {
    requestId: "kept",
    text: "Scoped report",
    files: ["reports/report.md"],
  });
  const artifactId = (published.result?.artifacts as { id: string }[] | undefined)?.[0]
    ?.id as string;
  await writeFile(join(workspace, "reports", "report.md"), "changed after delivery\n");
  const replay = await ask(mailbox, "kept", "publish_result", {
    requestId: "kept",
    text: "A different summary",
    files: ["reports/report.md"],
  });
  expect(replay.result?.artifacts).toEqual(published.result?.artifacts);
  expect(replay.result?.text).toBe("Scoped report");
  const download = `/api/bots/personal/runs/${sent.runId}/artifacts/${artifactId}`;
  expect(Buffer.from(await (await fetch(`${base}${download}`, { headers })).arrayBuffer())).toEqual(
    original,
  );
  expect((await fetch(`${base}${download}`)).status).toBe(401);
  expect(
    (await fetch(`${base}/api/bots/other/runs/${sent.runId}/artifacts/${artifactId}`, { headers }))
      .status,
  ).toBe(404);
  expect(
    (await fetch(`${base}/api/bots/personal/runs/other-run/artifacts/${artifactId}`, { headers }))
      .status,
  ).toBe(404);
  const listed = JSON.stringify(await get("/api/bots/personal/thread"));
  expect(listed).not.toContain(root);
  expect(listed).not.toContain("client-credential");
  expect(listed).not.toContain("delivered-artifacts");
  release.resolve();
});

it("uses the installation file limit when it is below 25 MiB", async () => {
  const { release, mailbox } = await holdRun({ maxBytes: 8 });
  const workspace = join(root, "groups", "personal");
  await writeFile(join(workspace, "small.txt"), Buffer.alloc(8, 1));
  await writeFile(join(workspace, "over.txt"), Buffer.alloc(9, 2));
  expect(
    (
      await ask(mailbox, "over-limit", "publish_result", {
        requestId: "over-limit",
        text: "Too large for this installation",
        files: ["over.txt"],
      })
    ).error,
  ).toContain("8");
  const published = await ask(mailbox, "within-limit", "publish_result", {
    requestId: "within-limit",
    text: "Small report",
    files: ["small.txt"],
  });
  expect(published.result?.artifacts).toEqual([
    expect.objectContaining({ name: "small.txt", bytes: 8 }),
  ]);
  release.resolve();
});

it("delivers an Agent-created report through the real SDK without an owner upload", async () => {
  const service = await startPiService((request) => {
    const tools = request.messages.filter((row) => row.role === "tool");
    if (tools.length === 0)
      return {
        tool: "write",
        arguments: { path: "report.txt", content: "Agent report v1\n" },
      };
    if (tools.length === 1)
      return {
        tool: "publish_result",
        arguments: { requestId: "sdk-report", text: "Report ready", files: ["report.txt"] },
      };
    return { text: "Report delivered" };
  });
  try {
    await start(
      piRunDriver(new PiProvider({ modelRuntime: service.runtime, model: service.model })),
    );
    const sent = await (
      await post("/api/bots/personal/thread/messages", {
        requestId: "sdk-artifact-source",
        text: "Write and deliver a report",
      })
    ).json();
    let artifactId = "";
    await vi.waitFor(async () => {
      const run = (await get("/api/bots/personal/thread")).tasks[0].runs[0];
      expect(run.outcome?.reply).toBe("Report delivered");
      expect(run.selectedResults[0]?.artifacts).toEqual([
        expect.objectContaining({ name: "report.txt", bytes: 16 }),
      ]);
      artifactId = run.selectedResults[0].artifacts[0].id;
    });
    await writeFile(join(root, "groups", "personal", "report.txt"), "Working revision");
    const downloaded = await fetch(
      `${base}/api/bots/personal/runs/${sent.runId}/artifacts/${artifactId}`,
      { headers },
    );
    expect(downloaded.status).toBe(200);
    expect(await downloaded.text()).toBe("Agent report v1\n");
  } finally {
    await channel?.close();
    await host?.stop();
    await service.close();
  }
});
