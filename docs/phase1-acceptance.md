# Phase 1 acceptance

Phase 1 includes the shared Agent, CLI conversations and inspection commands,
DeepSeek thinking/tool continuation, local tools, Skills, append-only JSONL
history, manual/automatic compaction, explicit-provider search and HTTP content
fetching. The bot entry point remains a startup placeholder. Later-phase
channels, routing, scheduling and long-term memory remain outside this acceptance.

## Offline verification

Run `npm run verify` with Node.js 24.21.0: formatting/lint, type checking, the
ordinary offline suite, compilation, and executable CLI/bot startup checks.
Normal Vitest discovery explicitly excludes `tests/live/`, including watching.
Credentials do not change ordinary test behavior.

The [independent reference fixtures](../tests/fixtures/reference/README.md)
cover Workspace, Agent, Skill, message and index contracts. Agent/CLI tests also
cover tools, inspection without model calls, ordered results, thinking on/off,
saved reasoning and new-reader history recovery. Compaction tests cover automatic
thresholds, incremental summaries, long tool turns and atomic failure/cancellation.
Web tests cover both adapters, HTML/Markdown/plain text, Unicode pagination,
partial failures, deadlines, body limits and response cleanup on cancellation.

## Separate live acceptance

Configure the source Workspace and its selected Agent's DeepSeek credentials
as described in the [README](../README.md). Configure `web_search` with an explicit
Brave or SerpApi provider and its key. Then run:

```sh
MYBOTS_ACCEPTANCE_WORKSPACE=/absolute/path/to/workspace npm run test:live
```

The source defaults to `./workspace`. Effective model settings, including Agent
overrides, and selected search settings are copied to fresh temporary Workspaces.
Source instructions, Skills and history are not used. Temporary configuration
uses mode 0600; all temporary files are removed in cleanup. Do not publish raw
configuration or history. Acceptance forces thinking on, an 8,192-token output
allowance and a 100,000-token context budget for these cases only.

1. Recall a fact across turns, then load a Skill and execute `write`, `edit`,
   `read` and a fixed `printf` shell command. Check artifacts, replies, call/result
   IDs and original saved reasoning through a fresh reader.
2. Search through the selected adapter, fetch one returned source, and continue
   the model answer. Require nonempty sources and readable fetched text. Print
   the exercised provider; untested adapters gain no live coverage claim.
3. Fetch RFC 9110 from the RFC Editor, then fetch its next 400-character chunk
   through the Agent. Check readable text, offsets, URL metadata, history and
   model continuation.
4. Send three archive turns exceeding the recent-context retention target,
   request a real manual summary, and recall a fact found only in the removed
   prefix. Check changed active context, byte-for-byte original log/index
   retention and subsequent append-only continuation.

Cases run sequentially with four-minute cancellation deadlines and five-minute
test timeouts; existing provider/tool deadlines still apply. Cleanup runs after
failure as well as success. Successful command exit provides completed-request
cleanup evidence; offline stalled-body/cancellation tests cover failure paths
that a successful public request cannot prove.

Missing configuration or failed checks fail acceptance rather than become passing
skips. Focused runs, such as `npm run test:live -- -t "compacts"`, do not establish
complete acceptance. Assertions check contracts and markers, not exact model
wording. Logs print model/provider names and reasoning lengths, not keys or
reasoning text. Empty reasoning strings on individual provider rounds are valid;
the conversation case additionally requires some nonempty saved reasoning.

## Compatibility exception record

The fixed tutorial is the common-field baseline. Approved extensions and
replacements limit compatibility as follows.

