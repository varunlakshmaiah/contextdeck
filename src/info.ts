/**
 * Info keys: read-only live values (usage %, unread count, render progress …) shown on keys and dials.
 * A source is fetched, a value extracted, then formatted, coloured by thresholds and turned into a 0..1 bar.
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { normalize } from "node:path";
import { osascript, run } from "./mac";
import { withSecrets, type SecretStore } from "./secrets";
import type { InfoSource, InfoSpec, SecretDecl } from "./types";

export interface InfoResult { value: unknown; text: string; progress?: number; color?: string; error?: string; at: number }

export interface InfoContext {
	state: Record<string, unknown>;
	secrets: SecretStore;
	decls: Record<string, SecretDecl>;
	fetchImpl?: typeof fetch;
}

// ---------- safety: what auto-generated layouts may use without review ----------

const COMMANDS: Record<string, string[] | "any"> = {
	"/usr/bin/pmset": ["-g"], "/bin/date": "any", "/bin/df": "any", "/usr/bin/uptime": "any", "/usr/bin/sw_vers": "any",
	"/usr/sbin/sysctl": ["-n"], "/usr/bin/defaults": ["read"], "/usr/sbin/ioreg": "any", "/usr/sbin/networksetup": ["-getairportnetwork", "-getinfo"],
	gh: ["api", "pr", "issue", "run", "status"], git: ["status", "log", "rev-parse", "branch", "-C"],
};
const UNSAFE_AS = /\b(do shell script|set |delete|click|keystroke|key code|make |move |duplicate|quit|open |close |save|empty|restart|shut down|log out|run script|load script|store script|write|activate)\b/i;

/** Read-only check for sources proposed by a model. Returns a reason when unsafe. */
export function unsafeReason(src: InfoSource): string | undefined {
	switch (src.type) {
		case "http": return src.method && src.method !== "GET" ? "only GET is allowed" : /^https?:\/\//.test(src.url) || src.url.startsWith("{{secret.") ? undefined : "URL must be http(s)";
		case "state": return undefined;
		case "uiText": return undefined;
		case "file": {
			const p = normalize(src.path.replace(/^~/, homedir()));
			return p.startsWith(homedir()) && !p.includes("/.ssh") && !/Keychains|\.contextdeck\/token/.test(p) ? undefined : "file must be inside your home folder (no keys/keychains)";
		}
		case "applescript": return UNSAFE_AS.test(src.script) ? "AppleScript may only read (get) values" : undefined;
		case "command": {
			const allowed = COMMANDS[src.cmd[0]];
			if (!allowed) return `command ${src.cmd[0]} isn't on the read-only list`;
			if (allowed !== "any" && !allowed.includes(src.cmd[1] ?? "")) return `${src.cmd[0]} ${src.cmd[1] ?? ""} isn't allowed`;
			return undefined;
		}
	}
}

// ---------- fetching ----------

export async function fetchSource(src: InfoSource, ic: InfoContext): Promise<unknown> {
	switch (src.type) {
		case "state": return ic.state[src.key];
		case "file": return parseMaybeJson(await readFile(src.path.replace(/^~/, homedir()), "utf8"));
		case "http": {
			const req = await withSecrets({ url: src.url, headers: src.headers ?? {} }, src.url, ic.decls, ic.secrets);
			const res = await (ic.fetchImpl ?? fetch)(req.url, { headers: req.headers, signal: AbortSignal.timeout(10_000) });
			const body = await res.text();
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			return parseMaybeJson(body);
		}
		case "applescript": return parseMaybeJson(await osascript(src.script, 8000));
		case "command": {
			const reason = unsafeReason(src);
			if (reason) throw new Error(reason);
			const bin = src.cmd[0].startsWith("/") ? src.cmd[0] : "/bin/zsh";
			const args = src.cmd[0].startsWith("/") ? src.cmd.slice(1) : ["-lc", src.cmd.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ")];
			return parseMaybeJson((await run(bin, args, { timeout: 10_000 })).trim());
		}
		case "uiText": {
			const target = src.app ? `(first application process whose bundle identifier is "${src.app.replace(/"/g, "")}")` : "(first application process whose frontmost is true)";
			const text = await osascript(`tell application "System Events" to tell ${target}\nset AppleScript's text item delimiters to linefeed\nreturn (value of every static text of entire contents of front window) as text\nend tell`, 15_000);
			const m = new RegExp(src.match, "i").exec(text);
			if (!m) throw new Error("text not on screen");
			return m[1] ?? m[0];
		}
	}
}

function parseMaybeJson(s: string): unknown {
	const t = s.trim();
	if (t.startsWith("{") || t.startsWith("[")) { try { return JSON.parse(t); } catch { /* text */ } }
	return t;
}

// ---------- extract / format ----------

export function extract(raw: unknown, path?: string): unknown {
	if (!path) return raw;
	if (path.startsWith("/") && path.lastIndexOf("/") > 0) {
		const end = path.lastIndexOf("/");
		const m = new RegExp(path.slice(1, end), path.slice(end + 1)).exec(typeof raw === "string" ? raw : JSON.stringify(raw));
		return m ? (m[1] ?? m[0]) : undefined;
	}
	let v: unknown = raw;
	for (const part of path.replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean)) {
		if (part === "length" && Array.isArray(v)) { v = v.length; continue; }
		v = v && typeof v === "object" ? (v as Record<string, unknown>)[part] : undefined;
	}
	return v;
}

