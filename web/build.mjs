/**
 * Builds the game into one self-contained page: dist/play.html (a full HTML document) and
 * dist/artifact.html (the same page without the document wrapper, for hosts that add it).
 *
 * Usage (from web/): npm run build
 */
import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const result = await build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  format: "iife",
  target: "es2022",
  minify: true,
  write: false,
});
const js = result.outputFiles[0].text.replaceAll("</script", "<\\/script");
const page = (await readFile("src/page.html", "utf8")).replace("<!-- APP -->", `<script>${js}</script>`);
const doc = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
</head>
<body>
${page}
</body>
</html>
`;
await mkdir("dist", { recursive: true });
await writeFile("dist/artifact.html", page);
await writeFile("dist/play.html", doc);
console.log(`dist/play.html: ${(doc.length / 1024).toFixed(0)} KB`);
