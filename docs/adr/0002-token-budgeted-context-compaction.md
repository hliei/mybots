# Token-budgeted context compaction

Status: accepted
Implementation: planned

Long conversations need to fit the model's input budget while retaining recent
work and valid tool exchanges. Compaction replaces older active context with an
incrementally updated summary. Full conversation history remains intact, so
reducing a model request does not erase the recorded conversation.

## Token budgets

- Automatic compaction starts when estimated context tokens exceed the model
  context window minus the reserved output budget.
- Reserve at least 16,384 tokens and enough for the configured output allowance.
  Target about 20,000 tokens of recent context, extending the retained tail when
  needed to keep a complete tool exchange.
- Prefer the latest valid provider usage and estimate subsequently appended
  content. Include assistant reasoning, tool arguments, and tool definitions.
  Use conservative margins when exact token counts are unavailable.

## Compaction sequence

1. Select a recent tail by token budget. Cut before a user or assistant message
   and preserve each retained tool call with all its results; a tool-result
   message cannot be the first retained message.
2. If the cut splits a long user turn, summarize the removed turn prefix so its
   objective and completed work accompany the continuing tail.
3. Update the previous summary with newly removed messages. The summary input
   includes visible text, tool names, arguments, and bounded tool-result text;
   model reasoning is excluded from the summary input.
4. Generate the summary in a separate model request without tools. Require a
   successful, usable response before replacing the active context.
5. Rebuild active context from a user summary and the retained original messages.
   Retained assistant messages keep their complete `reasoning_content`; there
   is no generated assistant acknowledgement between the summary and tail.
6. Invalidate usage measured before compaction, then construct the next chat
   request from the rebuilt context.

## State and failure behavior

Manual and automatic compaction use the same state transition. Failure,
cancellation, or an unusable summary leaves the previous active context intact.
Too little compactable content produces a result without discarding messages.

The summary and retention boundary remain in memory for the current Agent
session. Original JSONL records are neither truncated nor rewritten. A new CLI
launch starts a new session; persisted summary checkpoints and automatic retries
after context-overflow errors are outside the initial session lifecycle.

This separates context management from the
[conversation-history contract](0001-agent-runtime-and-data-contracts.md) and
preserves the original reasoning needed by the model's retained tool exchanges.

## Sources

- [Token budgets, cut points, and incremental summaries in pi](https://github.com/earendil-works/pi/blob/4270522473e677ddba7b093caa0064a3df51d459/packages/coding-agent/src/core/compaction/compaction.ts).
- [Summary serialization in pi](https://github.com/earendil-works/pi/blob/4270522473e677ddba7b093caa0064a3df51d459/packages/coding-agent/src/core/compaction/utils.ts).
- [Summary and message reconstruction in pi](https://github.com/earendil-works/pi/blob/4270522473e677ddba7b093caa0064a3df51d459/packages/coding-agent/src/core/messages.ts).
