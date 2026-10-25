import { copyFile, mkdir } from "node:fs/promises";

await copyFile(
  new URL("src/index.html", import.meta.url),
  new URL("dist/index.html", import.meta.url),
);
await copyFile(
  new URL("src/style.css", import.meta.url),
  new URL("dist/style.css", import.meta.url),
);
await mkdir(new URL("dist/vendor/", import.meta.url), { recursive: true });
await copyFile(
  new URL(import.meta.resolve("marked")),
  new URL("dist/vendor/marked.js", import.meta.url),
);
