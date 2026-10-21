import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunnerMailbox } from "@mybots/mailbox/node";
import { afterEach, expect, it, vi } from "vitest";
import { PiProvider } from "../packages/agent-runner/src/providers/pi.ts";
import { WebSocketChannel } from "../packages/host/src/channels/websocket.ts";
import { loadHostSettings } from "../packages/host/src/config/host.ts";
import type { SessionDriver } from "../packages/host/src/drivers/types.ts";
import type { HostConfiguration } from "../packages/host/src/host.ts";
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

async function start(
  files?: HostConfiguration["files"],
  execution: SessionDriver = new MailboxDriver(),
) {
  root = await mkdtemp(join(tmpdir(), "mybots-transfer-"));
  const loaded = await loadHostSettings("examples/host/host.json");
  const configuration = { ...loaded.configuration, ...(files ? { files } : {}) };
  host = await Host.start({ root, configuration, driver: execution });
  channel = await WebSocketChannel.listen({ root, host, configuration, port: 0 });
  base = `http://127.0.0.1:${channel.address.port}`;
  headers = {
    Authorization: `Bearer ${(await readFile(join(root, "data", "client-credential"), "utf8")).trim()}`,
    "Content-Type": "application/json",
  };
  return configuration;
}

function post(path: string, body: unknown) {
  return fetch(`${base}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
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

async function writer() {
  const created = await (
    await post("/api/bots", {
      requestId: "writer-bot",
      name: "Writer",
      instructions: "Write only the supplied text.",
      model: { provider: "deepseek", id: "deepseek-chat" },
      tools: ["read", "bash"],
    })
  ).json();
  return created.bot.id as string;
}

async function upload(taskId: string, filename: string, bytes: Buffer) {
  const response = await fetch(`${base}/api/bots/personal/tasks/${taskId}/attachments`, {
    method: "POST",
    headers: { ...headers, "X-Filename": filename },
    body: new Uint8Array(bytes),
  });
  expect(response.status).toBe(201);
  return response.json() as Promise<{ id: string; filename: string; bytes: number }>;
}

async function download(path: string) {
  const response = await fetch(`${base}${path}`, { headers });
  expect(response.status).toBe(200);
  return Buffer.from(await response.arrayBuffer());
}

it("copies selected attachments and artifacts onto the receiving Task only", async () => {
  const execution = new MailboxDriver();
  execution.respond = async (input, _material, signal) => {
    if (input.content === "Transfer the note" || input.content === "Use the copied note") {
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
    }
    return `Reply: ${input.content}`;
  };
  const configuration = await start(undefined, execution);
  const targetId = await writer();
  expect(
    (
      await post(`/api/bots/personal/collaboration/${targetId}`, {
        requestId: "allow",
        mode: "allow",
      })
    ).status,
  ).toBe(201);
  const sent = await (
    await post("/api/bots/personal/thread/messages", {
      requestId: "source",
      text: "Transfer the note",
    })
  ).json();
  await vi.waitFor(() => expect(execution.launches).toHaveLength(1));
  const note = Buffer.from("note-v1");
  const created = await upload(sent.taskId, "note.txt", note);
  const saved = await post(
    `/api/bots/personal/tasks/${sent.taskId}/attachments/${created.id}/workspace`,
    { path: "shared/note.txt" },
  );
  expect(saved.status).toBe(201);
  expect(await get(`/api/bots/${targetId}/workspace/files`)).toEqual({ files: [] });
  const other = await (
    await post("/api/bots/personal/thread/tasks", { requestId: "other-source", text: "Other task" })
  ).json();
  const hidden = await upload(other.taskId, "hidden.txt", Buffer.from("hidden"));
  const workspace = join(root, "groups", "personal", "reports");
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "report.md"), "report-v1");
  const mailbox = new RunnerMailbox(execution.launches[0]?.material.directory as string);
  const published = await ask(mailbox, "report", "publish_result", {
    requestId: "report",
    text: "Selected report",
    files: ["reports/report.md"],
  });
  const artifactId = (published.result?.artifacts as { id: string }[] | undefined)?.[0]
    ?.id as string;
  await writeFile(join(workspace, "report.md"), "report-replaced");
  const delegated = await ask(mailbox, "copy-files", "delegate", {
    requestId: "copy-files",
    targetBotId: targetId,
    text: "Use the copied note",
    files: [
      { kind: "attachment", id: created.id },
      { kind: "artifact", id: artifactId },
    ],
  });
  expect(delegated.error).toBeUndefined();
  const childTaskId = delegated.result?.childTaskId as string;
  const childRunId = delegated.result?.childRunId as string;
  expect(delegated.result).toMatchObject({
    sourceBotId: "personal",
    targetBotId: targetId,
    parentTaskId: sent.taskId,
    parentRunId: sent.runId,
    originatingRunId: sent.runId,
    files: [
      { kind: "attachment", id: created.id, filename: "note.txt", bytes: note.length },
      { kind: "artifact", id: artifactId, filename: "report.md", bytes: 9 },
    ],
  });
  await vi.waitFor(() => expect(execution.launches.length).toBeGreaterThan(1));
  const childLaunch = execution.launches.find((launch) =>
    launch.material.taskAttachments?.endsWith(childTaskId),
  );
  expect(childLaunch?.material.workspace.endsWith(join("groups", targetId))).toBe(true);
  expect(
    childLaunch?.material.taskAttachments?.endsWith(
      join("data", "task-attachments", targetId, childTaskId),
    ),
  ).toBe(true);
  expect(childLaunch?.material.taskAttachments).not.toContain(`${join("personal", sent.taskId)}`);
  const listed = await get(`/api/bots/${targetId}/tasks/${childTaskId}/attachments`);
  expect(listed.attachments).toEqual([
    expect.objectContaining({
      filename: "note.txt",
      bytes: note.length,
      runId: childRunId,
      source: {
        delegationId: "copy-files",
        botId: "personal",
        taskId: sent.taskId,
        runId: sent.runId,
        kind: "attachment",
        fileId: created.id,
      },
    }),
    expect.objectContaining({
      filename: "report.md",
      bytes: 9,
      source: expect.objectContaining({ kind: "artifact", fileId: artifactId, runId: sent.runId }),
    }),
  ]);
  const noteCopy = listed.attachments[0].id as string;
  const reportCopy = listed.attachments[1].id as string;
  expect(
    await download(`/api/bots/${targetId}/tasks/${childTaskId}/attachments/${noteCopy}`),
  ).toEqual(note);
  expect(
    await download(`/api/bots/${targetId}/tasks/${childTaskId}/attachments/${reportCopy}`),
  ).toEqual(Buffer.from("report-v1"));
  expect(await get(`/api/bots/${targetId}/workspace/files`)).toEqual({ files: [] });
  const separate = await (
    await post(`/api/bots/${targetId}/thread/tasks`, { requestId: "separate", text: "Separate" })
  ).json();
  expect(await get(`/api/bots/${targetId}/tasks/${separate.taskId}/attachments`)).toMatchObject({
    attachments: [],
  });
  expect(
    (
      await ask(mailbox, "wrong-task", "delegate", {
        requestId: "wrong-task",
        targetBotId: targetId,
        text: "Use the copied note",
        files: [{ kind: "attachment", id: hidden.id }],
      })
    ).error,
  ).toBe("Attachment not found.");
  await writeFile(
    join(root, "data", "task-attachments", "personal", sent.taskId, "note.txt"),
    "note-replaced",
  );
  expect(
    await download(`/api/bots/${targetId}/tasks/${childTaskId}/attachments/${noteCopy}`),
  ).toEqual(note);
  const childMailbox = new RunnerMailbox(childLaunch?.material.directory as string);
  await mkdir(join(root, "groups", targetId), { recursive: true });
  await writeFile(join(root, "groups", targetId, "returned.txt"), "returned-v1");
  const returned = await ask(childMailbox, "returned", "publish_result", {
    requestId: "returned",
    text: "Returned the note",
    files: ["returned.txt"],
  });
  expect(returned.result).toMatchObject({
    botId: targetId,
    taskId: childTaskId,
    runId: childRunId,
    delegationId: "copy-files",
    originatingRunId: sent.runId,
  });
  const returnedArtifact = (returned.result?.artifacts as { id: string }[] | undefined)?.[0]
    ?.id as string;
  await writeFile(join(root, "groups", targetId, "returned.txt"), "returned-replaced");
  const artifactPath = `/api/bots/${targetId}/runs/${childRunId}/artifacts/${returnedArtifact}`;
  expect(await download(artifactPath)).toEqual(Buffer.from("returned-v1"));
  expect(
    (await post(`/api/bots/personal/runs/${sent.runId}/stop`, { requestId: "stop-source" })).status,
  ).toBe(202);
  await vi.waitFor(async () =>
    expect((await get("/api/bots/personal/thread")).tasks[0].runs[0].state).toBe("closed"),
  );
  expect(
    await download(`/api/bots/${targetId}/tasks/${childTaskId}/attachments/${noteCopy}`),
  ).toEqual(note);
  expect(await download(artifactPath)).toEqual(Buffer.from("returned-v1"));
  await channel.close();
  await host.stop();
  host = await Host.start({ root, configuration, driver: new MailboxDriver() });
  channel = await WebSocketChannel.listen({ root, host, configuration, port: 0 });
  base = `http://127.0.0.1:${channel.address.port}`;
  headers = {
    Authorization: `Bearer ${(await readFile(join(root, "data", "client-credential"), "utf8")).trim()}`,
    "Content-Type": "application/json",
  };
  expect(
    await download(`/api/bots/${targetId}/tasks/${childTaskId}/attachments/${noteCopy}`),
  ).toEqual(note);
  expect(await download(artifactPath)).toEqual(Buffer.from("returned-v1"));
  expect(JSON.stringify(await get(`/api/bots/${targetId}/thread`))).not.toContain(root);
});