const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" && !isNaN(Number(v)) ? Number(v) : NaN);

export function duration(sec: number): string {
	if (!isFinite(sec)) return "";
	const s = Math.max(0, Math.round(sec));
	const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
	return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : m ? `${m}m` : `${s}s`;
}

const FILTERS: Record<string, (v: unknown, now: number) => string> = {
	pct: (v) => { const n = num(v); return isNaN(n) ? String(v ?? "") : `${Math.round(n <= 1 ? n * 100 : n)}%`; },
	round: (v) => { const n = num(v); return isNaN(n) ? String(v ?? "") : String(Math.round(n)); },
	k: (v) => { const n = num(v); return isNaN(n) ? String(v ?? "") : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n)); },
	duration: (v) => duration(num(v)),
	until: (v, now) => { const t = typeof v === "number" ? (v < 1e12 ? v * 1000 : v) : Date.parse(String(v)); return isNaN(t) ? String(v ?? "") : t <= now ? "now" : duration((t - now) / 1000); },
	ago: (v, now) => { const t = typeof v === "number" ? (v < 1e12 ? v * 1000 : v) : Date.parse(String(v)); return isNaN(t) ? String(v ?? "") : `${duration((now - t) / 1000)} ago`; },
	money: (v) => { const n = num(v); return isNaN(n) ? String(v ?? "") : `$${n.toFixed(n < 10 ? 2 : 0)}`; },
	upper: (v) => String(v ?? "").toUpperCase(),
};

/** "{{value|pct}} · resets {{raw.reset_at|until}}" */
export function format(fmt: string | undefined, value: unknown, raw: unknown, now = Date.now()): string {
	if (!fmt) return value === undefined || value === null ? "—" : typeof value === "object" ? JSON.stringify(value).slice(0, 24) : String(value);
	return fmt.replace(/\{\{\s*([\w.[\]-]+)(?:\s*\|\s*(\w+))?\s*\}\}/g, (_, path: string, filter?: string) => {
		const v = path === "value" ? value : path.startsWith("raw.") ? extract(raw, path.slice(4)) : path === "raw" ? raw : undefined;
		return filter && FILTERS[filter] ? FILTERS[filter](v, now) : v === undefined || v === null ? "" : String(v);
	});
}

export function colorFor(value: unknown, thresholds: InfoSpec["thresholds"]): string | undefined {
	const n = num(value);
	for (const t of thresholds ?? []) {
		if (t.equals !== undefined && String(value) === t.equals) return t.color;
		if (t.above !== undefined && !isNaN(n) && n > t.above) return t.color;
		if (t.below !== undefined && !isNaN(n) && n < t.below) return t.color;
	}
	return undefined;
}

export async function evaluate(spec: InfoSpec, ic: InfoContext, now = Date.now()): Promise<InfoResult> {
	try {
		const raw = await fetchSource(spec.source, ic);
		const value = extract(raw, spec.extract);
		let progress: number | undefined;
		if (spec.progress) {
			const max = spec.progress.path ? num(extract(raw, spec.progress.path)) : spec.progress.max ?? 100;
			const n = num(value);
			if (!isNaN(n) && max > 0) progress = Math.max(0, Math.min(1, n / max));
		}
		return { value, text: format(spec.format, value, raw, now), progress, color: colorFor(value, spec.thresholds), at: now };
	} catch (e) {
		return { value: undefined, text: "—", error: (e as Error).message, at: now };
	}
}

export const intervalMs = (spec: InfoSpec) => Math.max(2, spec.every ?? (spec.source.type === "state" ? 2 : spec.source.type === "uiText" ? 30 : 60)) * 1000;
