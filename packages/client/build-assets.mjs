import { copyFile } from "node:fs/promises";

for (const file of ["index.html", "style.css"]) {
  await copyFile(new URL(`src/${file}`, import.meta.url), new URL(`dist/${file}`, import.meta.url));
}
