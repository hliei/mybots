import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { runMailbox } from "../container/agent-runner/src/poll-loop.ts";
import type {
  AgentProvider,
  ProviderEvent,
} from "../container/agent-runner/src/providers/types.ts";
import { HostMailbox, initializeMailbox, RunnerMailbox } from "../src/mailbox/node.ts";
import { waitForCheckpoint } from "./checkpoint.ts";

test.each(["result", "throw", "end"])(
  "%s failure keeps completed replies and accounts for each queued input",
  async (failure) => {
    const directory = await mkdtemp(join(tmpdir(), "mybots-runner-queued-error-"));
    const abort = new AbortController();
    const release = Promise.withResolvers<void>();
    let running: Promise<void> | undefined;
    try {
      initializeMailbox(directory);
      const host = new HostMailbox(directory);
      for (const id of ["first", "second", "third"])
        host.submit({ id, content: id, channel_type: "cli", platform_id: id, thread_id: null });
      const mailbox = new RunnerMailbox(directory);
      const reply = mailbox.reply.bind(mailbox);
      mailbox.reply = (input, content, kind) => {
        reply(input, content, kind);
        if (host.outputs().length === 3) abort.abort();
      };
      const provider: AgentProvider = {
        query: () => ({
          push: () => true,
          end: () => {},
          abort: async () => {
            release.resolve();
          },
          events: (async function* (): AsyncGenerator<ProviderEvent> {
            await release.promise;
            yield { type: "result", text: "First completed" };
            if (failure === "throw") throw new Error("Private transport diagnostic");
            if (failure === "end") return;
            yield {
              type: "result",
              text: null,
              isError: true,
              error: "Agent model request failed.",
            };
            yield { type: "result", text: "Third completed" };
          })(),
        }),
      };
      running = runMailbox({
        mailbox,
        provider,
        cwd: directory,
        sessionDir: join(directory, "pi"),
        signal: abort.signal,
        pollMs: 1,
      });
      await vi.waitFor(() => expect(host.acknowledgements()).toHaveLength(3));
      release.resolve();
      await running;
      expect(host.outputs()).toEqual([
        expect.objectContaining({
          in_reply_to: "first",
          content: "First completed",
          kind: "message",
        }),
        expect.objectContaining({ in_reply_to: "second", platform_id: "second", kind: "error" }),
        expect.objectContaining({
          in_reply_to: "third",
          platform_id: "third",
          kind: failure === "result" ? "message" : "error",
        }),
      ]);
      expect(JSON.stringify(host.outputs())).not.toContain("Private transport diagnostic");
      expect(new RunnerMailbox(directory).pending()).toEqual([]);
    } finally {
      abort.abort();
      release.resolve();
      await running;
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("cancelling queued execution rejects late success and retains the early-completion loss window", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mybots-runner-queued-abort-"));
  const abort = new AbortController();
  const cleanup = Promise.withResolvers<void>();
  const aborted = Promise.withResolvers<void>();
  const result = Promise.withResolvers<void>();
  let ended = false;
  let stopped = false;
  let running: Promise<void> | undefined;
  try {
    initializeMailbox(directory);
    const host = new HostMailbox(directory);
    for (const id of ["initial", "queued"])
      host.submit({ id, content: id, channel_type: "cli", platform_id: "owner", thread_id: null });
    const provider: AgentProvider = {
      query: () => ({
        push: () => !ended,
        end: () => {
          ended = true;
        },
        abort: async () => {
          aborted.resolve();
          result.resolve();
          await cleanup.promise;
        },
        events: (async function* (): AsyncGenerator<ProviderEvent> {
          await result.promise;
          yield { type: "result", text: "Late success" };
        })(),
      }),
    };
    running = runMailbox({
      mailbox: new RunnerMailbox(directory),
      provider,
      cwd: directory,
      sessionDir: join(directory, "pi"),
      signal: abort.signal,
      pollMs: 1,
    });
    void running.then(() => {
      stopped = true;
    });
    await vi.waitFor(() =>
      expect(host.acknowledgements()).toContainEqual(
        expect.objectContaining({ message_id: "queued", status: "completed" }),
      ),
    );
    abort.abort();
    await waitForCheckpoint(aborted.promise, "query abort");
    expect(ended).toBe(true);
    expect(stopped).toBe(false);
    host.submit({
      id: "after-abort",
      content: "later",
      channel_type: "cli",
      platform_id: "owner",
      thread_id: null,
    });
    cleanup.resolve();
    await running;
    expect(host.outputs()).toEqual([]);
    expect(host.acknowledgements()).toEqual([
      expect.objectContaining({ message_id: "initial", status: "processing" }),
      expect.objectContaining({ message_id: "queued", status: "completed" }),
    ]);
    expect(new RunnerMailbox(directory).pending().map((input) => input.id)).toEqual([
      "after-abort",
    ]);
  } finally {
    abort.abort();
    result.resolve();
    cleanup.resolve();
    await running;
    await rm(directory, { recursive: true, force: true });
  }
});

test("active follow-ups complete early and each FIFO result retains its own destination", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mybots-runner-queue-"));
  const abort = new AbortController();
  const pushed: string[] = [];
  const release = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  let running: Promise<void> | undefined;
  try {
    initializeMailbox(directory);
    const host = new HostMailbox(directory);
    host.submit({
      id: "first",
      content: "First",
      channel_type: "cli",
      platform_id: "one",
      thread_id: null,
    });
    const provider: AgentProvider = {
      query: () => ({
        push: (text) => {
          pushed.push(text);
          return true;
        },
        end: () => {},
        abort: async () => {
          release.resolve();
        },
        events: (async function* (): AsyncGenerator<ProviderEvent> {
          started.resolve();
          await release.promise;
          yield { type: "result", text: "First result" };
          yield { type: "result", text: "Second result" };
          yield { type: "result", text: "Third result" };
          abort.abort();
        })(),
      }),
    };
    running = runMailbox({
      mailbox: new RunnerMailbox(directory),
      provider,
      cwd: directory,
      sessionDir: join(directory, "pi"),
      signal: abort.signal,
      pollMs: 1,
    });
    await waitForCheckpoint(started.promise, "active runner query");
    host.submit({
      id: "second",
      content: "Second",
      channel_type: "telegram",
      platform_id: "two",
      thread_id: "thread",
    });
    host.submit({
      id: "third",
      content: "Third",
      channel_type: "cli",
      platform_id: "three",
      thread_id: null,
    });
    await vi.waitFor(() =>
      expect(host.acknowledgements()).toEqual([
        expect.objectContaining({ message_id: "first", status: "processing" }),
        expect.objectContaining({ message_id: "second", status: "completed" }),
        expect.objectContaining({ message_id: "third", status: "completed" }),
      ]),
    );
    expect(pushed).toEqual(["Second", "Third"]);
    expect(host.outputs()).toEqual([]);
    release.resolve();
    await running;
    expect(host.outputs()).toEqual([
      expect.objectContaining({
        in_reply_to: "first",
        content: "First result",
        platform_id: "one",
      }),
      expect.objectContaining({
        in_reply_to: "second",
        content: "Second result",
        channel_type: "telegram",
        platform_id: "two",
        thread_id: "thread",
      }),
      expect.objectContaining({
        in_reply_to: "third",
        content: "Third result",
        platform_id: "three",
      }),
    ]);
  } finally {
    abort.abort();
    release.resolve();
    await running;
    await rm(directory, { recursive: true, force: true });
  }
});

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
        push: () => false,
        end: () => {},
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
        push: () => false,
        end: () => {},
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
        push: () => false,
        end: () => {},
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
        push: () => false,
        end: () => {},
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
