import { copyFile, mkdir } from "node:fs/promises";

for (const file of ["index.html", "style.css"]) {
  await copyFile(new URL(`src/${file}`, import.meta.url), new URL(`dist/${file}`, import.meta.url));
}

await mkdir(new URL("dist/vendor/", import.meta.url), { recursive: true });
await copyFile(
  new URL(import.meta.resolve("marked")),
  new URL("dist/vendor/marked.js", import.meta.url),
);
