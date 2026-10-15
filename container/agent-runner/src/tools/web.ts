import { domainToASCII } from "node:url";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Readability } from "@mozilla/readability";
import type { WebConfiguration, WebSearchConfiguration } from "@mybots/mailbox";
import { JSDOM } from "jsdom";
import TurndownService from "turndown";
import { Type } from "typebox";

/** Bounded request limits are fixed behavior, not workspace configuration. */
const REQUEST_DEADLINE_MS = 30_000;
const MAX_BODY_BYTES = 5_242_880;
const MAX_ITEMS = 5;
const MAX_CONCURRENCY = 3;
const DEFAULT_NUM_RESULTS = 5;
const DEFAULT_LIMIT = 10_000;
const MAX_LIMIT = 20_000;

/** Non-secret placeholder replaced by the credential gateway at the provider boundary. */
const GATEWAY_PLACEHOLDER = "gateway-managed";

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

interface SearchOptions {
  numResults: number;
  recencyFilter?: "day" | "week" | "month" | "year";
}

function mapping(value: unknown, provider: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`Invalid ${provider} search response.`);
  return value as Record<string, unknown>;
}

function sources(
  value: unknown,
  provider: string,
  urlField: string,
  snippetField: string,
): SearchResult[] {
  if (!Array.isArray(value)) throw new Error(`Invalid ${provider} search response.`);
  return value.map((value: unknown) => {
    const item = mapping(value, provider);
    const title = item.title;
    const url = item[urlField];
    const snippet = item[snippetField] ?? "";
    if (typeof title !== "string" || typeof url !== "string" || typeof snippet !== "string")
      throw new Error(`Invalid ${provider} search result.`);
    try {
      if (!["http:", "https:"].includes(new URL(url).protocol)) throw new Error();
    } catch {
      throw new Error(`Invalid ${provider} search result URL.`);
    }
    return { title, url, snippet };
  });
}

async function readBounded(
  response: Response,
  provider: string,
  signal: AbortSignal,
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error(`Invalid ${provider} response body.`);
  let size = 0;
  let text = "";
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) throw new Error(`${provider} response exceeds 5 MiB.`);
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

async function requestSearch(
  url: URL,
  headers: Record<string, string>,
  provider: string,
  signal: AbortSignal,
): Promise<unknown> {
  const deadline = new AbortController();
  const combined = AbortSignal.any([signal, deadline.signal]);
  const timer = setTimeout(
    () => deadline.abort(new Error("Search request timed out after 30 seconds.")),
    REQUEST_DEADLINE_MS,
  );
  try {
    combined.throwIfAborted();
    const response = await fetch(url, { headers, signal: combined, redirect: "error" });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`${provider} search request failed (HTTP ${response.status}).`);
    }
    const text = await readBounded(response, provider, combined);
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error(`Invalid ${provider} search JSON response.`);
    }
  } finally {
    clearTimeout(timer);
  }
}

async function searchBrave(
  config: WebSearchConfiguration,
  query: string,
  options: SearchOptions,
  signal: AbortSignal,
): Promise<SearchResult[]> {
  const url = new URL(config.endpoint);
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(options.numResults));
  if (options.recencyFilter)
    url.searchParams.set(
      "freshness",
      { day: "pd", week: "pw", month: "pm", year: "py" }[options.recencyFilter],
    );
  const payload = await requestSearch(
    url,
    { Accept: "application/json", "X-Subscription-Token": GATEWAY_PLACEHOLDER },
    "Brave",
    signal,
  );
  const data = mapping(payload, "Brave");
  if (data.web === undefined || data.web === null) {
    if (data.type !== "search") throw new Error("Invalid Brave search response.");
    return [];
  }
  return sources(mapping(data.web, "Brave").results, "Brave", "url", "description");
}

