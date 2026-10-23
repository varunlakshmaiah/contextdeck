// Builds com.var.contextdeck.sdPlugin/icons.json: { "scissors": "<circle .../>..." } from lucide-static (ISC).
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

const dir = join(createRequire(import.meta.url).resolve("lucide-static/package.json"), "..", "icons");
const out = {};
for (const f of readdirSync(dir)) {
	if (!f.endsWith(".svg")) continue;
	const src = readFileSync(join(dir, f), "utf8");
	const inner = src.replace(/<!--[\s\S]*?-->/g, "").replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "").replace(/\s*\n\s*/g, "").trim();
	out[f.slice(0, -4)] = inner;
}
writeFileSync("com.var.contextdeck.sdPlugin/icons.json", JSON.stringify(out));
console.log(`icons.json: ${Object.keys(out).length} icons`);
