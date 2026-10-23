/**
 * ✨ Set up: turns "an app/site the deck doesn't know" into a layout file.
 *
 *  1. ground truth   – the app's real menu bar (names + shortcuts), when it's a native app
 *  2. research       – platform facts + current docs from the web (optional), condensed into a Digest
 *  3. plan           – the model picks keys, dials, info keys and API actions, using only grounded items
 *  4. validate       – unknown menu paths dropped, chords parsed, confidence tagged, info sources checked
 *
 * Ids follow the naming convention: app.<bundleId> (level app) and site.<host> (level sub).
 */
import { unsafeReason } from "./info";
import { validateKeys } from "./platform/chords";
import type { MenuEntry } from "./menus";
import type { Digest } from "./research";
import type { PlatformFacts as Platform } from "./platform/types";
import { SECRET_NAME, secretNames } from "./secrets";
import type { Action, DialDef, InfoSpec, KeyDef, LayoutDef, Meta, SecretDecl } from "./types";

export interface SetupTarget {
	kind: "app" | "site";
	id: string;          // app.<bundleId> or site.<host>
	name: string;        // display name ("Figma", "notion.so")
	bundleId: string;    // app bundle id (for sites: the browser's)
	host?: string;
	url?: string;
	legacyId?: string;   // an older layout id for the same target (e.g. auto.*), removed after rebuild
}

export const targetForApp = (bundleId: string, app: string): SetupTarget =>
	({ kind: "app", id: `app.${bundleId}`, name: app || bundleId, bundleId });

export const targetForSite = (bundleId: string, url: string): SetupTarget | undefined => {
	try {
		const u = new URL(url);
		if (!/^https?:$/.test(u.protocol) || !u.hostname) return undefined;
		const host = u.hostname.replace(/^www\./, "");
		return { kind: "site", id: `site.${host}`, name: host, bundleId, host, url };
	} catch {
		return undefined;
	}
};

type Ref = { menu?: string; keys?: string; builtin?: string; http?: { url: string; method?: string; headers?: Record<string, string>; body?: unknown }; open?: string };
type PlanKey = { label?: string; sub?: string; icon?: string; do?: Ref; info?: InfoSpec; source?: string } & Ref;
interface Plan {
	name?: string;
	color?: string;
	keys?: PlanKey[];
	dials?: { label?: string; icon?: string; cw?: Ref; ccw?: Ref; press?: Ref; info?: InfoSpec }[];
	secrets?: Record<string, SecretDecl>;
}

export const BUILTINS: Record<string, { cw: Action; ccw: Action; label: string; icon: string }> = {
	scroll: { cw: { type: "keys", keys: "down down down" }, ccw: { type: "keys", keys: "up up up" }, label: "Scroll", icon: "mouse" },
	zoom: { cw: { type: "keys", keys: "cmd+=" }, ccw: { type: "keys", keys: "cmd+-" }, label: "Zoom", icon: "zoom-in" },
	tabs: { cw: { type: "keys", keys: "ctrl+tab" }, ccw: { type: "keys", keys: "ctrl+shift+tab" }, label: "Tabs", icon: "panels-top-left" },
	undo: { cw: { type: "keys", keys: "cmd+shift+z" }, ccw: { type: "keys", keys: "cmd+z" }, label: "Undo/Redo", icon: "undo-2" },
	horizontal: { cw: { type: "keys", keys: "right" }, ccw: { type: "keys", keys: "left" }, label: "Left/Right", icon: "move-horizontal" },
	vertical: { cw: { type: "keys", keys: "down" }, ccw: { type: "keys", keys: "up" }, label: "Up/Down", icon: "move-vertical" },
};

const norm = (s: string) => s.toLowerCase().replace(/[…\s]+/g, " ").replace(/\.\.\.$/, "").trim();
const pathStr = (p: string[]) => p.join(" > ");
/** Order-insensitive chord identity: "shift+cmd+n" == "cmd+shift+n". */
export const chordKey = (c: string) => c.toLowerCase().replace(/option/g, "alt").replace(/command/g, "cmd").replace(/control/g, "ctrl").split(/\s+/).map((ch) => ch.split("+").sort().join("+")).join(" ");

