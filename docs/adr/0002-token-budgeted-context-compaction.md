# Token-budgeted context compaction

Status: accepted
Implementation: partial (manual compaction and context reporting delivered; automatic triggering, long-turn prefix summaries, and repeated-compaction integration planned)

Long conversations need to fit the model's input budget while retaining recent
work and valid tool exchanges. Compaction replaces older active context with an
incrementally updated summary. Full conversation history remains intact, so
reducing a model request does not erase the recorded conversation.

## Token budgets

- The effective compaction threshold is the model context window minus the
  reserved output budget. Automatic triggering at this threshold is planned.
  It will start when estimated context tokens exceed that threshold.
- Reserve at least 16,384 tokens and enough for the configured output allowance.
  Target about 20,000 tokens of recent context, extending the retained tail when
  needed to keep a complete tool exchange.
- Prefer the latest valid provider usage and estimate subsequently appended
  content. Include assistant reasoning, tool arguments, and tool definitions.
  Use conservative margins when exact token counts are unavailable.

Current estimates use UTF-8 serialized JSON bytes divided by three plus eight
framing tokens per message or tool definition. This is a conservative margin
relative to pi's character-based estimate, not an exact tokenizer. A valid
provider usage sample has nonnegative integer input and output counts, positive
input, and a total equal to their sum; subsequent messages are estimated.
Usage metadata stays outside persisted conversation messages.

The DeepSeek provider uses the published 1M window for `deepseek-flash`,
`deepseek-v4-pro`, and the Flash aliases `deepseek-v4-flash` and
`deepseek-v4-flash-vision-exp`. Other model names default to 128,000 tokens.
The optional positive integer `llm.context_window`, including Agent overrides,
sets the actual model or endpoint window without changing the provider request.
Model limits were verified on October 12, 2026.

## Compaction sequence

1. Select a recent tail by token budget. Cut before a user or assistant message
   and preserve each retained tool call with all its results; a tool-result
   message cannot be the first retained message.
   Manual compaction currently cuts only before a user message, retaining whole
   turns and their tool groups even when they exceed the recent-token target.
2. Planned: if the cut splits a long user turn, summarize the removed turn prefix
   so its objective and completed work accompany the continuing tail.
3. Serialize visible text, tool names, arguments, and bounded tool-result text;
   model reasoning is excluded from the summary input. Tool results are bounded
   to 2,000 characters each with a truncation marker. Updating the previous
   summary with newly removed messages and repeated-compaction integration are
   planned follow-up work.
4. Generate the summary in a separate model request without tools. Require a
   successful, usable response before replacing the active context. The request
   must fit the model window with the output reserve. A usable summary finishes
   with `stop`, is nonempty, contains no tool calls, and reduces estimated tokens.
5. Rebuild active context from a user summary and the retained original messages.
   Retained assistant messages keep their complete `reasoning_content`; there
   is no generated assistant acknowledgement between the summary and tail.
6. Invalidate usage measured before compaction, then construct the next chat
   request from the rebuilt context.

## State and failure behavior

Manual compaction uses this state transition; automatic invocation is planned.
Failure, cancellation, or an unusable summary leaves the previous active context intact.
Too little compactable content produces a result without discarding messages.

The summary and retention boundary remain in memory for the current Agent
session. Original JSONL records are neither truncated nor rewritten. A new CLI
launch starts a new session; persisted summary checkpoints and automatic retries
after context-overflow errors are outside the initial session lifecycle.

This separates context management from the
[conversation-history contract](0001-agent-runtime-and-data-contracts.md) and
preserves the original reasoning needed by the model's retained tool exchanges.

The Agent serializes chat and compaction mutations. `/context` reports committed
active-context state without calling the model or recording messages. `/compact`
reports success, insufficient content or request budget, unusable summaries,
failure, and cancellation. Failed attempts keep the existing usage sample.

## Sources

- [DeepSeek model limits](https://api-docs.deepseek.com/quick_start/pricing/).
- [Token budgets, cut points, and incremental summaries in pi](https://github.com/earendil-works/pi/blob/4270522473e677ddba7b093caa0064a3df51d459/packages/coding-agent/src/core/compaction/compaction.ts).
- [Summary serialization in pi](https://github.com/earendil-works/pi/blob/4270522473e677ddba7b093caa0064a3df51d459/packages/coding-agent/src/core/compaction/utils.ts).
- [Summary and message reconstruction in pi](https://github.com/earendil-works/pi/blob/4270522473e677ddba7b093caa0064a3df51d459/packages/coding-agent/src/core/messages.ts).
