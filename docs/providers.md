# Model providers

Mybots supports text, reasoning and local tools through two installation-wide
API keys. Bot settings keep an independent `<provider>/<model-id>` choice. New
Bots default to `deepseek/deepseek-flash`; Go is an explicit choice for coding-agent
work. There is no classification, fallback, endpoint editor or connection-test
request. Configured status means a key is saved locally, not verified access.

The catalog is fixed in `packages/agent/src/providers.ts`. Model limits,
thinking-level maps and protocol compatibility use the pinned SDK metadata,
with explicit current Go endpoint/ID mappings and the Kimi K3.1 Pro definition.
It is not refreshed over the network at startup or when saving keys. All product
input is text; image input and provider-hosted tools are outside this surface.

## Supported catalog

DeepSeek uses `https://api.deepseek.com/chat/completions` with the OpenAI Chat
Completions adapter. Supported IDs are `deepseek-flash` and `deepseek-v4-pro`.
Thinking is enabled, and assistant reasoning content is retained across tool
rounds. Defaults request high thinking; the adapter maps it to the model's
supported level. See [DeepSeek model details](https://api-docs.deepseek.com/quick_start/pricing/)
and [thinking with tools](https://api-docs.deepseek.com/guides/thinking_mode/).

Go uses `https://opencode.ai/inference/go` with these protocol families:

| Adapter | Endpoint suffix | Supported model IDs |
| --- | --- | --- |
| OpenAI Chat Completions | `/openai/v1/chat/completions` | `glm-5.3-flash`, `glm-5.3`, `glm-5.2`, `kimi-k3.1-pro`, `kimi-k3`, `kimi-k2.7-code`, `longcat-2.0`, `deepseek-v4.1-flash`, `deepseek-v4-pro`, `mimo-v2.6-flash`, `mimo-v2.6-pro`, `mimo-v2.5`, `mimo-v2.5-pro`, `minimax-m3.1-flash`, `hy3`, `hy4-preview`, `step-5-preview` |
| Anthropic Messages | `/anthropic/v1/messages` | `claude-haiku-5-5`, `minimax-m3`, `qwen3.7-plus`, `qwen3.8-flash`, `qwen3.8-max` |
| OpenAI Responses | `/openai/v1/responses` | `grok-4.7`, `gpt-6-luna`, `gpt-5.6-luna`, `muse-spark-1.3-contributor`, `muse-spark-1.2-contributor` |
| Google Generative AI | `/google/v1beta/models/<model>:streamGenerateContent` | `gemini-4-argon` |

Requests identify the application as `mybots/0.0.0`. Every Go protocol receives
`x-opencode-session` from the SDK's persisted Conversation session identity,
including tool follow-ups and after reopen. Thinking/signatures, tool arguments
and tool results stay in their protocol's native SDK representation.

See the [official Go endpoint table and client requirements](https://opencode.ai/v2/docs/console/go/)
and [Kimi K3.1 Pro metadata](https://pi.dev/models/opencode-go/kimi-k3-1-pro).
Go requires a suitable subscription. Provider privacy/region controls may block
particular models even with a valid key. Free-tier models are excluded because
[third-party free chat access is restricted](https://opencode.ai/v2/docs/console/api/inference/).
The catalog makes no promise of future provider availability.

## Updates and failures

See [Provider settings and startup](durable-chat.md#provider-settings-and-startup)
for owner-only key persistence and replacement/removal behavior. Worker auth
resolves the saved key for every model request, including compaction. Previously
issued requests retain their captured key. Missing keys block later calls;
provider failures report sanitized authentication, access/subscription, quota or
model-availability guidance without changing the selected model. Existing
history remains readable and unavailable saved choices remain editable.

## Verification boundary

Offline tests run the real worker, SDK adapters and SQLite against local HTTP/SSE
fixtures. Every catalog model exercises two tool calls, a final answer and stable
Go session identity across reopen. Separate barriers prove key replacement and
removal between requests in one turn. Built Web verifies empty-key startup,
settings forms, availability refresh and absence of keys in browser storage.
These checks establish adapter integration, not real provider acceptance or
subscription availability. No live inference is part of ordinary verification.
