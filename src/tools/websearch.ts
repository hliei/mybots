import type { WebSearchSettings } from "../config/workspace.ts";
import { searchBrave } from "../providers/brave.ts";
import type { Tool } from "./toolbox.ts";

export function createWebSearchTool(config: WebSearchSettings): Tool {
  return {
    name: "websearch",
    description:
      "Search the web for information. Returns a list of results with titles, URLs, and snippets.",
    arguments: [{ name: "query", description: "The search query" }],
    async execute({ query }, { signal }) {
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
