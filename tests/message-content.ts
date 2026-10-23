export const codeOriginal = 'const greeting = "Hello <world>";\nconsole.log(greeting);';
export const markdownOriginal = [
  "Original evidence recovered",
  "First **bold** paragraph with *emphasis* and `inline <code>`.",
  "Second paragraph with [documentation](https://example.com/docs).",
  "- First item\n- Second item\n  - Nested item",
  "3. Third step\n4. Fourth step",
  "| Name | Value |\n| --- | --- |\n| Setting | Enabled |",
  `\`\`\`js\n${codeOriginal}\n\`\`\``,
  "<script>globalThis.markdownExecuted = true</script>",
  '<img src="https://example.com/raw-image" onerror="globalThis.markdownExecuted=true">',
  "[unsafe](javascript:alert%281%29) [data](data:text/html,boom) [local](file:///etc/passwd)",
  "![remote image](https://example.com/markdown-image)",
  '<iframe src="https://example.com/embed"></iframe>',
].join("\n\n");
export const longCodeOriginal = "LongCodeLine\n".repeat(320).trimEnd();
export const longOriginal = `Long original begins 🪐\n\n${"UnbrokenFilename".repeat(40)}\n\n\`\`\`text\n${longCodeOriginal}\n\`\`\`\n\nLong original ends 🪐`;
export const wideOriginal = [
  "Wide content",
  `| ${Array.from({ length: 15 }, (_, index) => `Column ${index}`).join(" | ")} |`,
  `| ${Array.from({ length: 15 }, () => "---").join(" | ")} |`,
  `| ${Array.from({ length: 15 }, () => "Value").join(" | ")} |`,
  "",
  `\`\`\`text\n${"LongCodeLine".repeat(40)}\n\`\`\``,
].join("\n");
