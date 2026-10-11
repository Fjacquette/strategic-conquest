/**
 * Builds the game into one self-contained page: dist/play.html (a full HTML document) and
 * dist/artifact.html (the same page without the document wrapper, for hosts that add it).
 *
 * The original game's artwork, sounds and words are embedded from assets/original/, which
 * tools/assets/extract_assets.py writes from the owner's copy. A page built with them holds
 * the owner's copy of those assets and is for the owner's own use.
 *
 * Usage (from web/): npm run build
 */
import { build } from "esbuild";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";

async function originalAssets() {
  const dir = "assets/original";
  if (!existsSync(`${dir}/assets.json`)) return null;
  const data = JSON.parse(await readFile(`${dir}/assets.json`, "utf8"));
  data.sounds = {};
  for (const f of await readdir(dir)) {
    if (!f.endsWith(".wav")) continue;
    data.sounds[f.slice(0, -4)] = `data:audio/wav;base64,${(await readFile(`${dir}/${f}`)).toString("base64")}`;
  }
  return data;
}

const result = await build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  format: "iife",
  target: "es2022",
  minify: true,
  write: false,
});
const js = result.outputFiles[0].text.replaceAll("</script", "<\\/script");
const found = await originalAssets();
const assetScript = found ? `<script>window.SC_ASSETS=${JSON.stringify(found).replaceAll("</", "<\\/")};</script>\n` : "";
if (!found) console.warn("assets/original/ not found: the page will ask for the original assets");
const page = (await readFile("src/page.html", "utf8")).replace("<!-- APP -->", `${assetScript}<script>${js}</script>`);
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