async function searchSerpApi(
  config: WebSearchConfiguration,
  query: string,
  options: SearchOptions,
  signal: AbortSignal,
): Promise<SearchResult[]> {
  const url = new URL(config.endpoint);
  url.searchParams.set("q", query);
  url.searchParams.set("engine", "google");
  // The gateway replaces this placeholder with the scoped provider credential.
  url.searchParams.set("api_key", GATEWAY_PLACEHOLDER);
  if (options.recencyFilter)
    url.searchParams.set(
      "tbs",
      { day: "qdr:d", week: "qdr:w", month: "qdr:m", year: "qdr:y" }[options.recencyFilter],
    );
  const payload = await requestSearch(url, { Accept: "application/json" }, "SerpApi", signal);
  const data = mapping(payload, "SerpApi");
  const metadata =
    data.search_metadata === undefined ? undefined : mapping(data.search_metadata, "SerpApi");
  const information =
    data.search_information === undefined ? undefined : mapping(data.search_information, "SerpApi");
  if (
    metadata?.status === "Success" &&
    information?.organic_results_state === "Fully empty" &&
    (data.organic_results === undefined ||
      (Array.isArray(data.organic_results) && !data.organic_results.length))
  )
    return [];
  if (data.error !== undefined || metadata?.status === "Error")
    throw new Error("SerpApi search provider error.");
  if (metadata && metadata.status !== "Success") throw new Error("Invalid SerpApi search status.");
  if (data.organic_results === undefined && metadata?.status === "Success") return [];
  return sources(data.organic_results, "SerpApi", "link", "snippet");
}

async function runBatch<T>(
  count: number,
  signal: AbortSignal,
  run: (index: number, signal: AbortSignal) => Promise<T>,
): Promise<T[]> {
  const results = new Array<T>(count);
  let next = 0;
  const workers = Array.from({ length: Math.min(MAX_CONCURRENCY, count) }, async () => {
    while (next < count) {
      signal.throwIfAborted();
      const index = next++;
      results[index] = await run(index, signal);
    }
  });
  const completed = await Promise.allSettled(workers);
  for (const worker of completed) if (worker.status === "rejected") throw worker.reason;
  return results;
}

function normalizeDomains(domains: readonly string[]): { includes: string[]; excludes: string[] } {
  const normalized = domains.map((domain) => {
    const value = domain.trim().toLowerCase().replace(/\.$/, "");
    const excluded = value.startsWith("-");
    const host = excluded ? value.slice(1) : value;
    const ascii = domainToASCII(host) || host;
    return excluded ? `-${ascii}` : ascii;
  });
  return {
    includes: normalized.filter((domain) => domain && !domain.startsWith("-")),
    excludes: normalized
      .filter((domain) => domain.startsWith("-"))
      .map((domain) => domain.slice(1)),
  };
}

const searchSchema = Type.Object(
  {
    query: Type.Optional(Type.String({ description: "The search query", minLength: 1 })),
    queries: Type.Optional(
      Type.Array(Type.String({ minLength: 1 }), {
        description: "One to five search queries",
        minItems: 1,
        maxItems: MAX_ITEMS,
      }),
    ),
    numResults: Type.Optional(
      Type.Integer({
        description: "Maximum results per query (default 5)",
        minimum: 1,
        maximum: 20,
      }),
    ),
    recencyFilter: Type.Optional(
      Type.Union(
        [Type.Literal("day"), Type.Literal("week"), Type.Literal("month"), Type.Literal("year")],
        {
          description: "Limit sources by recency",
        },
      ),
    ),
    domainFilter: Type.Optional(
      Type.Array(Type.String(), {
        description: "Include domains, or exclude domains with a leading -",
      }),
    ),
  },
  { additionalProperties: false },
);

const fetchSchema = Type.Object(
  {
    url: Type.Optional(Type.String({ description: "The URL to read" })),
    urls: Type.Optional(
      Type.Array(Type.String(), {
        description: "One to five URLs to read",
        minItems: 1,
        maxItems: MAX_ITEMS,
      }),
    ),
    offset: Type.Optional(
      Type.Integer({ description: "Zero-based character offset (default 0)", minimum: 0 }),
    ),
    limit: Type.Optional(
      Type.Integer({
        description: "Maximum characters per URL (default 10000)",
        minimum: 1,
        maximum: MAX_LIMIT,
      }),
    ),
  },
  { additionalProperties: false },
);