export function menuPrompt(entries: MenuEntry[], limit = 450): string {
	const withKeys = entries.filter((e) => e.chord);
	const without = entries.filter((e) => !e.chord);
	return [...withKeys, ...without].slice(0, limit).map((e) => `${pathStr(e.path)}${e.chord ? `  [${e.chord}]` : ""}`).join("\n");
}

export interface PromptInput {
	target: SetupTarget;
	entries: MenuEntry[];
	slots: { keys: number; dials: number };
	iconHints: string[];
	platform?: Platform;
	digest?: Digest;
	existing?: LayoutDef;          // "Update layout": keep what still works
}

export function buildPrompt(p: PromptInput): { system: string; prompt: string } {
	const { target: t, entries, slots } = p;
	const isSite = t.kind === "site";
	const system = `You design Stream Deck+ layouts (8 LCD keys, 4 dials with a touch strip). Return ONLY a JSON object, no prose, no code fences.`;
	const grounding: string[] = [];
	if (entries.length) grounding.push(`REAL MENU BAR of the app (path, then [shortcut] if any). Menu items are verified; prefer them:\n${menuPrompt(entries)}`);
	if (p.digest) {
		grounding.push(`RESEARCH from current documentation (cite "source" URLs you rely on):\nShortcuts: ${JSON.stringify(p.digest.shortcuts.slice(0, 120))}\nInfo ideas: ${JSON.stringify(p.digest.info.slice(0, 30))}\nAPIs: ${JSON.stringify(p.digest.apis.slice(0, 15))}${p.digest.notes ? `\nNotes: ${p.digest.notes}` : ""}`);
	}
	if (!grounding.length) grounding.push(`No menu list or research is available. Use only shortcuts you are confident ${isSite ? "this website" : "this app"} supports on macOS.`);
	const plat = p.platform ? `Platform: ${p.platform.os} (${p.platform.arch}), keyboard layout ${p.platform.keyboard}${p.platform.appVersion ? `, app version ${p.platform.appVersion}` : ""}. Give shortcuts for exactly this platform.` : "";
	const existing = p.existing ? `\nCURRENT LAYOUT (update it: keep keys that are still valid, fix or replace outdated ones, add important new ones):\n${JSON.stringify({ keys: p.existing.keys, dials: p.existing.dials, pages: p.existing.pages })}` : "";
	const prompt = `Design the ${isSite ? `layout for the website ${t.host} (shown on top of the browser's own tab controls, so DON'T include new/close/switch tab, back/forward or zoom)` : `layout for the macOS app "${t.name}" (${t.bundleId})`}.
${plat}

${grounding.join("\n\n")}
${existing}

Rules:
- keys: up to ${slots.keys + 5}, MOST IMPORTANT FIRST. The first ${slots.keys} are always visible; the rest go on a "More" page. Prefer the app's core working actions; skip generic copy/paste/save/quit/new-window unless central.
- Include 1–2 INFO keys if the app/site exposes useful live read-only values (usage, quota, reset time, unread/queue counts, status). An info key has "info" instead of "do".
- If the app/site has an official API that adds real value (an action or an info value), use it with a secret placeholder {{secret.NAME}} and declare NAME under "secrets" with the API host(s). NAME is UPPER_SNAKE like SERVICE_API_KEY or SERVICE_TOKEN. Never put real keys in the layout.
- dials: up to ${slots.dials}, things with natural opposites (zoom, next/prev item, scrub, size). Use a builtin when nothing app-specific fits.
- label ≤ 10 chars, Title Case. sub ≤ 12 chars (e.g. the shortcut "⌘⇧N" or a qualifier). icon: a lucide icon name, e.g. ${p.iconHints.join(", ")}.
- color: one hex accent matching the brand.
- Add "source": "<url>" to keys that come from research.

Each action ("do", "cw", "ccw", "press") is exactly one of:
  {"menu": "Top > Item"}              — copy the path exactly from the menu list
  {"keys": "cmd+shift+n"}             — modifiers cmd shift alt ctrl; keys a-z 0-9 = - [ ] ; ' , . / \` space return tab esc delete left right up down home end pageup pagedown f1-f19
  {"http": {"url": "https://api…", "method": "POST", "headers": {"Authorization": "Bearer {{secret.NAME}}"}, "body": {…}}}
  {"open": "https://… or app name"}
  {"builtin": "scroll" | "zoom" | "tabs" | "undo" | "horizontal" | "vertical"} — dials only

An info spec is:
  {"source": {"type": "http", "url": "…", "headers": {…}} | {"type": "applescript", "script": "tell application \\"X\\" to get …"} | {"type": "uiText", "match": "regex with (group)"} | {"type": "file", "path": "~/…"} | {"type": "command", "cmd": ["/usr/bin/pmset", "-g", "batt"]},
   "extract": "json.path[0].field" or "/regex (group)/", "format": "{{value}} …" (filters: |pct |round |k |duration |until |ago |money), "progress": {"max": 100}, "every": 60,
   "thresholds": [{"above": 80, "color": "#EF4444"}]}
Info sources must only READ.

JSON shape:
{"name": "...", "color": "#RRGGBB",
 "keys": [{"label": "...", "sub": "...", "icon": "...", "do": {...}, "source": "url?"}, {"label": "...", "icon": "...", "info": {...}}],
 "dials": [{"label": "...", "icon": "...", "cw": {...}, "ccw": {...}, "press": {...}}],
 "secrets": {"NAME": {"description": "...", "url": "where to get it", "hosts": ["api.example.com"]}}}`;
	return { system, prompt };
}