it("rejects out-of-scope selections and copies only after exact approval", async () => {
  const execution = new MailboxDriver();
  execution.respond = async (input, _material, signal) => {
    if (input.content === "Needs approval") {
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
    }
    return `Reply: ${input.content}`;
  };
  await start({ maxBytes: 8 }, execution);
  const targetId = await writer();
  const sent = await (
    await post("/api/bots/personal/thread/messages", {
      requestId: "source",
      text: "Needs approval",
    })
  ).json();
  await vi.waitFor(() => expect(execution.launches).toHaveLength(1));
  const mailbox = new RunnerMailbox(execution.launches[0]?.material.directory as string);
  const first = await upload(sent.taskId, "one.txt", Buffer.from("1234"));
  const second = await upload(sent.taskId, "two.txt", Buffer.from("5678"));
  const third = await upload(sent.taskId, "three.txt", Buffer.from("abcd"));
  await writeFile(
    join(root, "data", "task-attachments", "personal", sent.taskId, "one.txt"),
    Buffer.from("123456789"),
  );
  expect(
    (
      await ask(mailbox, "too-big", "delegate", {
        requestId: "too-big",
        targetBotId: targetId,
        text: "Too big",
        files: [{ kind: "attachment", id: first.id }],
      })
    ).error,
  ).toMatch(/file limit/i);
  expect((await get(`/api/bots/${targetId}/thread`)).tasks).toEqual([]);
  expect(
    (
      await ask(mailbox, "too-many", "delegate", {
        requestId: "too-many",
        targetBotId: targetId,
        text: "Too many",
        files: Array.from({ length: 17 }, (_item, index) => ({
          kind: "attachment",
          id: `file-${index}`,
        })),
      })
    ).error,
  ).toBe("A delegation accepts at most 16 selected files.");
  expect(
    (
      await ask(mailbox, "workspace-path", "delegate", {
        requestId: "workspace-path",
        targetBotId: targetId,
        text: "Workspace path",
        files: ["shared/one.txt"],
      })
    ).error,
  ).toBe("Selected files must identify a Task attachment or delivered artifact.");
  await post(`/api/bots/personal/collaboration/${targetId}`, { requestId: "deny", mode: "deny" });
  const denied = await ask(mailbox, "denied-one", "delegate", {
    requestId: "denied-one",
    targetBotId: targetId,
    text: "Same text",
    files: [{ kind: "attachment", id: second.id }],
  });
  const deniedOther = await ask(mailbox, "denied-two", "delegate", {
    requestId: "denied-two",
    targetBotId: targetId,
    text: "Same text",
    files: [{ kind: "attachment", id: third.id }],
  });
  expect(denied.result?.id).toBe("denied-one");
  expect(deniedOther.result?.id).not.toBe("denied-one");
  expect((await get(`/api/bots/${targetId}/thread`)).tasks).toEqual([]);
  expect(
    (
      await post(`/api/bots/personal/collaboration/${targetId}`, {
        requestId: "ask",
        mode: "ask-each-time",
      })
    ).status,
  ).toBe(201);
  const changed = await ask(mailbox, "ask-changed", "delegate", {
    requestId: "ask-changed",
    targetBotId: targetId,
    text: "Copy the original bytes",
    files: [{ kind: "attachment", id: third.id }],
  });
  expect(changed.result).toMatchObject({
    state: "pending",
    files: [{ kind: "attachment", id: third.id, filename: "three.txt", bytes: 4 }],
  });
  await writeFile(
    join(root, "data", "task-attachments", "personal", sent.taskId, "three.txt"),
    Buffer.from("wxyz"),
  );
  expect(
    (
      await post(`/api/bots/personal/runs/${sent.runId}/approvals/ask-changed/decision`, {
        requestId: "approve-changed",
        decision: "approve",
        operation: "delegate",
        targetBotId: targetId,
        text: "Copy the original bytes",
        deadline: null,
        files: changed.result?.files,
      })
    ).status,
  ).toBe(202);
  await host.reconcile();
  await vi.waitFor(async () =>
    expect(
      (await get("/api/bots/personal/thread")).tasks[0].runs[0].delegations.find(
        (row: { id: string; approval: { state: string } }) => row.id === "ask-changed",
      ).approval.state,
    ).toBe("stale"),
  );
  expect((await get(`/api/bots/${targetId}/thread`)).tasks).toEqual([]);
  const proposal = await ask(mailbox, "ask-copy", "delegate", {
    requestId: "ask-copy",
    targetBotId: targetId,
    text: "Copy after approval",
    files: [{ kind: "attachment", id: second.id }],
  });
  expect(proposal.result).toMatchObject({
    state: "pending",
    childTaskId: null,
    files: [{ kind: "attachment", id: second.id, filename: "two.txt", bytes: 4 }],
  });
  expect((await get(`/api/bots/${targetId}/thread`)).tasks).toEqual([]);
  const current = proposal.result?.files;
  expect(
    (
      await post(`/api/bots/personal/runs/${sent.runId}/approvals/ask-copy/decision`, {
        requestId: "approve-wrong",
        decision: "approve",
        operation: "delegate",
        targetBotId: targetId,
        text: "Copy after approval",
        deadline: null,
        files: [],
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await post(`/api/bots/personal/runs/${sent.runId}/approvals/ask-copy/decision`, {
        requestId: "approve-right",
        decision: "approve",
        operation: "delegate",
        targetBotId: targetId,
        text: "Copy after approval",
        deadline: null,
        files: current,
      })
    ).status,
  ).toBe(202);
  mailbox.requestDurableWait("delegation");
  await vi.waitFor(async () =>
    expect((await get("/api/bots/personal/thread")).tasks[0].runs[0].state).toBe("waiting"),
  );
  await host.reconcile();
  await vi.waitFor(async () =>
    expect((await get(`/api/bots/${targetId}/thread`)).tasks).toHaveLength(1),
  );
  const childTaskId = (await get(`/api/bots/${targetId}/thread`)).tasks[0].id as string;
  const copies = await get(`/api/bots/${targetId}/tasks/${childTaskId}/attachments`);
  expect(copies.attachments).toEqual([
    expect.objectContaining({
      filename: "two.txt",
      bytes: 4,
      source: expect.objectContaining({
        delegationId: "ask-copy",
        kind: "attachment",
        fileId: second.id,
        botId: "personal",
        taskId: sent.taskId,
        runId: sent.runId,
      }),
    }),
  ]);
  expect(
    await download(
      `/api/bots/${targetId}/tasks/${childTaskId}/attachments/${copies.attachments[0].id}`,
    ),
  ).toEqual(Buffer.from("5678"));
});

it("records a real SDK file selection without exposing the source bytes in the child prompt", async () => {
  const secret = "secret-bytes-not-in-prompt";
  let attachmentId = "";
  const uploaded = Promise.withResolvers<void>();
  let childSteps = 0;
  const service = await startPiService(async (request) => {
    const body = JSON.stringify(request);
    if (body.includes("Transfer secret") && !body.includes("Delegated work")) {
      await uploaded.promise;
      const targetBotId = body.match(/ag-[0-9a-f-]+/)?.[0];
      return {
        tool: "delegate",
        arguments: {
          requestId: "sdk-copy",
          targetBotId,
          text: "Use the copied note",
          files: [{ kind: "attachment", id: attachmentId }],
        },
      };
    }
    if (body.includes("Use the copied note") && !body.includes("Delegated work")) {
      childSteps += 1;
      if (childSteps === 1)
        return {
          tool: "publish_result",
          arguments: {
            requestId: "sdk-result",
            text: "Returned the note",
            files: ["returned.txt"],
          },
        };
      return { text: "Child done" };
    }
    return { text: "done" };
  });
  try {
    await start(
      undefined,
      piRunDriver(new PiProvider({ modelRuntime: service.runtime, model: service.model })),
    );
    const targetId = await writer();
    await post(`/api/bots/personal/collaboration/${targetId}`, {
      requestId: "sdk-allow",
      mode: "allow",
    });
    const sent = await (
      await post("/api/bots/personal/thread/messages", {
        requestId: "sdk-source",
        text: `Transfer secret to ${targetId}`,
      })
    ).json();
    await service.waitForRequest(1);
    const created = await upload(sent.taskId, "secret.txt", Buffer.from(secret));
    attachmentId = created.id;
    await mkdir(join(root, "groups", targetId), { recursive: true });
    await writeFile(join(root, "groups", targetId, "returned.txt"), "returned-v1");
    uploaded.resolve();
    await vi.waitFor(async () =>
      expect((await get(`/api/bots/${targetId}/thread`)).tasks).toHaveLength(1),
    );
    const child = (await get(`/api/bots/${targetId}/thread`)).tasks[0];
    const copies = await get(`/api/bots/${targetId}/tasks/${child.id}/attachments`);
    expect(
      await download(
        `/api/bots/${targetId}/tasks/${child.id}/attachments/${copies.attachments[0].id}`,
      ),
    ).toEqual(Buffer.from(secret));
    await vi.waitFor(
      async () => {
        const detail = await get(`/api/bots/${targetId}/thread`);
        expect(detail.tasks[0].runs[0].selectedResults).toEqual([
          expect.objectContaining({
            botId: targetId,
            taskId: child.id,
            delegationId: "sdk-copy",
            originatingRunId: sent.runId,
          }),
        ]);
      },
      { timeout: 15000 },
    );
    const childRequest = service.requests.find((request) =>
      JSON.stringify(request).includes("Use the copied note"),
    );
    expect(JSON.stringify(childRequest)).not.toContain(secret);
    await writeFile(join(root, "groups", targetId, "returned.txt"), "returned-replaced");
    const artifactId = (await get(`/api/bots/${targetId}/thread`)).tasks[0].runs[0]
      .selectedResults[0].artifacts[0].id as string;
    expect(
      await download(`/api/bots/${targetId}/runs/${child.runs[0].id}/artifacts/${artifactId}`),
    ).toEqual(Buffer.from("returned-v1"));
  } finally {
    await service.close();
  }
});
