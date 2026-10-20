import { defineTool } from "@earendil-works/pi-coding-agent";
import type { HistoryOperation } from "@mybots/mailbox";
import { Type } from "typebox";

export const PROGRESS_INSTRUCTIONS =
  "ask_question persists a required owner question and ends the Attempt after all tool results are recorded. Answers arrive as correlated evidence in a later Attempt of this Run. Ordinary Task input does not answer a question. publish_progress records owner-visible progress for this Attempt. publish_result records a selected result summary and optional immutable snapshots of workspace-relative files (up to 16, each within the installation file limit, 25 MiB by default). Neither completes the Run, changes its outcome, grants privileges, nor administers a Bot. Do not send Bot, Task, Run, or Attempt identity. After a timeout, call read_operation with the same requestId; do not publish that request again.";

export function createProgressTools(operation: HistoryOperation) {
  const text = (value: unknown) => ({
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    details: {},
  });
  return [
    defineTool({
      name: "ask_question",
      label: "Ask owner question",
      description:
        "Ask the owner for required information. Persist a question and end this Attempt after the complete tool batch. The owner answers in a separate Web control; a later Attempt continues this Run. Default wait is indefinite. Use a stable requestId; after timeout use read_operation with that identity.",
      parameters: Type.Object(
        {
          requestId: Type.String({ minLength: 1, maxLength: 128 }),
          text: Type.String({ minLength: 1, maxLength: 2000 }),
          deadline: Type.Optional(
            Type.String({
              description: "Explicit ISO 8601 deadline; omit for indefinite waiting.",
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
      description:
        "Record owner-visible progress for the current Attempt. Reuse requestId after a timeout. This does not complete the Run or change its outcome.",
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
        "Record a selected result summary with optional workspace-relative files preserved as immutable downloads for the current Attempt. This is not the Run outcome and grants no authority. Reuse requestId after a timeout.",
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
        "Read a question, progress or selected-result request by its requestId. This does not publish another copy.",
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
