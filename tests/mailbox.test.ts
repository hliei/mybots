import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { HostMailbox, initializeMailbox, RunnerMailbox } from "../src/mailbox/index.ts";

test("persisted input crosses the directional mailbox with ordered correlated output", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mybots-mailbox-"));
  try {
    initializeMailbox(directory);
    const host = new HostMailbox(directory);
    host.submit({
      id: "first",
      content: "Save a note",
      channel_type: "cli",
      platform_id: "owner",
      thread_id: null,
    });
    host.submit({
      id: "second",
      content: "Read the note",
      channel_type: "telegram",
      platform_id: "chat",
      thread_id: "thread",
    });
    const runner = new RunnerMailbox(directory);
    const messages = runner.pending();
    expect(messages.map(({ id, seq }) => ({ id, seq }))).toEqual([
      { id: "first", seq: 2 },
      { id: "second", seq: 4 },
    ]);
    runner.acknowledge("first", "completed");
    runner.reply(messages[0], "Saved.");
    runner.acknowledge("second", "failed");
    expect(new HostMailbox(directory).outputs()).toEqual([
      expect.objectContaining({
        seq: 1,
        in_reply_to: "first",
        content: "Saved.",
        channel_type: "cli",
        platform_id: "owner",
        thread_id: null,
      }),
    ]);
    expect(
      host.acknowledgements().map(({ message_id, status }) => ({ message_id, status })),
    ).toEqual([
      { message_id: "first", status: "completed" },
      { message_id: "second", status: "failed" },
    ]);
    expect(new RunnerMailbox(directory).pending()).toEqual([]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
