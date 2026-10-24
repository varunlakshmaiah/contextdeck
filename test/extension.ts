// The browser extension, for real: Chromium loads it, pairs with the deck (Allow pressed on the deck), then reports tabs.
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH ?? "playwright");

const home = mkdtempSync(join(process.env.SCRATCH!, "cdext-"));
process.env.CONTEXTDECK_HOME = home;
const { installDefaults, loadConfig, ensureHome, readToken } = await import("../src/config");
const { Engine } = await import("../src/engine");
const { startApi } = await import("../src/api");
const { memoryStore } = await import("../src/secrets");
installDefaults("com.var.contextdeck.sdPlugin/defaults", home);
ensureHome();
const e = new Engine();
e.deps.secrets = memoryStore();
e.deps.icons = () => ({});
const { config } = loadConfig(join(home, "config.json"), join(home, "layouts"));
e.setConfig(config!, []);
const notes: string[] = [];
const os = e.os; // the real adapter; just capture notifications
os.notify = async (t: string) => void notes.push(t);
const api = startApi(e, 47811, readToken());

const site = createServer((req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end(`<title>Page ${req.url}</title>hi`); }).listen(47998);
const ext = resolvePath("out/extension/chrome");
const ctx = await chromium.launchPersistentContext(mkdtempSync(join(process.env.SCRATCH!, "cdprof-")), {
	headless: true, executablePath: "/opt/pw-browsers/chromium", args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, "--headless=new"],
});
let [sw] = ctx.serviceWorkers();
sw ??= await ctx.waitForEvent("serviceworker");
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Pair: the options page asks the worker; the deck shows Allow/Deny; we press Allow.
const pairResult = sw.evaluate(async () => {
	const res = await fetch("http://127.0.0.1:47811/pair", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client: "Chromium extension" }) });
	const j = await res.json();
	if (j.token) await (globalThis as any).chrome.storage.local.set({ token: j.token });
	return { status: res.status, hasToken: !!j.token };
});
for (let i = 0; i < 50 && !e.snapshot().overlay; i++) await wait(50);
console.log("overlay:", e.snapshot().overlay?.title, "| keys:", e.snapshot().keys.slice(0, 2).join(", "));
e.keyDown(0); e.keyUp(0);
console.log("pair:", JSON.stringify(await pairResult), "| notified:", notes[0]);

// Report: open a page, focus it.
const page = await ctx.newPage();
await page.goto("http://127.0.0.1:47998/watch?v=42");
await page.bringToFront();
for (let i = 0; i < 60 && !e.browserReport?.url.includes("watch"); i++) await wait(100);
console.log("report:", JSON.stringify({ url: e.browserReport?.url, title: e.browserReport?.title, browser: e.browserReport?.browser }));
// A web page can't talk to the API (origin check), even with the right path.
const blocked = await page.evaluate(async () => (await fetch("http://127.0.0.1:47811/status").catch(() => ({ status: "network error" }))).status as unknown);
console.log("web page → API:", blocked);
await ctx.close();
api.close(); site.close();
process.exit(e.browserReport?.url === "http://127.0.0.1:47998/watch?v=42" ? 0 : 1);
