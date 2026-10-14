# Phase 1 acceptance

This record preserves the earlier acceptance scope and dated results. Current
runtime checks and the outstanding Telegram service gate are documented in
[runtime acceptance](runtime-acceptance.md). The commands and scenario descriptions
below use the current append-only compaction contract; historical evidence is
retained under its original dates.

Phase 1 includes the shared Agent, CLI conversations and inspection commands,
DeepSeek thinking/tool continuation, local tools, Skills, append-only JSONL
history, manual/automatic compaction, explicit-provider search and HTTP content
fetching. The bot entry point was outside this Phase 1 acceptance; later-phase
channels, routing, scheduling and long-term memory also remain outside it.

Real-service acceptance completed on October 13, 2026: all four live cases
passed with DeepSeek and SerpApi. Brave remains covered by offline tests only.
The final successful run is recorded below alongside earlier failed checkpoints.

## Offline verification

Run `npm run verify` with Node.js 24.21.0: formatting/lint, type checking, the
ordinary offline suite, compilation, and executable CLI/bot startup checks.
Normal Vitest discovery explicitly excludes `tests/live/`, including watching.
Credentials do not change ordinary test behavior.

The [data contract fixtures](../tests/fixtures/contracts/README.md)
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
MYBOTS_ACCEPTANCE_WORKSPACE=/absolute/path/to/workspace npm run test:live -- tests/live/phase1.test.ts
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
2. Search for HTTP Semantics through the selected adapter, fetch the HTTP Working
   Group source from the returned results, and continue the model answer. Require
   nonempty sources and readable fetched text. This known public source avoids
   making acceptance depend on the highest-ranked mirror's availability. Print
   the exercised provider; untested adapters gain no live coverage claim.
3. Fetch RFC 9110 from the RFC Editor, then fetch its next 400-character chunk
   through the Agent. Check readable text, offsets, URL metadata, history and
   model continuation.
4. Send three archive turns exceeding the recent-context retention target,
   request a real manual summary, restart the Agent and recall a fact found only
   in the removed prefix. Check changed active context, an unchanged original log
   prefix/index, one appended compaction record, saved context/ID reuse after
   restart and subsequent append-only continuation.

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

## Data contracts and compatibility guarantees

The delivered runtime, data formats, and tool behavior are covered as follows.

| Area | Delivered contract | Decision and validation |
| --- | --- | --- |
| Runtime/provider | TypeScript/Node.js; DeepSeek is the sole initial provider, default `deepseek-flash` | [ADR 0001](adr/0001-agent-runtime-and-data-contracts.md); controlled requests and live effective settings |
| Default paths | `.agents/bots` and `.agents/skills`; explicit `agents_path` and `skills_path` override defaults | ADR 0001; explicit-path fixtures |
| Model settings | `thinking` defaults to true; `context_window` controls budgets without being sent to the API | ADRs 0001/0002; overrides and thinking on/off tests |
| Messages | Optional original `reasoning_content`, including empty strings; absent values are never invented | ADR 0001; legacy fixtures and exact reasoning tests |
| Unknown fields | Retain index extensions on rewrite; message files are append-only | ADR 0001; extension fixtures |
| Skill inspection | Read discovered definitions through `SkillLoader`; inspection does not load context | ADR 0001; command/CLI tests |
| Tool ordering | Execute multiple calls in order and preserve call/result pairing | README; ordered dependency tests |
| Compaction | Incremental active-context summaries, reserve/usage budgets, UTF-8 estimates, safe tool boundaries, appended summary and retention boundary | [ADR 0002](adr/0002-token-budgeted-context-compaction.md), [ADR 0004](adr/0004-persisted-active-context.md); offline reconstruction and real summary/restart |
| Web tools | `web_search`/`fetch_content` replace legacy names/configuration without aliases; explicit Brave/SerpApi choice | [ADR 0003](adr/0003-web-search-and-content-fetching.md); migration errors and both offline adapters |
| Web content | Direct HTTP without JavaScript rendering; bounded JSON, Unicode pagination and refetching; chunks are not stable snapshots | ADR 0003 supersedes rendered-browser acceptance; extraction and pagination tests |
| Dependencies | Native Node.js error wording and HTTP deadlines covering body consumption | ADRs 0001/0003 and README; errors, deadline and cleanup tests |

