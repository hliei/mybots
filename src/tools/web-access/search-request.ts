export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchOptions {
  numResults: number;
  recencyFilter?: "day" | "week" | "month" | "year";
}

export function mapping(value: unknown, provider: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`Invalid ${provider} search response.`);
  return value as Record<string, unknown>;
}

export function sources(
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

export async function requestSearch(
  url: URL,
  headers: Record<string, string>,
  provider: string,
  signal?: AbortSignal,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error("Search request timed out after 30 seconds.")),
    30_000,
  );
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  try {
    combined.throwIfAborted();
    const response = await fetch(url, { headers, signal: combined, redirect: "error" });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`${provider} search request failed (HTTP ${response.status}).`);
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error(`Invalid ${provider} search response body.`);
    let size = 0;
    let text = "";
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        combined.throwIfAborted();
        if (done) break;
        size += value.byteLength;
        if (size > 5_242_880) {
          controller.abort(new Error("Search response body exceeds 5 MiB."));
          combined.throwIfAborted();
        }
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      throw error;
    } finally {
      reader.releaseLock();
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error(`Invalid ${provider} search JSON response.`);
    }
  } catch (error) {
    combined.throwIfAborted();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
