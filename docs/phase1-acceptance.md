# Historical embedded-runtime acceptance

This record preserves dated results for the retired embedded execution runtime.
Its commands, settings, data contracts and counts below are historical evidence;
the corresponding live harness has been retired. They do not establish acceptance
of the current host/container deployment. Current checks and the separate pending
DeepSeek/Telegram gate are described in [runtime acceptance](runtime-acceptance.md).

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
