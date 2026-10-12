import type { WebSearchSettings } from "../../config/workspace.ts";
import type { Tool } from "../toolbox.ts";
import { searchBrave } from "./brave.ts";
import type { SearchResult } from "./search-request.ts";
import { searchSerpApi } from "./serpapi.ts";

export interface WebSearchArguments {
  query?: string;
  queries?: string[];
  numResults?: number;
  recencyFilter?: "day" | "week" | "month" | "year";
  domainFilter?: string[];
}

export function createWebSearchTool(config: WebSearchSettings): Tool<WebSearchArguments> {
  return {
    name: "web_search",
    description:
      "Search one to five queries with the workspace-selected provider. Returns JSON queries in input order with title/url/snippet sources and per-query errors. numResults is an upper bound (default 5); domain exclusions win and include subdomains.",
    arguments: [
      {
        name: "query",
        description: "The search query",
        type: "string",
        optional: true,
        nonempty: true,
      },
      {
        name: "queries",
        description: "One to five search queries",
        type: "array",
        optional: true,
        nonempty: true,
        minItems: 1,
        maxItems: 5,
      },
      {
        name: "numResults",
        description: "Maximum results per query (default 5)",
        type: "integer",
        optional: true,
        minimum: 1,
        maximum: 20,
      },
      {
        name: "recencyFilter",
        description: "Limit sources by recency",
        type: "string",
        optional: true,
        enum: ["day", "week", "month", "year"],
      },
      {
        name: "domainFilter",
        description: "Include domains or exclude domains with a leading -",
        type: "array",
        optional: true,
      },
    ],
    exclusiveArguments: ["query", "queries"],
    strictArguments: true,
    async execute(args, { signal }) {
      const queries = args.queries ?? [args.query as string];
      const domains = (args.domainFilter ?? []).map((domain) =>
        domain.trim().toLowerCase().replace(/\.$/, ""),
      );
      const includes = domains.filter((domain) => domain && !domain.startsWith("-"));
      const excludes = domains
        .filter((domain) => domain.startsWith("-"))
        .map((domain) => domain.slice(1));
      const operators = [
        includes.length ? `(${includes.map((domain) => `site:${domain}`).join(" OR ")})` : "",
        ...excludes.map((domain) => `-site:${domain}`),
      ]
        .filter(Boolean)
        .join(" ");
      const search = config.provider === "brave" ? searchBrave : searchSerpApi;
      const numResults = args.numResults ?? 5;
      const items = new Array<{
        query: string;
        provider: WebSearchSettings["provider"];
        results: SearchResult[];
        error: string | null;
      }>(queries.length);
      let next = 0;
      async function worker() {
        while (next < queries.length) {
          signal?.throwIfAborted();
          const index = next++;
          const query = queries[index] as string;
          try {
            const sources = await search(
              config,
              operators ? `${query} ${operators}` : query,
              { numResults, recencyFilter: args.recencyFilter },
              signal,
            );
            signal?.throwIfAborted();
            const results = sources
              .filter((source) => {
                const host = new URL(source.url).hostname.toLowerCase().replace(/\.$/, "");
                const matches = (domain: string) => host === domain || host.endsWith(`.${domain}`);
                return !excludes.some(matches) && (!includes.length || includes.some(matches));
              })
              .slice(0, numResults);
            items[index] = { query, provider: config.provider, results, error: null };
          } catch (error) {
            signal?.throwIfAborted();
            items[index] = {
              query,
              provider: config.provider,
              results: [],
              error: error instanceof Error ? error.message : String(error),
            };
          }
        }
      }
      const executions = await Promise.allSettled(
        Array.from({ length: Math.min(3, queries.length) }, worker),
      );
      signal?.throwIfAborted();
      const failure = executions.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
      return JSON.stringify({ queries: items });
    },
  };
}