| Area | Delivered exception | Decision and validation |
| --- | --- | --- |
| Runtime/provider | TypeScript/Node.js; DeepSeek is the sole initial provider, default `deepseek-flash` | [ADR 0001](adr/0001-agent-runtime-and-data-contracts.md); controlled requests and live effective settings |
| Default paths | `.agents/bots` and `.agents/skills` replace reference `agents` and `skills` | ADR 0001; explicit-path fixtures preserve reference layout |
| Model settings | `thinking` defaults to true; `context_window` controls budgets without being sent to the API | ADRs 0001/0002; overrides and thinking on/off tests |
| Messages | Optional original `reasoning_content`, including empty strings; absent values are never invented | ADR 0001; legacy fixtures and exact reasoning tests. Python drops reasoning on rewrites; lossless exchange covers common fields |
| Unknown fields | Retain index extensions on rewrite; message files are append-only | ADR 0001; extension fixtures. Python drops unknown index fields |
| Skill inspection | Correct the reference's missing session-attribute lookup; inspection does not load context | ADR 0001; command/CLI tests |
| Tool ordering | Execute multiple calls in order rather than reference concurrency; preserve result pairing | Approved Phase 1 spec and README; ordered dependency tests |
| Compaction | Pi-style incremental active-context summaries, reserve/usage budgets, UTF-8 estimates, safe tool boundaries, in-memory state | [ADR 0002](adr/0002-token-budgeted-context-compaction.md); offline manual/automatic invariants and real manual summary |
| Web tools | `web_search`/`fetch_content` replace legacy names/configuration without aliases; explicit Brave/SerpApi choice | [ADR 0003](adr/0003-web-search-and-content-fetching.md); migration errors and both offline adapters |
| Web content | Direct HTTP without JavaScript rendering; bounded JSON, Unicode pagination and refetching | ADR 0003 supersedes rendered-browser acceptance; extraction/Markdown differ from Crawl4AI, chunks are not stable snapshots |
| Dependencies | Native Node.js error wording and HTTP deadlines covering body consumption | ADRs 0001/0003 and README; errors, deadline and cleanup tests |

No guarantee covers legacy web settings, thinking replay from records that never
saved reasoning, or later-phase capabilities.

## Executed evidence

Offline and live results are recorded separately below. Passing offline tests
does not complete the real-service gate.

### October 13, 2026: offline results

- `npm exec --yes --package=node@24.21.0 -- npm test -- tests/reference-contracts.test.ts`
  passed the independent Workspace/Agent/Skill fixture case.
- `npm exec --yes --package=node@24.21.0 -- npm run verify` passed all 277
  ordinary tests across 12 files, formatting/lint, type checking, compilation
  and executable CLI/bot startup checks. No live case was discovered.
- After strengthening live assertions, `npm exec --yes --package=node@24.21.0 -- npm run check`
  passed formatting/lint and type checking again. Documentation relative links
  and staged whitespace checks passed.
- Standards review found no actionable issues. Spec review identified one
  acceptance-validity issue: merely calling each local tool did not prove a
  successful exchange. Exact arguments, success results and dependent ordering
  were added and reviewed again; zero findings remain on both axes.

### October 13, 2026: live checkpoints

- `npm exec --yes --package=node@24.21.0 -- npm run test:live` initially exposed
  two overly strict fixture assumptions: some thinking tool rounds legitimately
  return empty reasoning strings, and the first 400 RFC characters contain
  document metadata before the HTTP title. Assertions now preserve original
  reasoning strings, require nonempty reasoning somewhere in the conversation,
  and check the title across both chunks. No application change was required.
- The corrected full run passed conversation/tools, HTTP continuation and
  compaction, but failed search because the source lacked `web_search`.
  No search provider was contacted in that run.
- `npm exec --yes --package=node@24.21.0 -- npm run test:live -- -t 'continues a real thinking'`
  passed the strengthened local-tool case, including successful Skill, write,
  edit, read and shell results. Its three nonmatching cases were filtered out;
  this focused pass alone does not establish full acceptance.

### October 13, 2026: final available live checkpoint

The final full command, with the strengthened assertions, was:

```sh
npm exec --yes --package=node@24.21.0 -- npm run test:live
```

Result: **3 passed, 1 failed**, exit status 1. The source was `./workspace`,
model `deepseek-flash` at the official DeepSeek endpoint, with thinking enabled.

| Scenario | Observable result |
| --- | --- |
| Conversation/Skills/local tools | Fact recalled across turns; exact Skill and four local-tool arguments/results verified; saved reasoning contained nonempty and original empty strings; complete call/result pairing recovered with a fresh reader |
| HTTP continuation | RFC 9110 fetched as readable text; consecutive 400-character chunks returned offsets 400/800 and equal total length; Agent continued after both tool results |
| Compaction | Removed four older messages, leaving five active messages; original log/index unchanged during summary; critical fact recalled afterward and raw history appended without rewriting |
| Search and fetched search source | Failed before contacting a provider because source configuration has no `web_search`; no Brave or SerpApi live coverage is claimed |

The command exited after request completion; filesystem inspection found zero
remaining `mybots-live-*` temporary Workspaces. Automated review has zero
remaining Standards or Spec findings. **Overall real-service acceptance remains
incomplete** pending configured search and the combined search/fetch case.
Supply/save a source Workspace with `web_search.provider` and `api_key`, then
rerun the full live command and append its separate results before resolving
the acceptance ticket. This checkpoint does not claim a successful live gate.
