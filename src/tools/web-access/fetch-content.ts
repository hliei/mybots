import type { Tool } from "../toolbox.ts";
import { readPage } from "./rendered-page.ts";

export interface FetchContentArguments {
  url?: string;
  urls?: string[];
  offset?: number;
  limit?: number;
}

export function createFetchContentTool(): Tool<FetchContentArguments> {
  return {
    name: "fetch_content",
    description:
      "Read and extract content from a web page. Returns the page content as markdown. Continuations fetch and extract again; changing pages can produce inconsistent text between calls.",
    arguments: [
      { name: "url", description: "The URL to read", type: "string", optional: true },
      {
        name: "urls",
        description: "One to five URLs to read",
        type: "array",
        optional: true,
        minItems: 1,
        maxItems: 5,
      },
      {
        name: "offset",
        description: "Zero-based character offset (default 0)",
        type: "integer",
        optional: true,
        minimum: 0,
      },
      {
        name: "limit",
        description: "Maximum characters per URL (default 10000)",
        type: "integer",
        optional: true,
        minimum: 1,
        maximum: 20_000,
      },
    ],
    exclusiveArguments: ["url", "urls"],
    strictArguments: true,
    async execute(args, { signal }) {
      // Preserve the rendered single-page path until the HTTP extraction slice.
      const { url } = args;
      if (url === undefined || args.offset !== undefined || args.limit !== undefined)
        throw new Error("This content fetching input is not supported yet.");
      const result = await readPage(url, signal);
      if (result.error) return `Error reading ${result.url}: ${result.error}`;
      return `**${result.title}**\n\n${result.content}`;
    },
  };
}
