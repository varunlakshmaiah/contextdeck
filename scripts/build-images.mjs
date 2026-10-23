// Renders plugin/action artwork to PNG at the sizes Stream Deck expects.
import { Resvg } from "@resvg/resvg-js";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const P = "com.var.contextdeck.sdPlugin/imgs";
const ORANGE = "#F97316";

// Brand mark: Stream Deck+ silhouette — 4x2 keys (one lit) above 4 dials.
const mark = (fg, lit, bg) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
${bg ? `<rect width="64" height="64" rx="14" fill="${bg}"/>` : ""}
<g fill="${fg}">
${[0, 1, 2, 3].map((c) => [0, 1].map((r) => `<rect x="${9 + c * 12}" y="${12 + r * 12}" width="10" height="10" rx="2.5" ${c === 2 && r === 0 ? `fill="${lit}"` : ""}/>`).join("")).join("")}
${[0, 1, 2, 3].map((c) => `<circle cx="${14 + c * 12}" cy="${47}" r="4.5"/>`).join("")}
</g></svg>`;

const dialMark = (fg) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><g fill="none" stroke="${fg}" stroke-width="5" stroke-linecap="round"><path d="M16 46a20 20 0 1 1 32 0"/><path d="M32 32 42 22"/></g></svg>`;
const keyMark = (fg) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><g fill="none" stroke="${fg}" stroke-width="5" stroke-linejoin="round"><rect x="10" y="10" width="44" height="44" rx="9"/><path d="M22 34l7 7 13-16" stroke-linecap="round"/></g></svg>`;

function png(svg, size, file) {
	const out = new Resvg(svg, { fitTo: { mode: "width", value: size } }).render().asPng();
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, out);
}
const pair = (svg, size, base) => { png(svg, size, `${base}.png`); png(svg, size * 2, `${base}@2x.png`); };

pair(mark("#E4E4E7", ORANGE, "#18181B"), 288, `${P}/plugin/marketplace`);
pair(mark("#FFFFFF", "#FFFFFF"), 28, `${P}/plugin/category-icon`);
pair(keyMark("#FFFFFF"), 20, `${P}/actions/key/icon`);
pair(mark("#3F3F46", ORANGE, "#111113"), 72, `${P}/actions/key/key`);
pair(dialMark("#FFFFFF"), 20, `${P}/actions/dial/icon`);
pair(dialMark(ORANGE), 72, `${P}/actions/dial/key`);
console.log("images written");
