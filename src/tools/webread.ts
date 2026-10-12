import { readPage } from "../providers/webread.ts";
import type { Tool } from "./toolbox.ts";

export function createWebReadTool(): Tool {
  return {
    name: "webread",
    description: "Read and extract content from a web page. Returns the page content as markdown.",
    arguments: [{ name: "url", description: "The URL to read" }],
    async execute({ url }, { signal }) {
      const result = await readPage(url, signal);
      if (result.error) return `Error reading ${result.url}: ${result.error}`;
      return `**${result.title}**\n\n${result.content}`;
    },
  };
}
