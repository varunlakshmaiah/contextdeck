// Renders the deck for a few contexts (from a config folder) into one PNG.
import { Resvg } from "@resvg/resvg-js";
import { writeFileSync } from "node:fs";
import { loadConfig } from "../src/config";
import { Engine } from "../src/engine";
import { loadIcons } from "../src/render";
import { memoryStore } from "../src/secrets";

const [, , cfgDir, out] = process.argv;
loadIcons("com.var.contextdeck.sdPlugin/icons.json");
const { config } = loadConfig(`${cfgDir}/config.json`, `${cfgDir}/layouts`);
const opts = { font: { loadSystemFonts: true, defaultFontFamily: "DejaVu Sans" } };
const raster = (dataUrl: string) => `data:image/png;base64,${new Resvg(Buffer.from(dataUrl.split(",")[1], "base64").toString(), opts).render().asPng().toString("base64")}`;
const scenes: { title: string; setup: (e: Engine) => Promise<void> | void }[] = [
	{ title: "YouTube in Brave · page 1 (site + browser + system)", setup: (e) => e.updateContext({ bundleId: "com.brave.Browser", app: "Brave", url: "https://www.youtube.com/watch?v=1" }) },
	{ title: "YouTube Studio · full site page (Subs needs a key)", setup: async (e) => { e.updateContext({ bundleId: "com.brave.Browser", app: "Brave", url: "https://studio.youtube.com/x" }); e.goPage("sub"); await e.refreshMissingSecrets(); } },
	{ title: "Claude app (your generated layout)", setup: (e) => e.updateContext({ bundleId: "com.anthropic.claudefordesktop", app: "Claude" }) },
	{ title: "System page · live battery info key", setup: async (e) => { e.updateContext({ bundleId: "com.apple.Notes", app: "Notes" }); e.goPage("system"); e.deps.evaluateInfo = async () => ({ value: "87", text: "87%", progress: 0.87, at: Date.now() }); await e.pollInfo(); } },
];
const W = 4 * 150 + 10, H = 40 + 2 * 150 + 110;
const rows: string[] = [];
for (const [si, s] of scenes.entries()) {
	const e = new Engine();
	e.deps = { ...e.deps, secrets: memoryStore(), appVersion: async () => "" };
	e.setConfig({ ...config!, settings: { ...config!.settings, llm: "openrouter" } }, []);
	const keys: string[] = [], dials: string[] = [];
	for (let i = 0; i < 8; i++) e.addKey({ id: `k${i}`, setImage: async (img) => { keys[i] = img!; }, setTitle: async () => undefined, showAlert: async () => undefined, showOk: async () => undefined }, i);
	for (let i = 0; i < 4; i++) e.addDial({ id: `d${i}`, setFeedback: async (f) => { dials[i] = (f as { canvas: string }).canvas; }, setTriggerDescription: async () => undefined, showAlert: async () => undefined }, i);
	await s.setup(e);
	const y0 = si * H;
	rows.push(`<text x="10" y="${y0 + 26}" font-family="DejaVu Sans" font-size="17" font-weight="bold" fill="#E4E4E7">${s.title}</text>`);
	keys.forEach((k, i) => rows.push(`<image x="${10 + (i % 4) * 150}" y="${y0 + 40 + Math.floor(i / 4) * 150}" width="144" height="144" href="${raster(k)}"/>`));
	dials.forEach((d, i) => rows.push(`<image x="${10 + i * 150}" y="${y0 + 340}" width="144" height="72" href="${raster(d)}"/>`));
}
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H * scenes.length}"><rect width="100%" height="100%" fill="#000"/>${rows.join("")}</svg>`;
writeFileSync(out, new Resvg(svg, opts).render().asPng());
console.log("wrote", out);
process.exit(0);