function exclusive(args: Record<string, unknown>, names: [string, string]): unknown[] {
  const [single, many] = names;
  const one = args[single];
  const list = args[many];
  if ((one === undefined) === (list === undefined))
    throw new Error(`Provide either ${single} or ${many}, exclusively.`);
  return one === undefined ? (list as unknown[]) : [one];
}

interface ContentResult {
  url: string;
  finalUrl: string | null;
  title: string;
  content: string;
  error: string | null;
  totalChars: number;
  nextOffset: number | null;
}

function concat(chunks: Uint8Array[]): Uint8Array {
  let size = 0;
  for (const chunk of chunks) size += chunk.byteLength;
  const merged = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

function extractHtml(
  html: Uint8Array,
  url: string,
  contentType: string,
): { title: string; content: string } {
  const dom = new JSDOM(html, { url, contentType });
  try {
    const document = dom.window.document;
    const title = document.title;
    document
      .querySelectorAll("script, style, template, noscript, [hidden], [aria-hidden='true' i]")
      .forEach((element) => {
        element.remove();
      });
    const style = document.createElement("div").style;
    for (const element of document.querySelectorAll("[style]")) {
      style.cssText = (element.getAttribute("style") ?? "").toLowerCase();
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        style.visibility === "collapse"
      )
        element.remove();
    }
    for (const link of document.querySelectorAll<HTMLAnchorElement>("a[href]"))
      link.setAttribute("href", link.href);
    for (const image of document.querySelectorAll<HTMLImageElement>("img[src]"))
      image.setAttribute("src", image.src);
    const article = new Readability(document.cloneNode(true) as Document).parse();
    const markdown = new TurndownService({
      headingStyle: "atx",
      codeBlockStyle: "fenced",
      bulletListMarker: "-",
    });
    const content =
      (article?.content ? markdown.turndown(article.content) : "") ||
      markdown.turndown(document.body.innerHTML);
    if (!content.trim()) throw new Error("Content extraction produced no readable text.");
    return { title, content };
  } finally {
    dom.window.close();
  }
}

