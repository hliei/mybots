import { lexer, type MarkedToken, type Token, walkTokens } from "./vendor/marked.js";

export function copyButton(label: string, read: () => string | Promise<string>): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.addEventListener("click", async () => {
    button.disabled = true;
    const status = document.createElement("span");
    status.className = "copy-status";
    status.setAttribute("role", "status");
    button.after(status);
    try {
      await navigator.clipboard.writeText(await read());
      status.textContent = "Copied";
    } catch {
      status.textContent = "Copy failed. Try again.";
    } finally {
      button.disabled = false;
      window.setTimeout(() => status.remove(), 3000);
    }
  });
  return button;
}

/** Only lexer tokens are consumed; message text is never parsed as HTML. */
function render(
  tokens: Token[],
  parent: HTMLElement,
  codeCopies: Map<Token, () => string | Promise<string>>,
): void {
  for (const token of tokens as MarkedToken[]) {
    switch (token.type) {
      case "space":
      case "def":
        break;
      case "paragraph":
      case "strong":
      case "em":
      case "del":
      case "blockquote":
      case "heading": {
        const tag = {
          paragraph: "p",
          strong: "strong",
          em: "em",
          del: "del",
          blockquote: "blockquote",
          heading: "h3",
        }[token.type];
        const element = document.createElement(tag);
        render(token.tokens, element, codeCopies);
        parent.append(element);
        break;
      }
      case "text":
        if (token.tokens) render(token.tokens, parent, codeCopies);
        else parent.append(document.createTextNode(token.text));
        break;
      case "html":
      case "escape":
        parent.append(document.createTextNode(token.text));
        break;
      case "image":
        parent.append(document.createTextNode(token.text));
        break;
      case "link": {
        // An explicit allowlist also rejects relative and protocol-relative destinations.
        if (/^(https?:|mailto:)/i.test(token.href)) {
          const link = document.createElement("a");
          link.href = token.href;
          link.rel = "noreferrer noopener";
          render(token.tokens, link, codeCopies);
          parent.append(link);
        } else render(token.tokens, parent, codeCopies);
        break;
      }
      case "codespan": {
        const code = document.createElement("code");
        code.textContent = token.text;
        parent.append(code);
        break;
      }
      case "code": {
        const block = document.createElement("div");
        block.className = "code-block";
        const header = document.createElement("div");
        header.className = "code-header";
        const language = document.createElement("span");
        language.textContent = token.lang ?? "Code";
        header.append(
          language,
          copyButton("Copy code", codeCopies.get(token) ?? (() => token.text)),
        );
        const pre = document.createElement("pre");
        pre.tabIndex = 0;
        pre.setAttribute("aria-label", "Code block");
        const code = document.createElement("code");
        code.textContent = token.text;
        pre.append(code);
        block.append(header, pre);
        parent.append(block);
        break;
      }
      case "list": {
        const list = document.createElement(token.ordered ? "ol" : "ul");
        if (token.ordered && token.start !== "") list.setAttribute("start", String(token.start));
        for (const item of token.items) {
          const li = document.createElement("li");
          render(item.tokens, li, codeCopies);
          list.append(li);
        }
        parent.append(list);
        break;
      }
      case "table": {
        const region = document.createElement("div");
        region.className = "table-region";
        region.tabIndex = 0;
        region.setAttribute("role", "region");
        region.setAttribute("aria-label", "Message table");
        const table = document.createElement("table");
        for (const [index, cells] of [token.header, ...token.rows].entries()) {
          const section = document.createElement(index === 0 ? "thead" : "tbody");
          const row = document.createElement("tr");
          for (const cell of cells) {
            const element = document.createElement(index === 0 ? "th" : "td");
            render(cell.tokens, element, codeCopies);
            row.append(element);
          }
          section.append(row);
          table.append(section);
        }
        region.append(table);
        parent.append(region);
        break;
      }
      case "br":
      case "hr":
        parent.append(document.createElement(token.type));
        break;
      default:
        parent.append(document.createTextNode(token.raw));
    }
  }
}

export function markdown(text: string, readOriginal: () => Promise<string>): HTMLElement {
  const content = document.createElement("div");
  content.className = "message-content";
  const tokens = lexer(text, { gfm: true });
  const codeCopies = new Map<Token, () => Promise<string>>();
  walkTokens(tokens, (token) => {
    if (token.type !== "code") return;
    const index = codeCopies.size;
    codeCopies.set(token, async () => {
      const blocks: string[] = [];
      walkTokens(lexer(await readOriginal(), { gfm: true }), (original) => {
        if (original.type === "code") blocks.push(original.text);
      });
      const block = blocks[index];
      if (block === undefined) throw new Error("Code unavailable.");
      return block;
    });
  });
  render(tokens, content, codeCopies);
  return content;
}
