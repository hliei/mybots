import { defineTool } from "@earendil-works/pi-coding-agent";
import type { HistoryOperation } from "@mybots/mailbox";
import { Type } from "typebox";

export const PROGRESS_INSTRUCTIONS =
  "publish_progress records owner-visible progress for this Attempt. publish_result records one selected text result. Neither completes the Run, changes its outcome, grants privileges, nor administers a Bot. Do not send Bot, Task, Run, or Attempt identity. After a timeout, call read_operation with the same requestId; do not publish that request again.";

export function createProgressTools(operation: HistoryOperation) {
  const text = (value: unknown) => ({
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    details: {},
  });
  return [
    defineTool({
      name: "publish_progress",
      label: "Publish progress",
      description:
        "Record owner-visible progress for the current Attempt. Reuse requestId after a timeout. This does not complete the Run or change its outcome.",
      parameters: Type.Object(
        {
          requestId: Type.String({ minLength: 1, maxLength: 128 }),
          text: Type.String({ minLength: 1, maxLength: 4000 }),
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
        "Record one selected text result for the current Attempt. This is not the Run outcome and grants no authority. Reuse requestId after a timeout.",
      parameters: Type.Object(
        {
          requestId: Type.String({ minLength: 1, maxLength: 128 }),
          text: Type.String({ minLength: 1, maxLength: 4000 }),
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
        "Read a progress or selected-result request by its requestId. This does not publish another copy.",
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
