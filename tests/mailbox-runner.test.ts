import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { runMailbox } from "../container/agent-runner/src/poll-loop.ts";
import type { AgentProvider } from "../container/agent-runner/src/providers/types.ts";
import { HostMailbox, initializeMailbox, RunnerMailbox } from "../src/mailbox/index.ts";

test("runner acknowledges the initial result before persisting its correlated reply", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mybots-runner-"));
  const abort = new AbortController();
  try {
    initializeMailbox(directory);
    const host = new HostMailbox(directory);
    host.submit({
      id: "input",
      content: "Save",
      channel_type: "cli",
      platform_id: "owner",
      thread_id: null,
    });
    const mailbox = new RunnerMailbox(directory);
    const persistedReply = mailbox.reply.bind(mailbox);
    // The agreed crash checkpoint is between two public mailbox writes.
    mailbox.reply = (input, content, kind) => {
      expect(host.acknowledgements()).toContainEqual(
        expect.objectContaining({ message_id: "input", status: "completed" }),
      );
      expect(host.outputs()).toEqual([]);
      persistedReply(input, content, kind);
      abort.abort();
    };
    const provider: AgentProvider = {
      query: () => ({
        abort: async () => {},
        events: (async function* () {
          yield { type: "init", continuation: "pi:explicit-history" } as const;
          yield { type: "progress", message: "write" } as const;
          yield { type: "result", text: "Saved." } as const;
        })(),
      }),
    };
    await runMailbox({
      mailbox,
      provider,
      cwd: directory,
      sessionDir: join(directory, "pi"),
      signal: abort.signal,
      pollMs: 1,
    });
    expect(host.outputs()).toContainEqual(
      expect.objectContaining({ in_reply_to: "input", content: "Saved.", platform_id: "owner" }),
    );
    expect(host.continuation()).toBe("pi:explicit-history");
  } finally {
    abort.abort();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a persistence crash after completion leaves the accepted final-reply loss window", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mybots-runner-crash-"));
  try {
    initializeMailbox(directory);
    const host = new HostMailbox(directory);
    host.submit({
      id: "lost-reply",
      content: "Work",
      channel_type: "cli",
      platform_id: "owner",
      thread_id: null,
    });
    const mailbox = new RunnerMailbox(directory);
    mailbox.reply = () => {
      throw new Error("Controlled persistence crash");
    };
    const provider: AgentProvider = {
      query: () => ({
        abort: async () => {},
        events: (async function* () {
          yield { type: "result", text: "Completed work" } as const;
        })(),
      }),
    };
    await expect(
      runMailbox({
        mailbox,
        provider,
        cwd: directory,
        sessionDir: join(directory, "pi"),
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("Controlled persistence crash");
    expect(new HostMailbox(directory).acknowledgements()).toContainEqual(
      expect.objectContaining({ message_id: "lost-reply", status: "completed" }),
    );
    expect(host.outputs()).toEqual([]);
    expect(new RunnerMailbox(directory).pending()).toEqual([]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("ordinary provider errors persist failure and do not redeliver the input", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mybots-runner-error-"));
  const abort = new AbortController();
  try {
    initializeMailbox(directory);
    const host = new HostMailbox(directory);
    host.submit({
      id: "failed",
      content: "Work",
      channel_type: "telegram",
      platform_id: "owner-chat",
      thread_id: null,
    });
    const mailbox = new RunnerMailbox(directory);
    const reply = mailbox.reply.bind(mailbox);
    mailbox.reply = (input, content, kind) => {
      reply(input, content, kind);
      abort.abort();
    };
    const provider: AgentProvider = {
      query: () => ({
        abort: async () => {},
        events: (async function* () {
          yield {
            type: "result",
            text: null,
            isError: true,
            error: "Agent model request failed.",
          } as const;
        })(),
      }),
    };
    await runMailbox({
      mailbox,
      provider,
      cwd: directory,
      sessionDir: join(directory, "pi"),
      signal: abort.signal,
    });
    expect(host.acknowledgements()).toContainEqual(
      expect.objectContaining({ message_id: "failed", status: "failed" }),
    );
    expect(host.outputs()).toContainEqual(
      expect.objectContaining({ in_reply_to: "failed", kind: "error", platform_id: "owner-chat" }),
    );
    expect(new RunnerMailbox(directory).pending()).toEqual([]);
  } finally {
    abort.abort();
    await rm(directory, { recursive: true, force: true });
  }
});

test("cancellation awaits provider cleanup and leaves unfinished input for host recovery", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mybots-runner-abort-"));
  const abort = new AbortController();
  let release: (() => void) | undefined;
  let cleaned = false;
  try {
    initializeMailbox(directory);
    const host = new HostMailbox(directory);
    host.submit({
      id: "unfinished",
      content: "Work",
      channel_type: "cli",
      platform_id: "owner",
      thread_id: null,
    });
    const provider: AgentProvider = {
      query: () => ({
        abort: async () => {
          release?.();
          cleaned = true;
        },
        events: (async function* () {
          yield { type: "tool", name: "bash", timeoutMs: 90000 } as const;
          expect(host.activity()).toMatchObject({
            current_tool: "bash",
            tool_declared_timeout_ms: 90000,
          });
          const waiting = new Promise<void>((resolve) => {
            release = resolve;
          });
          abort.abort();
          await waiting;
        })(),
      }),
    };
    await runMailbox({
      mailbox: new RunnerMailbox(directory),
      provider,
      cwd: directory,
      sessionDir: join(directory, "pi"),
      signal: abort.signal,
    });
    expect(cleaned).toBe(true);
    expect(host.acknowledgements()).toContainEqual(
      expect.objectContaining({ message_id: "unfinished", status: "processing" }),
    );
    expect(host.outputs()).toEqual([]);
    expect(host.activity()?.current_tool).toBeNull();
  } finally {
    abort.abort();
    await rm(directory, { recursive: true, force: true });
  }
});