export function extractJson(text: string): unknown {
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start < 0 || end <= start) throw new Error("The model didn't return JSON");
	return JSON.parse(text.slice(start, end + 1));
}

const hashColor = (s: string) => {
	let h = 0;
	for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0;
	return `hsl(${h % 360} 70% 60%)`;
};

export interface PlanOptions {
	keySlots: number;           // how many keys are visible on the full page (7 with the AI key pinned)
	dialSlots: number;
	model: string;
	digest?: Digest;
	platform?: Platform;
	allowKnowledge?: boolean;   // keep shortcuts that are neither in the menus nor in the research (default true)
}

/** Converts the model's plan into a validated layout. Unknown menu paths, bad chords and unsafe info sources are dropped. */
export function planToLayout(t: SetupTarget, plan: Plan, entries: MenuEntry[], icons: Record<string, string>, opts: PlanOptions): { layout: LayoutDef; dropped: string[] } {
	const dropped: string[] = [];
	const byPath = new Map(entries.map((e) => [norm(pathStr(e.path)), e]));
	const byLeaf = new Map<string, MenuEntry | null>();
	for (const e of entries) {
		const leaf = norm(e.path[e.path.length - 1]);
		byLeaf.set(leaf, byLeaf.has(leaf) ? null : e);
	}
	const documented = new Map<string, string | undefined>();
	for (const s of opts.digest?.shortcuts ?? []) { try { documented.set(chordKey(s.keys), s.source); } catch { /* skip */ } }
	const menuChords = new Set(entries.filter((e) => e.chord).map((e) => chordKey(e.chord!)));
	const allowKnowledge = opts.allowKnowledge ?? true;

	const secrets: Record<string, SecretDecl> = {};
	for (const [name, d] of Object.entries(plan.secrets ?? {})) {
		if (!SECRET_NAME.test(name)) { dropped.push(`secret ${name}: not UPPER_SNAKE`); continue; }
		const hosts = (d.hosts ?? []).filter((h) => /^[\w*.-]+$/.test(h) || h.startsWith("secret:"));
		if (!hosts.length) { dropped.push(`secret ${name}: no hosts`); continue; }
		secrets[name] = { description: d.description?.slice(0, 120), url: d.url, hosts, optional: d.optional };
	}
	const needsSecrets = (x: unknown, where: string): string[] | null => {
		const names = secretNames(JSON.stringify(x));
		const undeclared = names.filter((n) => !secrets[n]);
		if (undeclared.length) { dropped.push(`${where}: undeclared secret ${undeclared.join(", ")}`); return null; }
		return names;
	};

	const toAction = (r: Ref | undefined, where: string, source?: string): { action: Action; meta: Meta; requires?: string[] } | undefined => {
		if (!r) return undefined;
		if (r.menu) {
			const key = norm(r.menu.replace(/\s*[>›▸→]\s*/g, " > "));
			const e = byPath.get(key) ?? byLeaf.get(norm(key.split(" > ").pop() ?? "")) ?? undefined;
			if (!e) { dropped.push(`${where}: menu "${r.menu}" not found`); return undefined; }
			return { action: e.chord ? { type: "keys", keys: e.chord } : { type: "menu", path: e.path }, meta: { confidence: "verified", source: "menu" } };
		}
		if (r.keys) {
			const chords = r.keys.trim().toLowerCase().replace(/option/g, "alt").replace(/command/g, "cmd").replace(/control/g, "ctrl").split(/\s+/);
			try { chords.forEach(validateKeys); } catch (e) { dropped.push(`${where}: ${(e as Error).message}`); return undefined; }
			const k = chordKey(chords.join(" "));
			const meta: Meta = menuChords.has(k) ? { confidence: "verified", source: "menu" }
				: documented.has(k) ? { confidence: "documented", source: documented.get(k) ?? source }
				: { confidence: "knowledge", source };
			if (meta.confidence === "knowledge" && !allowKnowledge) { dropped.push(`${where}: "${r.keys}" not verified by menus or docs`); return undefined; }
			return { action: { type: "keys", keys: chords.join(" ") }, meta };
		}
		if (r.http) {
			const url = String(r.http.url ?? "");
			if (!/^https?:\/\//.test(url) && !url.startsWith("{{secret.")) { dropped.push(`${where}: bad URL`); return undefined; }
			const req = needsSecrets(r.http, where);
			if (!req) return undefined;
			return { action: { type: "http", url, method: (r.http.method ?? "GET").toUpperCase(), headers: r.http.headers, body: r.http.body }, meta: { confidence: "documented", source }, requires: req.length ? req : undefined };
		}
		if (r.open) return { action: { type: "open", target: r.open }, meta: { confidence: "knowledge", source } };
		dropped.push(`${where}: empty action`);
		return undefined;
	};
	const checkInfo = (info: InfoSpec | undefined, where: string): { info: InfoSpec; requires?: string[] } | undefined => {
		if (!info?.source?.type) return undefined;
		const reason = unsafeReason(info.source);
		if (reason) { dropped.push(`${where}: info ${reason}`); return undefined; }
		const req = needsSecrets(info, where);
		if (!req) return undefined;
		const clean: InfoSpec = { source: info.source, extract: info.extract, format: info.format?.slice(0, 60), progress: info.progress, thresholds: info.thresholds?.slice(0, 4), every: info.every ? Math.max(5, Math.min(3600, info.every)) : undefined };
		return { info: clean, requires: req.length ? req : undefined };
	};
	const icon = (name: string | undefined) => (name && icons[name] ? name : undefined);
	const clip = (s: string | undefined, n: number) => (s ? (s.length > n ? s.slice(0, n) : s) : undefined);

	const built: KeyDef[] = [];
	for (const [i, k] of (plan.keys ?? []).entries()) {
		if (!k?.label) continue;
		const where = `key ${i + 1} (${k.label})`;
		const ic = icon(k.icon);
		const base: KeyDef = { label: clip(k.label, 12)!, sub: clip(k.sub, 14), icon: ic, glyph: ic ? undefined : k.label.slice(0, 1).toUpperCase() };
		if (k.info) {
			const inf = checkInfo(k.info, where);
			if (!inf) continue;
			built.push({ ...base, info: inf.info, ...(inf.requires ? { requires: inf.requires } : {}), meta: { confidence: k.source ? "documented" : "knowledge", source: k.source } });
			continue;
		}
		const a = toAction(k.do ?? { menu: k.menu, keys: k.keys, http: k.http, open: k.open }, where, k.source);
		if (!a) continue;
		built.push({ ...base, action: a.action, ...(a.requires ? { requires: a.requires } : {}), meta: a.meta });
	}
	if (!built.length) throw new Error(`No usable actions in the plan${dropped.length ? ` (${dropped.slice(0, 3).join("; ")})` : ""}`);

	const dials: DialDef[] = [];
	for (const [i, d] of (plan.dials ?? []).entries()) {
		if (dials.length >= opts.dialSlots + 2) break;
		const b = d.cw?.builtin ?? d.ccw?.builtin;
		let cw: Action | undefined, ccw: Action | undefined;
		if (b && BUILTINS[b]) { cw = BUILTINS[b].cw; ccw = BUILTINS[b].ccw; }
		else { cw = toAction(d.cw, `dial ${i + 1} cw`)?.action; ccw = toAction(d.ccw, `dial ${i + 1} ccw`)?.action; }
		if (!cw || !ccw) continue;
		const press = d.press && !d.press.builtin ? toAction(d.press, `dial ${i + 1} press`)?.action : undefined;
		const inf = d.info ? checkInfo(d.info, `dial ${i + 1}`) : undefined;
		dials.push({ label: clip(d.label ?? (b ? BUILTINS[b]?.label : undefined) ?? "Dial", 12)!, icon: icon(d.icon) ?? (b ? BUILTINS[b]?.icon : undefined), cw, ccw, ...(press ? { press } : {}), ...(inf ? { info: inf.info } : {}) });
	}
	if (!dials.length) dials.push({ label: "Scroll", icon: "mouse", cw: BUILTINS.scroll.cw, ccw: BUILTINS.scroll.ccw });

	const visible = built.slice(0, opts.keySlots);
	const more = built.slice(opts.keySlots, opts.keySlots + 7);
	const usedSecrets = new Set(secretNames(JSON.stringify([built, dials])));
	const keptSecrets = Object.fromEntries(Object.entries(secrets).filter(([n]) => usedSecrets.has(n)));
	const color = /^#[0-9a-f]{6}$/i.test(plan.color ?? "") ? plan.color! : hashColor(t.id);
	const sources = [...new Set([...built, ...dials].map((x) => x.meta?.source).filter((s): s is string => !!s && s !== "menu"))];
	const layout: LayoutDef = {
		id: t.id,
		name: clip(plan.name, 24) ?? t.name,
		level: t.kind === "site" ? "sub" : "app",
		color,
		match: t.kind === "site" ? { url: [`*://${t.host}/*`, `*://*.${t.host}/*`, `*://${t.host}`] } : { bundleId: t.bundleId },
		keys: visible,
		dials: dials.slice(0, opts.dialSlots + 1),
		...(more.length ? { pages: [{ name: "More", keys: more }] } : {}),
		...(Object.keys(keptSecrets).length ? { secrets: keptSecrets } : {}),
		generated: {
			at: new Date().toISOString(), model: opts.model,
			source: opts.digest ? "research" : entries.length ? "menus" : "knowledge",
			...(t.kind === "site" ? { host: t.host } : { app: t.name, bundleId: t.bundleId }),
			...(opts.platform?.appVersion ? { appVersion: opts.platform.appVersion } : {}),
			...(opts.platform ? { platform: `${opts.platform.os} ${opts.platform.arch} ${opts.platform.keyboard}` } : {}),
			...(sources.length ? { sources: sources.slice(0, 10) } : {}),
		},
	};
	return { layout, dropped };
}

export const ICON_HINTS = ["play", "pause", "scissors", "pen-line", "brush", "eraser", "layers", "crop", "type", "image", "plus", "trash-2", "send", "reply", "search", "bookmark", "star", "flag", "tag", "folder-open", "download", "upload", "share-2", "eye", "grid-3x3", "zoom-in", "move", "rotate-cw", "sliders-horizontal", "list-todo", "check", "message-square", "calendar", "mic", "video", "music", "square-terminal", "code", "bug", "git-branch", "panel-left", "maximize-2", "refresh-cw", "sparkles", "gauge", "timer", "battery", "inbox", "bell", "chart-line"];
