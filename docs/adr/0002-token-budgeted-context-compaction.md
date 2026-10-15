# Token-budgeted context compaction

Status: accepted
Historical implementation: delivered (manual and automatic compaction, context reporting, long-turn prefix summaries, and incremental summary updates)

Implementation note: the embedded execution, configuration, conversation and
completion/delivery mechanisms described below are historical and have been
retired. Current ownership and behavior are defined by ADRs
[0006](0006-sdk-managed-agent-execution.md),
[0007](0007-shared-agent-workspace.md) and
[0008](0008-mailbox-completion-and-recovery.md). Use
[host runtime](../host-runtime.md) for current setup and interfaces.

Long conversations need to fit the model's input budget while retaining recent
work and valid tool exchanges. Compaction replaces older active context with an
incrementally updated summary. Full conversation history remains intact, so
reducing a model request does not erase the recorded conversation.

## Token budgets

- The effective compaction threshold is the model context window minus the
  reserved output budget. Before each chat request, including tool-round
  continuations, compaction starts when estimated context tokens exceed that
  threshold; requests at or below it continue without summarization.
- Reserve at least 16,384 tokens and enough for the configured output allowance.
  Target about 20,000 tokens of recent context, extending the retained tail when
  needed to keep a complete tool exchange.
- Prefer the latest valid provider usage and estimate subsequently appended
  content. Include assistant reasoning, tool arguments, and tool definitions.
  Use conservative margins when exact token counts are unavailable.

Current estimates use UTF-8 serialized JSON bytes divided by three plus eight
framing tokens per message or tool definition. This provides a conservative
budget estimate rather than an exact token count. A valid provider usage sample
has nonnegative integer input and output counts, positive
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
   Manual compaction cuts only before a user message, retaining whole turns and
   their tool groups even when they exceed the recent-token target. Automatic
   compaction first tries that boundary, then allows an assistant boundary when
   no whole turn can be removed or the retained tail exceeds the input budget.
2. If the cut splits a long user turn, summarize the removed turn prefix with
   instructions to preserve its objective and completed work for the continuation.
3. Serialize visible text, tool names, arguments, and bounded tool-result text;
   model reasoning is excluded from the summary input. Tool results are bounded
   to 2,000 characters each with a truncation marker. Supply any previous summary
   separately from the newly removed transcript and ask for an incremental update;
   raw history is never reread for repeated manual or automatic compaction.
4. Generate the summary in a separate model request without tools. Require a
   successful, usable response before replacing the active context. The request
   must fit the model window with the output reserve. A usable summary finishes
   with `stop`, is nonempty, contains no tool calls, and reduces estimated tokens.
5. For automatic compaction, require the rebuilt request to fit the input budget
   before committing any replacement. Rebuild active context from a user summary
   and the retained original messages.
   Retained assistant messages keep their complete `reasoning_content`; there
   is no generated assistant acknowledgement between the summary and tail.
6. Invalidate usage measured before compaction, then construct the next chat
   request from the rebuilt context.

## State and failure behavior

Manual and automatic compaction use this state transition.
Failure, cancellation, or an unusable summary leaves the previous active context intact.
Too little compactable content produces a result without discarding messages.
Automatic failures stop the current chat instead of sending an oversized request.
The active context and its usage sample remain as previously committed; raw
history retains attempted user input and any tool work already recorded. A usable
summary whose retained tail still exceeds the budget is also rejected atomically.

The summary and stable retention boundary are appended to the session log only
after validation, before installing the active context. Persistence failure
preserves committed context. Original JSONL records are neither truncated nor
rewritten. A new CLI launch starts a new session; automatic retries after
context-overflow errors remain outside the session lifecycle.

Recovery in [ADR 0004](0004-persisted-active-context.md) reconstructs context from
the saved summary and stable retention boundary, without a separate full-context
snapshot or regenerating that summary. The compaction algorithm and its
validation remain applicable.

This separates context management from the
[conversation-history contract](0001-agent-runtime-and-data-contracts.md) and
preserves the original reasoning needed by the model's retained tool exchanges.

The Agent serializes chat and compaction mutations. `/context` reports committed
active-context state without calling the model or recording messages. `/compact`
reports success, insufficient content or request budget, unusable summaries,
failure, and cancellation. Failed attempts keep the existing usage sample.

## API and library documentation

- [DeepSeek model limits](https://api-docs.deepseek.com/quick_start/pricing/).
