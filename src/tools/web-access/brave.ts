import type { WebSearchSettings } from "../../config/workspace.ts";

import {
  mapping,
  requestSearch,
  type SearchOptions,
  type SearchResult,
  sources,
} from "./search-request.ts";

export async function searchBrave(
  config: WebSearchSettings,
  query: string,
  options: SearchOptions,
  signal?: AbortSignal,
): Promise<SearchResult[]> {
  const url = new URL(config.api_base ?? "https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(options.numResults));
  if (options.recencyFilter)
    url.searchParams.set(
      "freshness",
      { day: "pd", week: "pw", month: "pm", year: "py" }[options.recencyFilter],
    );
  const payload = await requestSearch(
    url,
    { Accept: "application/json", "X-Subscription-Token": config.api_key },
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
