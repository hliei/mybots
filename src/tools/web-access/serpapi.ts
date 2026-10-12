import type { WebSearchSettings } from "../../config/workspace.ts";
import {
  mapping,
  requestSearch,
  type SearchOptions,
  type SearchResult,
  sources,
} from "./search-request.ts";

export async function searchSerpApi(
  config: WebSearchSettings,
  query: string,
  options: SearchOptions,
  signal?: AbortSignal,
): Promise<SearchResult[]> {
  const url = new URL(config.api_base ?? "https://serpapi.com/search");
  url.searchParams.set("q", query);
  url.searchParams.set("engine", "google");
  url.searchParams.set("api_key", config.api_key);
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
