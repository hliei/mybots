import { defineTool } from "@earendil-works/pi-coding-agent";
import type { HistoryOperation } from "@mybots/mailbox";
import { Type } from "typebox";

export const PROGRESS_INSTRUCTIONS =
  "create_routine schedules independent own-Bot work with runAt/timezone or five-field cron. Include selected inputs; chat is not inherited. ask_question ends the Attempt; answers arrive later and ordinary input does not answer. delegate sends selected text to an allowed Bot and ends the Attempt. Denial is input; do not repeat it, target yourself, nest, or grant permission. publish_progress and publish_result do not complete the Run, change its outcome, or grant authority. Do not send Bot, Task, Run, or Attempt identity. After a timeout, read_operation with the same requestId.";

export function createProgressTools(operation: HistoryOperation) {
  const text = (value: unknown) => ({
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    details: {},
  });
  return [
    defineTool({
      name: "create_routine",
      label: "Create Routine",
      description:
        "Schedule independent own-Bot work. On timeout, read_operation with the same requestId.",
      parameters: Type.Object(
        {
          requestId: Type.String({ minLength: 1, maxLength: 128 }),
          text: Type.String({
            minLength: 1,
            maxLength: 32000,
          }),
          runAt: Type.Optional(Type.String({ description: "ISO instant with offset." })),
          timezone: Type.Optional(Type.String({ description: "IANA timezone." })),
          cron: Type.Optional(Type.String({ description: "Five-field cron." })),
        },
        { additionalProperties: false },
      ),
      async execute(_id, input, signal) {
        return text(await operation("create_routine", input, signal));
      },
    }),
    defineTool({
      name: "delegate",
      label: "Delegate to Bot",
      description:
        "Send selected text to an allowed Bot. Ends this Attempt; the result arrives later.",
      parameters: Type.Object(
        {
          requestId: Type.String({ minLength: 1, maxLength: 128 }),
          targetBotId: Type.String({ minLength: 1, maxLength: 128 }),
          text: Type.String({ minLength: 1, maxLength: 32000 }),
        },
        { additionalProperties: false },
      ),
      async execute(_id, input, signal) {
        return text(await operation("delegate", input, signal));
      },
    }),
    defineTool({
      name: "ask_question",
      label: "Ask owner question",
      description:
        "Persist an owner question and end this Attempt. A later Attempt receives the answer.",
      parameters: Type.Object(
        {
          requestId: Type.String({ minLength: 1, maxLength: 128 }),
          text: Type.String({ minLength: 1, maxLength: 2000 }),
          deadline: Type.Optional(
            Type.String({
              description: "ISO deadline; omit if indefinite.",
            }),
          ),
        },
        { additionalProperties: false },
      ),
      async execute(_id, input, signal) {
        return text(await operation("ask_question", input, signal));
      },
    }),
    defineTool({
      name: "publish_progress",
      label: "Publish progress",
      description: "Record owner-visible progress. This does not complete the Run.",
      parameters: Type.Object(
        {
          requestId: Type.String({ minLength: 1, maxLength: 128 }),
          text: Type.String({ minLength: 1, maxLength: 2000 }),
        },
        { additionalProperties: false },
      ),
      async execute(_id, input, signal) {
        return text(await operation("publish_progress", input, signal));
      },
    }),
    defineTool({
      name: "publish_result",
      label: "Publish selected result",
      description:
        "Record a result summary and optional workspace files. This is not the Run outcome.",
      parameters: Type.Object(
        {
          requestId: Type.String({ minLength: 1, maxLength: 128 }),
          text: Type.String({ minLength: 1, maxLength: 2000 }),
          files: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 16 })),
        },
        { additionalProperties: false },
      ),
      async execute(_id, input, signal) {
        return text(await operation("publish_result", input, signal));
      },
    }),
    defineTool({
      name: "read_operation",
      label: "Read host operation",
      description:
        "Read a Routine, question, delegation, progress or selected-result request by its requestId. This does not publish another copy.",
      parameters: Type.Object(
        { requestId: Type.String({ minLength: 1, maxLength: 128 }) },
        { additionalProperties: false },
      ),
      async execute(_id, input, signal) {
        return text(await operation("read_operation", input, signal));
      },
    }),
  ];
}
