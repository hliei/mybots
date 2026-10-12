# Web search and content fetching

Status: accepted
Implementation: delivered

The web tools expose `web_search` and `fetch_content`, with
explicit provider selection and bounded output. The design supersedes the
web-tool direction in [ADR 0001](0001-agent-runtime-and-data-contracts.md).
The contracts below describe the delivered replacement. The original web
contracts in ADR 0001 remain a historical record.

## Accepted direction

Search supports SerpApi and Brave API adapters. Workspace configuration chooses
one provider; the tool does not discover providers or switch to another provider
after failure. Keeping selection explicit makes credentials, request behavior,
and failures predictable without a provider discovery or fallback system.

`src/providers/` contains LLM integrations used by the Agent runtime. Web tools
and their integrations belong together in `src/tools/web-access/`, concentrating the
search and extraction behavior with the tools that own it. Brave and SerpApi
remain separate internal adapters returning normalized source results. This
preserves a real adapter seam without creating a top-level web-provider layer.
The Agent uses the tool interface rather than the internal web adapters.

Use `web-search.ts` and `fetch-content.ts` as the web tool entry modules, with
`brave.ts` and `serpapi.ts` for search adapters. Keep DeepSeek in
`src/providers/deepseek.ts`; no additional `llm/` nesting is needed.
The configuration field `web_search.provider` still selects the search service.

The replacement removes the `websearch` and `webread` tool names without
compatibility aliases. The original delivery and completed tickets remain
historical records; replacement work proceeds as a new delivery instead of
reverting the integrated changes first.

## Search contract

`web_search` accepts either a single `query` or a `queries` array, exclusively.
Optional `numResults` defaults to 5 and permits 1 through 20 results per query.
Optional `recencyFilter` accepts `day`, `week`, `month`, or `year`.
Optional `domainFilter` restricts domains, with a leading `-` denoting exclusion.
Domain matches include subdomains; exclusions win and source ranking is
preserved after filtering. Results are bounded without extra count-filling
requests or provider pagination. SerpApi uses Google search with native
`tbs=qdr:d/w/m/y` recency filters; Brave uses `freshness=pd/pw/pm/py` and `count`.
SerpApi does not use Google's discontinued `num` parameter; both adapters
bound their normalized results locally.

Each source has `title`, `url`, and `snippet`. Search does not fetch source
content, generate an additional model summary, create background jobs, or
introduce stored response IDs. The Agent requests content separately through
`fetch_content`. Provider selection is not a tool argument.

## Content-fetching scope

`fetch_content` accepts either a single `url` or a `urls` array, exclusively.
Both tools retain results for successful batch items when another item fails.
The tool argument framework supports the optional and array inputs required
by these contracts without introducing new Agent orchestration.

Content fetching uses direct HTTP(S) requests and HTML main-content extraction into
Markdown; it does not execute JavaScript. The supported resources are public
HTML pages, Markdown, and plain text. GitHub pages use the ordinary page route;
repository cloning, PDFs, images, video, local files, and authenticated content
are outside this delivery. Unsupported formats produce explicit errors.

This replaces the rendered-content requirement in the original web-reading
design. Content present only after JavaScript execution is not supported.
The implementation removes the Playwright browser dependency and uses no
hosted extraction providers or provider fallback chains.

## Results and long content

Both tools return JSON serialized into the existing tool-message string.
Single and batch inputs share the same result envelope. Search returns a
`queries` array of `query`, `provider`, `results`, and `error`. Content fetching
returns a `urls` array of `url`, `finalUrl`, `title`, `content`, `error`,
`totalChars`, and `nextOffset`. Preserve input order and the original URL;
`finalUrl` identifies the resource after redirects. Successful items have a
null error; an empty search result is a successful empty result list. Failed
search items have empty results. Failed content items have empty title/content,
zero totalChars, null nextOffset, and a nonempty error. `finalUrl` is null until a
final response URL is established. Malformed arguments use the Toolbox error
path before making requests.

Content fetching accepts optional `offset` and `limit` over the extracted text.
The default offset is zero and the default limit is 10,000 characters; the
maximum limit is 20,000. `totalChars` describes the entire extracted text and
`nextOffset` is null when no further text remains. One set of pagination inputs
applies to every item in a batch. Offsets and lengths count Unicode code
points, preserving non-BMP characters. At or beyond the end, content is empty
and nextOffset is null while totalChars remains the full length. A five-item
call returns at most 100,000 content characters, or 50,000 at the default limit,
plus metadata; JSON escaping can increase serialized size.

Continuations fetch and extract the URL again. There is no cache or stored
response ID, so a changing page can produce inconsistent text between calls.
This trades stable snapshots for a smaller lifecycle and two self-contained
tools while allowing access beyond the first bounded chunk.

## HTML extraction

Use Readability to identify the main content and convert it to Markdown.
When Readability yields no usable content, convert the body after removing
scripts, styles, templates, noscript, hidden attributes, ARIA-hidden elements,
and inline hidden styles. If that also yields no text,
return an extraction error. Body fallback may retain navigation text. Relative
links and image references resolve against the document base at the final URL.
The title comes from the HTML document, or is empty if unavailable. Response
Content-Type determines format; URL suffixes do not select an extraction route.
Markdown and plain-text responses use their response text directly. Only this
readable route is exposed; there are no `raw` or `answer` modes or additional
extraction engines.

## Configuration and execution

`web_search` configuration requires an explicit `provider` (`serpapi` or
`brave`) and a nonempty `api_key`. Optional `api_base` selects a complete
HTTP(S) search endpoint, retaining the controlled-service test seam.
An empty `fetch_content` mapping enables content fetching without a provider
selector. Omitted or null tool configurations disable the corresponding tool.
Reject the legacy `websearch` and `webread` keys at startup with migration
instructions. The `llm` configuration contract is unchanged.

Each tool call permits at most five items and executes at most three items
concurrently. Each item has a 30-second request deadline and a 5 MiB
decoded response-body limit enforced during streamed consumption. The deadline
includes body consumption. HTTP errors, invalid provider payloads, timeouts,
oversized bodies, unsupported formats, and extraction failures
are returned per item; there are no automatic retries. Agent cancellation
terminates active requests and prevents pending items from starting. These
limits are fixed rather than workspace configuration options. Body readers,
connections, and explicitly cleared timers are released on success and failure.
Separate tool calls remain ordered through the existing Agent loop.

The parameter framework, module ownership, new tools, removal of replaced
code and dependencies, tests, and documentation form one replacement PR.

## Sources

- [Web tool definitions](https://github.com/nicobailon/pi-web-access/blob/8e812826269624406458531f9231b679547f5a3a/mcp-tool-definitions.ts).
- [Search and fetch orchestration](https://github.com/nicobailon/pi-web-access/blob/8e812826269624406458531f9231b679547f5a3a/web-tool-core.ts).
- [Content extraction](https://github.com/nicobailon/pi-web-access/blob/8e812826269624406458531f9231b679547f5a3a/extract.ts).
- [SerpApi Google Search API](https://serpapi.com/search-api).
- [Brave Web Search API](https://api-dashboard.search.brave.com/api-reference/web/search/get).
