import type { WebSearchSettings } from "../../config/workspace.ts";
import type { Tool } from "../toolbox.ts";
import { searchBrave } from "./brave.ts";

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
      "Search the web for information. Returns a list of results with titles, URLs, and snippets.",
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
      // Preserve the existing single-query path until the search execution slice.
      const query = args.query ?? (args.queries?.length === 1 ? args.queries[0] : undefined);
      if (
        config.provider !== "brave" ||
        query === undefined ||
        args.numResults !== undefined ||
        args.recencyFilter !== undefined ||
        args.domainFilter !== undefined
      )
        throw new Error("This search provider or input is not supported yet.");
      const results = await searchBrave(config, query, signal);
      if (!results.length) return "No results found.";
      return results
        .map(
          (result, index) =>
            `${index + 1}. **${result.title}**\n   ${result.url}\n   ${result.snippet}`,
        )
        .join("\n\n");
    },
  };
}
