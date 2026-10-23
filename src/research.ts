/**
 * Research for ✨ Set up: platform facts + a web search for the app's current shortcuts, status APIs and info sources.
 * Results are condensed by the model into a digest, cached per app version in ~/.contextdeck/research/.
 */
import { run } from "./mac";
import type { SecretStore } from "./secrets";
import type { ResearchSettings } from "./types";

export interface Platform {
	os: string;            // "macOS 26.1"
	arch: string;          // "arm64"
	keyboard: string;      // "U.S.", "British", "German" …
	locale: string;        // "en-IN"
	appVersion?: string;   // CFBundleShortVersionString of the app
	browser?: string;      // for sites
}

export interface SearchHit { title: string; url: string; snippet: string }

export interface Digest {
	app: string;
	version?: string;
	shortcuts: { action: string; keys: string; source?: string }[];
	info: { what: string; how: string; source?: string }[];
	apis: { name: string; docs?: string; auth?: string; secret?: string; hosts?: string[] }[];
	notes?: string;
	sources: string[];
}

// ---------- platform ----------

export async function platformFacts(bundleId?: string): Promise<Platform> {
	const safe = async (f: () => Promise<string>) => { try { return (await f()).trim(); } catch { return ""; } };
	const ver = await safe(() => run("/usr/bin/sw_vers", ["-productVersion"]));
	const arch = await safe(() => run("/usr/bin/uname", ["-m"]));
	const sources = await safe(() => run("/usr/bin/defaults", ["read", `${process.env.HOME}/Library/Preferences/com.apple.HIToolbox.plist`, "AppleSelectedInputSources"]));
	const keyboard = /"KeyboardLayout Name"\s*=\s*"?([^";\n]+)"?/.exec(sources)?.[1]?.trim() ?? "U.S.";
	let appVersion: string | undefined;
	if (bundleId) appVersion = (await appVersionOf(bundleId)) || undefined;
	return { os: `macOS ${ver || "?"}`, arch: arch || "?", keyboard, locale: Intl.DateTimeFormat().resolvedOptions().locale, appVersion };
}

const versionCache = new Map<string, string>();
/** App version from its bundle's Info.plist (found via Spotlight). Cached per run. */
export async function appVersionOf(bundleId: string): Promise<string> {
	if (versionCache.has(bundleId)) return versionCache.get(bundleId)!;
	let v = "";
	try {
		const path = (await run("/usr/bin/mdfind", [`kMDItemCFBundleIdentifier == '${bundleId.replace(/'/g, "")}'`], { timeout: 4000 })).split("\n").find((p) => p.endsWith(".app"));
		if (path) v = (await run("/usr/bin/plutil", ["-extract", "CFBundleShortVersionString", "raw", "-o", "-", `${path}/Contents/Info.plist`])).trim();
	} catch { /* unknown */ }
	versionCache.set(bundleId, v);
	return v;
}

// ---------- search providers ----------

export async function search(q: string, rs: ResearchSettings, secrets: SecretStore, fetchImpl: typeof fetch = fetch): Promise<SearchHit[]> {
	const n = rs.maxResults ?? 6;
	const key = async (name: string) => {
		const k = await secrets.get(name);
		if (!k) throw new Error(`Research uses ${rs.provider}: run ~/.contextdeck/deck secret set ${name}`);
		return k;
	};
	const timeout = AbortSignal.timeout(15_000);
	switch (rs.provider) {
		case "brave": {
			const r = await fetchImpl(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=${n}`, { headers: { accept: "application/json", "x-subscription-token": await key("BRAVE_SEARCH_API_KEY") }, signal: timeout });
			if (!r.ok) throw new Error(`Brave Search ${r.status}`);
			const j = (await r.json()) as { web?: { results?: { title: string; url: string; description?: string }[] } };
			return (j.web?.results ?? []).map((x) => ({ title: x.title, url: x.url, snippet: strip(x.description ?? "") }));
		}
		case "tavily": {
			const r = await fetchImpl("https://api.tavily.com/search", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${await key("TAVILY_API_KEY")}` }, body: JSON.stringify({ query: q, max_results: n }), signal: timeout });
			if (!r.ok) throw new Error(`Tavily ${r.status}`);
			const j = (await r.json()) as { results?: { title: string; url: string; content?: string }[] };
			return (j.results ?? []).map((x) => ({ title: x.title, url: x.url, snippet: x.content ?? "" }));
		}
		case "exa": {
			const r = await fetchImpl("https://api.exa.ai/search", { method: "POST", headers: { "content-type": "application/json", "x-api-key": await key("EXA_API_KEY") }, body: JSON.stringify({ query: q, numResults: n, contents: { text: { maxCharacters: 1500 } } }), signal: timeout });
			if (!r.ok) throw new Error(`Exa ${r.status}`);
			const j = (await r.json()) as { results?: { title: string; url: string; text?: string }[] };
			return (j.results ?? []).map((x) => ({ title: x.title, url: x.url, snippet: x.text ?? "" }));
		}
		case "searxng": {
			if (!rs.baseUrl) throw new Error("research.baseUrl is needed for SearXNG");
			const r = await fetchImpl(`${rs.baseUrl.replace(/\/+$/, "")}/search?q=${encodeURIComponent(q)}&format=json`, { signal: timeout });
			if (!r.ok) throw new Error(`SearXNG ${r.status}`);
			const j = (await r.json()) as { results?: { title: string; url: string; content?: string }[] };
			return (j.results ?? []).slice(0, n).map((x) => ({ title: x.title, url: x.url, snippet: x.content ?? "" }));
		}
		default:
			return [];
	}
}

