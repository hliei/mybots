import type { Browser } from "playwright";
import { chromium } from "playwright";
import TurndownService from "turndown";

export interface ReadResult {
  url: string;
  title: string;
  content: string;
  error: string | null;
}

export async function readPage(url: string, signal?: AbortSignal): Promise<ReadResult> {
  const deadline = new AbortController();
  const combined = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
  let browser: Browser | undefined;
  let closing: Promise<void> | undefined;
  const abort = () => {
    closing = browser?.close();
    // Cleanup is awaited below; prevent rejection before the pending operation settles.
    closing?.catch(() => {});
  };
  const timer = setTimeout(
    () => deadline.abort(new Error("Page read timed out after 30 seconds.")),
    30_000,
  );
  combined.addEventListener("abort", abort, { once: true });
  try {
    try {
      combined.throwIfAborted();
      if (!["http:", "https:"].includes(new URL(url).protocol))
        throw new Error("Page URL must use HTTP(S).");
      browser = await chromium.launch({ timeout: 30_000 });
      combined.throwIfAborted();
      const page = await browser.newPage({ serviceWorkers: "block" });
      const response = await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });
      if (response && response.status() >= 400)
        throw new Error(`Page request failed (HTTP ${response.status()}).`);
      const snapshot = await page.evaluate(() => {
        const hidden = [...document.body.querySelectorAll("*")].filter((element) => {
          const style = getComputedStyle(element);
          return style.display === "none" || style.visibility === "hidden";
        });
        hidden.forEach((element) => {
          element.remove();
        });
        document
          .querySelectorAll("script, style, noscript, template, [hidden]")
          .forEach((element) => {
            element.remove();
          });
        for (const link of document.body.querySelectorAll<HTMLAnchorElement>("a[href]"))
          link.setAttribute("href", link.href);
        for (const image of document.body.querySelectorAll<HTMLImageElement>("img[src]"))
          image.setAttribute("src", image.src);
        return { title: document.title, html: document.body.innerHTML };
      });
      combined.throwIfAborted();
      const markdown = new TurndownService({
        headingStyle: "atx",
        codeBlockStyle: "fenced",
        bulletListMarker: "-",
      });
      return { url, title: snapshot.title, content: markdown.turndown(snapshot.html), error: null };
    } finally {
      clearTimeout(timer);
      combined.removeEventListener("abort", abort);
      await (closing ?? browser?.close());
    }
  } catch (error) {
    const reason: unknown = combined.aborted ? combined.reason : error;
    return {
      url,
      title: "",
      content: "",
      error: reason instanceof Error ? reason.message : String(reason),
    };
  }
}
