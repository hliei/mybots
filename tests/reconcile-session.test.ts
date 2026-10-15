import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostMailbox, initializeMailbox, RunnerMailbox } from "@mybots/mailbox/node";
import { afterEach, expect, it, vi } from "vitest";
import {
  CLAIM_STALL_MS,
  decideStallAction,
  HEARTBEAT_CEILING_MS,
  RECOVERY_WAIT_SECONDS,
  recoverAbandonedClaims,
  recoveryWaitSeconds,
} from "../packages/host/src/reconcile-session.ts";

const directories: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function mailboxPair() {
  const directory = await mkdtemp(join(tmpdir(), "mybots-reconcile-"));
  directories.push(directory);
  initializeMailbox(directory);
  return { host: new HostMailbox(directory), runner: new RunnerMailbox(directory) };
}

it("allows an initial attempt and five recovery retries with doubling waits", () => {
  expect([0, 1, 2, 3, 4].map(recoveryWaitSeconds)).toEqual([5, 10, 20, 40, 80]);
  expect(recoveryWaitSeconds(5)).toBeUndefined();
  expect(recoveryWaitSeconds(6)).toBeUndefined();
});

it("keeps a running container with a fresh heartbeat", () => {
  expect(
    decideStallAction({
      now: 1_000_000,
      heartbeatAtMs: 999_000,
      startedAtMs: 900_000,
      activeTool: null,
      claims: [],
    }),
  ).toEqual({ action: "keep" });
});

it("replaces a container whose heartbeat passed the absolute ceiling", () => {
  expect(
    decideStallAction({
      now: 1_000_000 + HEARTBEAT_CEILING_MS + 1,
      heartbeatAtMs: 1_000_000,
      startedAtMs: 1_000_000,
      activeTool: null,
      claims: [],
    }),
  ).toEqual({
    action: "replace",
    reason: "stalled",
    heartbeatAgeMs: HEARTBEAT_CEILING_MS + 1,
    ceilingMs: HEARTBEAT_CEILING_MS,
  });
});

it("honors a declared tool timeout beyond the default ceiling", () => {
  const declaredTimeoutMs = HEARTBEAT_CEILING_MS * 2;
  expect(
    decideStallAction({
      now: 1_000_000 + HEARTBEAT_CEILING_MS,
      heartbeatAtMs: 1_000_000,
      startedAtMs: 1_000_000,
      activeTool: { name: "bash", declaredTimeoutMs },
      claims: [],
    }),
  ).toEqual({ action: "keep" });
});

it("ages out a container that never wrote a heartbeat from its start time", () => {
  expect(
    decideStallAction({
      now: 1_000_000 + HEARTBEAT_CEILING_MS + 1,
      heartbeatAtMs: 0,
      startedAtMs: 1_000_000,
      activeTool: null,
      claims: [],
    }),
  ).toMatchObject({ action: "replace", reason: "stalled" });
});

it("replaces a container that claimed an input then went silent", () => {
  expect(
    decideStallAction({
      now: 1_000_000 + CLAIM_STALL_MS + 1,
      heartbeatAtMs: 900_000,
      startedAtMs: 900_000,
      activeTool: null,
      claims: [{ messageId: "input", claimedAtMs: 1_000_000 }],
    }),
  ).toEqual({
    action: "replace",
    reason: "claim",
    messageId: "input",
    claimAgeMs: CLAIM_STALL_MS + 1,
    toleranceMs: CLAIM_STALL_MS,
  });
});

it("keeps a container that showed activity after claiming an input", () => {
  expect(
    decideStallAction({
      now: 1_000_000 + CLAIM_STALL_MS + 1,
      heartbeatAtMs: 1_000_000 + CLAIM_STALL_MS,
      startedAtMs: 900_000,
      activeTool: null,
      claims: [{ messageId: "input", claimedAtMs: 1_000_000 }],
    }),
  ).toEqual({ action: "keep" });
});

it("widens claim tolerance while a tool declares a long timeout", () => {
  const declaredTimeoutMs = CLAIM_STALL_MS * 3;
  expect(
    decideStallAction({
      now: 1_000_000 + CLAIM_STALL_MS * 2,
      heartbeatAtMs: 900_000,
      startedAtMs: 900_000,
      activeTool: { name: "bash", declaredTimeoutMs },
      claims: [{ messageId: "input", claimedAtMs: 1_000_000 }],
    }),
  ).toEqual({ action: "keep" });
});

it("reschedules an abandoned claim through five bounded waits then fails it", async () => {
  const { host, runner } = await mailboxPair();
  host.submit({
    id: "work",
    content: "work",
    channel_type: "cli",
    platform_id: "o",
    thread_id: null,
  });
  let now = Date.parse("2026-01-01T00:00:00.000Z");
  for (let attempt = 0; attempt < RECOVERY_WAIT_SECONDS.length; attempt++) {
    runner.acknowledge("work", "processing");
    expect(recoverAbandonedClaims(host, now)).toEqual({ retried: ["work"], failed: [] });
    const input = host.inputs()[0];
    expect(input).toMatchObject({ status: "pending", tries: attempt + 1 });
    expect(input.process_after).toBe(
      new Date(now + RECOVERY_WAIT_SECONDS[attempt] * 1000).toISOString(),
    );
    expect(host.processingClaims()).toEqual([]);
    now += RECOVERY_WAIT_SECONDS[attempt] * 1000;
  }
  runner.acknowledge("work", "processing");
  expect(recoverAbandonedClaims(host, now)).toEqual({ retried: [], failed: ["work"] });
  expect(host.inputs()[0]).toMatchObject({ status: "failed", tries: 5 });
});

it("does not redeliver an early-completed input or reinterpret a provider failure", async () => {
  const { host, runner } = await mailboxPair();
  host.submit({
    id: "done",
    content: "done",
    channel_type: "cli",
    platform_id: "o",
    thread_id: null,
  });
  runner.acknowledge("done", "completed");
  host.syncAcknowledgements();
  expect(recoverAbandonedClaims(host, Date.now())).toEqual({ retried: [], failed: [] });
  expect(host.inputs()[0]).toMatchObject({ status: "completed", tries: 0 });
  expect(host.outputs()).toEqual([]);

  host.submit({
    id: "error",
    content: "error",
    channel_type: "cli",
    platform_id: "o",
    thread_id: null,
  });
  runner.acknowledge("error", "failed");
  host.syncAcknowledgements();
  expect(recoverAbandonedClaims(host, Date.now())).toEqual({ retried: [], failed: [] });
  expect(host.inputs()[1]).toMatchObject({ status: "failed", tries: 0 });
});

it("records a container heartbeat the host can observe", async () => {
  const { host, runner } = await mailboxPair();
  expect(host.heartbeat()).toBeUndefined();
  runner.activity("bash", 5000);
  const first = host.heartbeat();
  expect(typeof first).toBe("number");
  expect(host.activity()).toMatchObject({
    current_tool: "bash",
    tool_declared_timeout_ms: 5000,
  });
  runner.touch();
  expect(host.heartbeat()).toBeGreaterThanOrEqual(first ?? 0);
});
