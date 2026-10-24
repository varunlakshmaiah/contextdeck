// The app (local web UI) in a real browser: every section renders without errors; key presses reach the deck.
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH ?? "playwright");
const OUT = process.env.SHOTS ?? process.env.SCRATCH!;

const home = mkdtempSync(join(process.env.SCRATCH!, "cdui-"));
process.env.CONTEXTDECK_HOME = home;
const { installDefaults, loadConfig, ensureHome, readToken } = await import("../src/config");
const { Engine } = await import("../src/engine");
const { startApi } = await import("../src/api");
const { memoryStore } = await import("../src/secrets");
const { loadIcons } = await import("../src/render");
installDefaults("com.var.contextdeck.sdPlugin/defaults", home);
ensureHome();
const e = new Engine();
e.deps.secrets = memoryStore({ GITHUB_TOKEN: "x" });
const icons = loadIcons("com.var.contextdeck.sdPlugin/icons.json");
e.deps.icons = () => icons;
e.os.notify = async () => undefined;
const { config, sources } = loadConfig(join(home, "config.json"), join(home, "layouts"));
e.sources = sources;
e.setConfig(config!, []);
e.reloadConfig = () => { const l = loadConfig(join(home, "config.json"), join(home, "layouts")); e.sources = l.sources; e.setConfig(l.config, l.errors); };
const surf = (id: string) => ({ id, setImage: async () => undefined, setTitle: async () => undefined, showAlert: async () => undefined, showOk: async () => undefined, setFeedback: async () => undefined, setTriggerDescription: async () => undefined });
const plus = { id: "plus1", name: "Stream Deck +", kind: "plus", keys: 8, dials: 4, cols: 4, rows: 2 };
for (let i = 0; i < 8; i++) e.addKey(surf(`k${i}`), i, plus);
for (let i = 0; i < 4; i++) e.addDial(surf(`d${i}`), i, plus);
const xl = { id: "xl1", name: "Stream Deck XL", kind: "xl", keys: 32, dials: 0, cols: 8, rows: 4 };
for (let i = 0; i < 32; i++) e.addKey(surf(`x${i}`), i, xl);
e.updateContext({ bundleId: "com.google.Chrome", app: "Google Chrome", url: "https://www.youtube.com/watch?v=dQw4", title: "Video" });
e.recompute(true);
const api = startApi(e, 47995, readToken());
await new Promise((r) => setTimeout(r, 200));

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const errors: string[] = [];
for (const [name, viewport, scheme] of [["desktop", { width: 1280, height: 860 }, "dark"], ["phone", { width: 390, height: 844 }, "light"]] as const) {
	const page = await browser.newPage({ viewport, colorScheme: scheme });
	page.on("console", (m: any) => m.type() === "error" && errors.push(`${name}: ${m.text()}`));
	page.on("pageerror", (err: any) => errors.push(`${name}: ${err.message}`));
	await page.goto(`http://127.0.0.1:47995/ui#token=${readToken()}`);
	await page.waitForSelector(".keys img");
	if (await page.evaluate(() => location.hash)) errors.push("token left in the URL");
	for (const section of ["deck", "layouts", "secrets", "ai", "browser", "settings", "logs"]) {
		await page.click(`nav button[data-section=${section}]`);
		await page.waitForTimeout(350);
		if (section === "layouts") { await page.click('[data-layout="site.youtube.com"]'); await page.waitForSelector("#json"); }
		const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
		if (overflow) errors.push(`${name}/${section}: horizontal scroll`);
		await page.screenshot({ path: join(OUT, `ui-${name}-${section}.png`), fullPage: name === "desktop" });
	}
	await page.click("nav button[data-section=deck]");
	await page.waitForSelector(".keys img");
	if (name === "desktop") {
		await page.click('[data-device="xl1"]');
		await page.waitForTimeout(1200);
		const n = await page.locator(".keys button").count();
		if (n !== 32) errors.push(`XL preview shows ${n} keys`);
		await page.screenshot({ path: join(OUT, "ui-desktop-deck-xl.png") });
		await page.click('[data-device="plus1"]');
		await page.waitForTimeout(1200);
		await page.click('.deckbar [data-page="next"]');
		await page.waitForTimeout(300);
		console.log("page after › :", e.snapshot().page.id);
	}
	await page.close();
}
// Settings round-trip through the API keeps the header comments.
const before = (await import("node:fs")).readFileSync(join(home, "config.json"), "utf8");
const res = await fetch("http://127.0.0.1:47995/settings", { method: "PUT", headers: { authorization: `Bearer ${readToken()}`, "content-type": "application/json", host: "127.0.0.1:47995" }, body: JSON.stringify({ settings: { ...e.settings, cmdKey: "win" } }) });
const after = (await import("node:fs")).readFileSync(join(home, "config.json"), "utf8");
console.log("settings PUT:", res.status, "| header kept:", after.startsWith(before.split("\n")[0]), "| cmdKey:", e.settings.cmdKey);
await browser.close();
api.close();
console.log(errors.length ? `ERRORS:\n${errors.join("\n")}` : "no errors");
process.exit(errors.length ? 1 : 0);
