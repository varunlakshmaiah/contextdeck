// Builds the ContextDeck browser extension for Chromium browsers (Chrome, Edge, Brave, Arc, Vivaldi, Opera) and Firefox.
//   node scripts/build-extension.mjs  →  out/extension/{chrome,firefox}/ and out/contextdeck-extension-{chrome,firefox}.zip
import { Resvg } from "@resvg/resvg-js";
import { execFileSync } from "node:child_process";
import { copyFileSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const version = JSON.parse(readFileSync("com.var.contextdeck.sdPlugin/manifest.json", "utf8")).Version.split(".").slice(0, 3).join(".");
const icons = JSON.parse(readFileSync("com.var.contextdeck.sdPlugin/icons.json", "utf8"));
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><rect width="128" height="128" rx="28" fill="#F97316"/><g transform="translate(24 24) scale(3.333)" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${icons["layout-grid"]}</g></svg>`;

const common = {
	name: "ContextDeck",
	version,
	description: "Lets your Stream Deck (ContextDeck plugin) see which website you're on. Talks only to 127.0.0.1.",
	permissions: ["tabs", "storage", "alarms"],
	host_permissions: ["http://127.0.0.1/*"],
	options_ui: { page: "options.html", open_in_tab: true },
	action: { default_title: "ContextDeck", default_popup: "options.html" },
	icons: { 16: "icon16.png", 48: "icon48.png", 128: "icon128.png" },
};
const targets = {
	chrome: { manifest_version: 3, ...common, background: { service_worker: "background.js" }, minimum_chrome_version: "116" },
	firefox: {
		manifest_version: 3, ...common,
		background: { scripts: ["background.js"] },
		browser_specific_settings: { gecko: { id: "contextdeck@var.dev", strict_min_version: "115.0", data_collection_permissions: { required: ["none"] } } },
	},
};

for (const [name, manifest] of Object.entries(targets)) {
	const dir = join("out", "extension", name);
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
	for (const f of ["background.js", "options.html", "options.js"]) copyFileSync(join("extension", f), join(dir, f));
	for (const size of [16, 48, 128]) writeFileSync(join(dir, `icon${size}.png`), new Resvg(svg, { fitTo: { mode: "width", value: size } }).render().asPng());
	// Also ship it inside the plugin; the plugin copies it to ~/.contextdeck/extension/ for "Load unpacked".
	const inPlugin = join("com.var.contextdeck.sdPlugin", "extension", name);
	rmSync(inPlugin, { recursive: true, force: true });
	cpSync(dir, inPlugin, { recursive: true });
	const zip = join(process.cwd(), "out", `contextdeck-extension-${name}.zip`);
	rmSync(zip, { force: true });
	execFileSync("zip", ["-qr", zip, "."], { cwd: dir });
	console.log(`built ${zip}`);
}
