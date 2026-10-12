import type { WebSearchSettings } from "../config/workspace.ts";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

function mapping(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid Brave search response.");
  return value as Record<string, unknown>;
}

function field(item: Record<string, unknown>, name: string): string {
  const value = item[name] ?? "";
  if (typeof value !== "string") throw new Error("Invalid Brave search result.");
  return value;
}

export async function searchBrave(
  config: WebSearchSettings,
  query: string,
  signal?: AbortSignal,
): Promise<SearchResult[]> {
  const url = new URL(config.api_base ?? "https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", "10");
  const timeout = AbortSignal.timeout(30_000);
  const response = await fetch(url, {
    headers: { Accept: "application/json", "X-Subscription-Token": config.api_key },
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    redirect: "error",
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Brave search request failed (HTTP ${response.status}).`);
  }
  const data = mapping(await response.json());
  const results = data.web === undefined ? [] : (mapping(data.web).results ?? []);
  if (!Array.isArray(results)) throw new Error("Invalid Brave search response.");
  return results.map((value: unknown) => {
    const item = mapping(value);
    return {
      title: field(item, "title"),
      url: field(item, "url"),
      snippet: field(item, "description"),
    };
  });
}
