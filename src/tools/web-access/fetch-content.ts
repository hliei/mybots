import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import TurndownService from "turndown";
import type { Tool } from "../toolbox.ts";

export interface FetchContentArguments {
  url?: string;
  urls?: string[];
  offset?: number;
  limit?: number;
}

function extractHtml(
  html: Buffer,
  url: string,
  contentType: string,
): { title: string; content: string } {
  const dom = new JSDOM(html, { url, contentType });
  try {
    const document = dom.window.document;
    const title = document.title;
    document
      .querySelectorAll("script, style, template, noscript, [hidden], [aria-hidden='true']")
      .forEach((element) => {
        element.remove();
      });
    const style = document.createElement("div").style;
    for (const element of document.querySelectorAll("[style]")) {
      style.cssText = element.getAttribute("style") ?? "";
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

interface ContentResult {
  url: string;
  finalUrl: string | null;
  title: string;
  content: string;
  error: string | null;
  totalChars: number;
  nextOffset: number | null;
}

async function readBody(response: Response): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 5_242_880) throw new Error("Content response exceeds 5 MiB.");
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

async function readContent(
  url: string,
  offset: number,
  limit: number,
  signal?: AbortSignal,
): Promise<ContentResult> {
  let finalUrl: string | null = null;
  const deadline = new AbortController();
  const combined = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
  const timer = setTimeout(
    () => deadline.abort(new Error("Content request timed out after 30 seconds.")),
    30_000,
  );
  try {
    combined.throwIfAborted();
    let parsed: URL;
    try {
      parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error();
    } catch {
      throw new Error("Content URL must be an absolute HTTP(S) URL.");
    }
    const response = await fetch(parsed, { signal: combined });
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
    const body = await readBody(response);
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
    signal?.throwIfAborted();
    const reason: unknown = combined.aborted ? combined.reason : error;
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

export function createFetchContentTool(): Tool<FetchContentArguments> {
  return {
    name: "fetch_content",
    description:
      "Read and extract content from a web page. Returns ordered JSON results with readable content, final URLs, and Unicode character pagination. Continuations fetch and extract again; changing pages can produce inconsistent text between calls.",
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
      const urls = args.urls ?? [args.url as string];
      const results = new Array<ContentResult>(urls.length);
      let next = 0;
      const workers = Array.from({ length: Math.min(3, urls.length) }, async () => {
        while (next < urls.length) {
          signal?.throwIfAborted();
          const index = next++;
          results[index] = await readContent(
            urls[index],
            args.offset ?? 0,
            args.limit ?? 10_000,
            signal,
          );
        }
      });
      const completed = await Promise.allSettled(workers);
      for (const worker of completed) if (worker.status === "rejected") throw worker.reason;
      return JSON.stringify({ urls: results });
    },
  };
}