/** Prefer official docs/help pages over blogs and video sites. */
export function rankHits(hits: SearchHit[], appName: string, host?: string): SearchHit[] {
	const word = appName.toLowerCase().split(/\s+/)[0];
	const score = (h: SearchHit) => {
		const u = h.url.toLowerCase();
		let s = 0;
		if (host && u.includes(host)) s += 6;
		if (u.includes(word)) s += 3;
		if (/(support|help|docs|documentation|manual|guide|learn)\./.test(u) || /\/(support|help|docs|manual|guide|kb)\//.test(u)) s += 4;
		if (/shortcut|hotkey|keyboard/.test(u + h.title.toLowerCase())) s += 3;
		if (/youtube\.com|reddit\.com|pinterest|facebook|tiktok|quora/.test(u)) s -= 5;
		return s;
	};
	return [...hits].sort((a, b) => score(b) - score(a));
}

/** HTML → readable text, keeping table rows and list items on their own lines. */
export function htmlToText(html: string, max = 12_000): string {
	return strip(
		html
			.replace(/<(script|style|noscript|svg|nav|footer|header)[\s\S]*?<\/\1>/gi, " ")
			.replace(/<\/(td|th)>/gi, " | ")
			.replace(/<(br|\/p|\/li|\/tr|\/h[1-6]|\/div|\/dt|\/dd)[^>]*>/gi, "\n")
			.replace(/<kbd[^>]*>/gi, "[").replace(/<\/kbd>/gi, "]")
			.replace(/<[^>]+>/g, " "),
	).replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").slice(0, max);
}

function strip(s: string): string {
	return s
		.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
		.replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
		.replace(/[ \t]{2,}/g, " ")
		.trim();
}

export async function fetchPage(url: string, fetchImpl: typeof fetch = fetch): Promise<string> {
	const r = await fetchImpl(url, { headers: { "user-agent": "Mozilla/5.0 (Macintosh) ContextDeck/0.4 (+research)", accept: "text/html,text/plain" }, signal: AbortSignal.timeout(15_000), redirect: "follow" });
	if (!r.ok) throw new Error(`HTTP ${r.status}`);
	const type = r.headers.get("content-type") ?? "";
	const body = await r.text();
	return type.includes("html") ? htmlToText(body) : body.slice(0, 12_000);
}

export function queriesFor(name: string, kind: "app" | "site", p: Platform, host?: string): string[] {
	const v = p.appVersion ? ` ${p.appVersion.split(".").slice(0, 2).join(".")}` : "";
	return kind === "site"
		? [`${host} keyboard shortcuts`, `${host} API status usage endpoint`]
		: [`${name}${v} keyboard shortcuts mac`, `${name} API OR scripting OR AppleScript status`];
}

export function digestPrompt(name: string, kind: "app" | "site", p: Platform, docs: { url: string; text: string }[]): { system: string; prompt: string } {
	const system = "You extract facts from documentation for a Stream Deck layout generator. Return ONLY a JSON object. Never invent shortcuts; only report what the documents state.";
	const prompt = `Target: ${kind === "site" ? `website ${name}` : `macOS app "${name}"${p.appVersion ? ` version ${p.appVersion}` : ""}`}.
Platform: ${p.os}, ${p.arch}, keyboard layout ${p.keyboard}, locale ${p.locale}${p.browser ? `, browser ${p.browser}` : ""}.

From the documents below, extract:
1. shortcuts: the keyboard shortcuts for THIS platform (macOS; translate Ctrl→Cmd only if the doc says the Mac uses Cmd). Write keys like "cmd+shift+n", single keys like "b".
2. info: useful read-only live values this ${kind} exposes and HOW they could be read (local file, AppleScript property, public HTTP API endpoint, on-screen text). E.g. usage %, reset time, unread count, queue status.
3. apis: official APIs that could power actions or info: name, docs URL, auth type, a secret name in UPPER_SNAKE like SERVICE_API_KEY or SERVICE_TOKEN, and the API host(s).
Use the source URL for each item.

Documents:
${docs.map((d, i) => `--- [${i + 1}] ${d.url}\n${d.text}`).join("\n\n")}

JSON shape: {"app": "...", "version": "...", "shortcuts": [{"action": "...", "keys": "...", "source": "url"}], "info": [{"what": "...", "how": "...", "source": "url"}], "apis": [{"name": "...", "docs": "url", "auth": "...", "secret": "SERVICE_API_KEY", "hosts": ["api.example.com"]}], "notes": "..."}`;
	return { system, prompt };
}