No guarantee covers legacy web settings, thinking replay from records that never
saved reasoning, or later-phase capabilities.

## Executed evidence

Offline and live results are recorded separately below. Passing offline tests
does not complete the real-service gate.

### October 13, 2026: offline results

- `npm exec --yes --package=node@24.21.0 -- npm test -- tests/workspace-contracts.test.ts`
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

### October 13, 2026: checkpoint before search configuration

The full command at this checkpoint, with the strengthened assertions, was:

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
remaining Standards or Spec findings. At this checkpoint, overall real-service
acceptance was incomplete pending configured search and the combined search/fetch
case. This checkpoint did not establish a successful live gate.

### October 13, 2026: configured SerpApi follow-up

The source Workspace was saved with `web_search.provider: serpapi` and its
credential. No credentials were added to version control or result reports.

The first configured full run passed three cases but failed fetching the
highest-ranked search source (`fetch failed`). A direct Node.js 24 probe of the
same diagnostic query's first source, `https://www.protokols.ru/rfc9110/`,
reproduced `UND_ERR_CONNECT_TIMEOUT`; its HTTP Working Group result returned
HTTP 200. An attempted RFC Editor domain-restricted query returned no sources;
another diagnostic request timed out after 30 seconds. A new HTTP Semantics
query also timed out. These failed runs do not count as completed acceptance.

The fixture retains the original RFC 9110 query and now chooses the HTTP Working
Group URL from its actual search results instead of fetching the highest-ranked
mirror. It logs the chosen public source URL. Application code, service deadlines,
retry behavior and provider selection are unchanged. Missing expected sources or
failed content still fail the case.

`npm exec --yes --package=node@24.21.0 -- npm run test:live -- -t 'searches the explicitly configured'`
passed the focused case: SerpApi returned nonempty sources, the Agent fetched
`https://httpwg.org/http-core/draft-ietf-httpbis-semantics-latest.html`, and
DeepSeek continued with a final reply. The fresh history reader recovered both
tool exchanges with their matching IDs and original reasoning. Three unrelated
cases were filtered out in this focused run.

`npm exec --yes --package=node@24.21.0 -- npm run verify` was rerun and passed
all 277 offline tests, checks/types, build and executable startup smoke checks.
Focused-case type checking passed after the final fixture adjustment.

### October 13, 2026: completed real-service acceptance

Final full command under Node.js 24.21.0:

```sh
npm exec --yes --package=node@24.21.0 -- npm run test:live
```

Result: **4 passed, 0 failed, 0 skipped**, exit status 0, duration 60.34 seconds.
Source Workspace: `./workspace`. Model: official DeepSeek `deepseek-flash`,
thinking enabled. Exercised search provider: **SerpApi**; this run does not
establish Brave live coverage.

| Scenario | Final observable result |
| --- | --- |
| Conversation/Skills/local tools | Fact recalled across turns; successful Skill/write/edit/read/bash exchanges with exact arguments and dependent ordering; fresh reader recovered paired results and original nonempty/empty reasoning strings |
| Search and fetched source | SerpApi returned sources; Agent fetched the returned HTTPWG HTML page, received readable content and continued its final answer; saved search/fetch exchanges retained IDs and reasoning |
| HTTP continuation | RFC 9110 text returned consecutive 400-character chunks, offsets 400/800 and equal total length; Agent continued after each fetch |
| Compaction | Real summary removed four older messages, leaving five active messages; original log/index stayed byte-for-byte intact; subsequent reply recalled the original fact and appended history |

The command exited normally and temporary Workspace inspection found no
leftovers. No live failures remain in this final acceptance run. Earlier mirror
connection failures and SerpApi query timeouts remain documented above; passing
this run does not guarantee future service availability. Final Standards and
Spec reviews found no remaining issues. Offline verification remains separate:
277 tests, check/types, build and compiled entry-point startup checks passed.