async function fetchContent(
  url: string,
  offset: number,
  limit: number,
  signal: AbortSignal,
): Promise<ContentResult> {
  let finalUrl: string | null = null;
  const deadline = new AbortController();
  const combined = AbortSignal.any([signal, deadline.signal]);
  const timer = setTimeout(
    () => deadline.abort(new Error("Content request timed out after 30 seconds.")),
    REQUEST_DEADLINE_MS,
  );
  try {
    combined.throwIfAborted();
    let parsed: URL;
    try {
      parsed = new URL(url);
      if (!/^https?:\/\/[^/]/i.test(url) || !["http:", "https:"].includes(parsed.protocol))
        throw new Error();
    } catch {
      throw new Error("Content URL must be an absolute HTTP(S) URL.");
    }
    const response = await fetch(parsed, { signal: combined, redirect: "follow" });
    finalUrl = response.url;
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Content request failed (HTTP ${response.status}).`);
    }
    const contentType = response.headers.get("content-type") ?? "";
    const type = contentType.split(";")[0].trim().toLowerCase();
    if (
      ![
        "text/html",
        "application/xhtml+xml",
        "text/markdown",
        "text/x-markdown",
        "text/plain",
      ].includes(type)
    ) {
      await response.body?.cancel();
      throw new Error(`Unsupported content type: ${type || "missing"}.`);
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Invalid content response body.");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        combined.throwIfAborted();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BODY_BYTES) throw new Error("Content response exceeds 5 MiB.");
        chunks.push(value);
      }
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      throw error;
    } finally {
      reader.releaseLock();
    }
    const body = concat(chunks);
    const { title, content } =
      type === "text/html" || type === "application/xhtml+xml"
        ? extractHtml(body, finalUrl, contentType)
        : {
            title: "",
            content: new TextDecoder(
              /charset\s*=\s*["']?([^;\s"']+)/i.exec(contentType)?.[1] ?? "utf-8",
            ).decode(body),
          };
    const characters = Array.from(content);
    const chunk = characters.slice(offset, offset + limit).join("");
    const nextOffset = offset + Array.from(chunk).length;
    return {
      url,
      finalUrl,
      title,
      content: chunk,
      error: null,
      totalChars: characters.length,
      nextOffset: nextOffset < characters.length ? nextOffset : null,
    };
  } catch (error) {
    signal.throwIfAborted();
    const reason: unknown = combined.aborted && !signal.aborted ? combined.reason : error;
    return {
      url,
      finalUrl,
      title: "",
      content: "",
      error: reason instanceof Error ? reason.message : String(reason),
      totalChars: 0,
      nextOffset: null,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Build the Pi custom tools for the explicitly configured web operations. */
export function createWebTools(config: WebConfiguration | undefined): ToolDefinition[] {
  const tools: ToolDefinition[] = [];
  if (config?.search) {
    const search = config.search;
    tools.push(
      defineTool({
        name: "web_search",
        label: "Web Search",
        description:
          "Search one to five queries with the configured provider. Returns JSON queries in input order with title/url/snippet sources and per-query errors. numResults is an upper bound (default 5); domain exclusions win and include subdomains.",
        parameters: searchSchema,
        annotations: { readOnlyHint: true, openWorldHint: true },
        async execute(_toolCallId, params, signal) {
          const abort = signal ?? new AbortController().signal;
          const queries = exclusive(params as Record<string, unknown>, ["query", "queries"]).map(
            (value) => {
              if (typeof value !== "string" || !value.trim())
                throw new Error("Search queries must be non-empty strings.");
              return value;
            },
          );
          const { includes, excludes } = normalizeDomains(params.domainFilter ?? []);
          const numResults = params.numResults ?? DEFAULT_NUM_RESULTS;
          const operators = [
            includes.length ? `(${includes.map((domain) => `site:${domain}`).join(" OR ")})` : "",
            ...excludes.map((domain) => `-site:${domain}`),
          ]
            .filter(Boolean)
            .join(" ");
          const runSearch = search.provider === "brave" ? searchBrave : searchSerpApi;
          const items = await runBatch(queries.length, abort, async (index, itemSignal) => {
            const query = queries[index] as string;
            try {
              const found = await runSearch(
                search,
                operators ? `${query} ${operators}` : query,
                { numResults, recencyFilter: params.recencyFilter },
                itemSignal,
              );
              itemSignal.throwIfAborted();
              const results = found
                .filter((source) => {
                  const host = new URL(source.url).hostname.toLowerCase().replace(/\.$/, "");
                  const matches = (domain: string) =>
                    host === domain || host.endsWith(`.${domain}`);
                  return !excludes.some(matches) && (!includes.length || includes.some(matches));
                })
                .slice(0, numResults);
              return { query, provider: search.provider, results, error: null };
            } catch (error) {
              itemSignal.throwIfAborted();
              return {
                query,
                provider: search.provider,
                results: [] as SearchResult[],
                error: error instanceof Error ? error.message : String(error),
              };
            }
          });
          abort.throwIfAborted();
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ queries: items }) }],
            details: { queries: items.length },
          };
        },
      }),
    );
  }
  if (config?.fetch === true) {
    tools.push(
      defineTool({
        name: "fetch_content",
        label: "Fetch Content",
        description:
          "Read and extract content from a web page. Returns ordered JSON results with readable content, final URLs, and Unicode character pagination. Continuations fetch and extract again; changing pages can produce inconsistent text between calls.",
        parameters: fetchSchema,
        annotations: { readOnlyHint: true, openWorldHint: true },
        async execute(_toolCallId, params, signal) {
          const abort = signal ?? new AbortController().signal;
          const urls = exclusive(params as Record<string, unknown>, ["url", "urls"]).map(
            (value) => {
              if (typeof value !== "string" || !value.trim())
                throw new Error("Content URLs must be non-empty strings.");
              return value;
            },
          );
          const results = await runBatch(urls.length, abort, (index, itemSignal) =>
            fetchContent(
              urls[index] as string,
              params.offset ?? 0,
              params.limit ?? DEFAULT_LIMIT,
              itemSignal,
            ),
          );
          abort.throwIfAborted();
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ urls: results }) }],
            details: { urls: results.length },
          };
        },
      }),
    );
  }
  return tools;
}
