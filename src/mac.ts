/** macOS glue: context detection and OS-level actions, all via built-in CLIs (no native deps). */
import { execFile, spawn } from "node:child_process";

export function run(cmd: string, args: string[], opts: { timeout?: number; input?: string } = {}): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = execFile(cmd, args, { timeout: opts.timeout ?? 4000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
			if (err) reject(Object.assign(err, { stderr: String(stderr) }));
			else resolve(String(stdout));
		});
		if (opts.input !== undefined) {
			child.stdin?.end(opts.input);
		}
	});
}

export const osascript = (script: string, timeout = 4000) => run("/usr/bin/osascript", ["-e", script], { timeout }).then((s) => s.trim());

const asStr = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

export interface Front { bundleId: string; app: string; via: string; errors: string[] }

/** Parses `lsappinfo info` output in any of its formats ("CFBundleIdentifier"="x" or bundleID="x"). */
export function parseLsappinfo(out: string): { bundleId: string; app: string } {
	const pick = (...keys: string[]) => {
		for (const k of keys) {
			const m = new RegExp(`"?${k}"?\\s*=\\s*"([^"]*)"`, "i").exec(out);
			if (m) return m[1];
		}
		return "";
	};
	return { bundleId: pick("CFBundleIdentifier", "bundleID"), app: pick("LSDisplayName", "name", "CFBundleName") };
}

let preferred: "lsappinfo" | "jxa" | "systemevents" | undefined;

const nameCache = new Map<string, string>();
/** Display name for a running app; cached per bundle id. Full `lsappinfo info` starts with "Name" ASN:… */
export async function appName(bundleId: string): Promise<string> {
	const hit = nameCache.get(bundleId);
	if (hit !== undefined) return hit;
	let name = "";
	try {
		const out = await run("/bin/sh", ["-c", "/usr/bin/lsappinfo info \"$(/usr/bin/lsappinfo front)\""], { timeout: 1500 });
		name = parseAppName(out);
	} catch { /* fall through */ }
	if (!name) {
		try {
			name = (await run("/usr/bin/osascript", ["-l", "JavaScript", "-e", "ObjC.import('AppKit'); $.NSWorkspace.sharedWorkspace.frontmostApplication.localizedName.js"], { timeout: 2500 })).trim();
		} catch { /* fall through */ }
	}
	if (!name) name = prettyBundle(bundleId);
	nameCache.set(bundleId, name);
	return name;
}

export function parseAppName(out: string): string {
	return /^\s*"([^"]+)"\s+ASN:/m.exec(out)?.[1] ?? parseLsappinfo(out).app;
}

/** com.anthropic.claudefordesktop -> Claudefordesktop (last resort). */
export const prettyBundle = (b: string) => {
	const last = b.split(".").pop() ?? b;
	return last.charAt(0).toUpperCase() + last.slice(1);
};

/**
 * Frontmost app, trying three methods and remembering the first that works:
 *  1. lsappinfo (fast, no permissions)
 *  2. JXA NSWorkspace (no permissions)
 *  3. System Events (needs Automation permission for System Events)
 */
export async function frontmost(): Promise<Front> {
	const errors: string[] = [];
	const methods = {
		lsappinfo: async () => parseLsappinfo(await run("/bin/sh", ["-c", "ASN=\"$(/usr/bin/lsappinfo front)\"; /usr/bin/lsappinfo info -only bundleid \"$ASN\"; /usr/bin/lsappinfo info -only name \"$ASN\""], { timeout: 1500 })),
		jxa: async () => {
			const out = (await run("/usr/bin/osascript", ["-l", "JavaScript", "-e", "ObjC.import('AppKit'); var a = $.NSWorkspace.sharedWorkspace.frontmostApplication; a.bundleIdentifier.js + '\\n' + a.localizedName.js"], { timeout: 2500 })).trim();
			const [bundleId = "", app = ""] = out.split("\n");
			return { bundleId, app };
		},
		systemevents: async () => {
			const out = await osascript(`tell application "System Events" to set p to first application process whose frontmost is true\nreturn (bundle identifier of p) & linefeed & (name of p)`, 2500);
			const [bundleId = "", app = ""] = out.split("\n");
			return { bundleId, app };
		},
	};
	const order = (preferred ? [preferred, ...Object.keys(methods).filter((m) => m !== preferred)] : Object.keys(methods)) as (keyof typeof methods)[];
	for (const m of order) {
		try {
			const r = await methods[m]();
			if (r.bundleId) {
				preferred = m;
				if (!r.app) r.app = await appName(r.bundleId);
				return { ...r, via: m, errors };
			}
			errors.push(`${m}: empty result`);
		} catch (e) {
			errors.push(`${m}: ${((e as { stderr?: string }).stderr || (e as Error).message).trim().slice(0, 200)}`);
		}
	}
	preferred = undefined;
	return { bundleId: "", app: "", via: "none", errors };
}

const CHROMIUM = ["com.google.Chrome", "com.google.Chrome.beta", "com.brave.Browser", "com.microsoft.edgemac", "company.thebrowser.Browser", "com.vivaldi.Vivaldi", "com.operasoftware.Opera"];
const SAFARI = ["com.apple.Safari", "com.apple.SafariTechnologyPreview"];
export const BROWSERS = [...CHROMIUM, ...SAFARI];

export async function browserUrl(bundleId: string): Promise<string> {
	return (await browserTab(bundleId)).url;
}

/** URL + title of the active tab in one Apple Event round-trip. */
export async function browserTab(bundleId: string): Promise<{ url: string; title: string }> {
	let out = "";
	if (CHROMIUM.includes(bundleId)) out = await osascript(`tell application id ${asStr(bundleId)} to tell active tab of front window to return (URL as text) & linefeed & (title as text)`, 1500);
	else if (SAFARI.includes(bundleId)) out = await osascript(`tell application id ${asStr(bundleId)} to tell front document to return (URL as text) & linefeed & (name as text)`, 1500);
	const [url = "", ...rest] = out.split("\n");
	return { url: url.trim(), title: rest.join(" ").trim() };
}

/** Native password-style prompt; returns undefined if cancelled. */
export async function promptHidden(title: string, message: string): Promise<string | undefined> {
	try {
		const out = await osascript(`set r to display dialog ${asStr(message)} default answer "" with hidden answer buttons {"Cancel", "Save"} default button "Save" with title ${asStr(title)}\nreturn text returned of r`, 300_000);
		return out || undefined;
	} catch {
		return undefined;
	}
}

export async function windowTitle(): Promise<string> {
	return osascript(`tell application "System Events" to get name of front window of (first application process whose frontmost is true)`, 1500);
}

// ---------- keystrokes ----------
export const KEY_CODES: Record<string, number> = {
	return: 36, enter: 76, tab: 48, space: 49, delete: 51, backspace: 51, esc: 53, escape: 53,
	left: 123, right: 124, down: 125, up: 126, home: 115, end: 119, pageup: 116, pagedown: 121, fwddelete: 117,
	f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97, f7: 98, f8: 100, f9: 101, f10: 109, f11: 103, f12: 111,
	f13: 105, f14: 107, f15: 113, f16: 106, f17: 64, f18: 79, f19: 80,
	"[": 33, "]": 30, "=": 24, "-": 27, ",": 43, ".": 47, "/": 44, ";": 41, "'": 39, "\\": 42, "`": 50,
	"0": 29, "1": 18, "2": 19, "3": 20, "4": 21, "5": 23, "6": 22, "7": 26, "8": 28, "9": 25,
	a: 0, b: 11, c: 8, d: 2, e: 14, f: 3, g: 5, h: 4, i: 34, j: 38, k: 40, l: 37, m: 46, n: 45, o: 31, p: 35, q: 12, r: 15, s: 1, t: 17, u: 32, v: 9, w: 13, x: 7, y: 16, z: 6,
};
const MODS: Record<string, string> = { cmd: "command down", command: "command down", shift: "shift down", alt: "option down", opt: "option down", option: "option down", ctrl: "control down", control: "control down", fn: "fn down" };

/** "cmd+shift+4" -> AppleScript line. Uses key codes so shortcuts work regardless of keyboard layout. */
export function chordToAppleScript(chord: string): string {
	const parts = chord.toLowerCase().split("+").map((p) => p.trim()).filter(Boolean);
	const key = parts.pop() ?? "";
	const mods = parts.map((m) => {
		const v = MODS[m];
		if (!v) throw new Error(`Unknown modifier "${m}" in "${chord}"`);
		return v;
	});
	const raw = /^kc(\d+)$/.exec(key);
	const code = raw ? Number(raw[1]) : KEY_CODES[key];
	if (code === undefined) throw new Error(`Unknown key "${key}" in "${chord}"`);
	return `key code ${code}${mods.length ? ` using {${mods.join(", ")}}` : ""}`;
}

export async function sendKeys(spec: string): Promise<void> {
	const lines = spec.trim().split(/\s+/).filter(Boolean).map(chordToAppleScript);
	const body = lines.join("\n delay 0.05\n ");
	await osascript(`tell application "System Events"\n ${body}\nend tell`);
}

export const typeText = (text: string) => osascript(`tell application "System Events" to keystroke ${asStr(text)}`, 15000);

// ---------- misc ----------
export const shell = (cmd: string) =>
	new Promise<void>((resolve, reject) => {
		const p = spawn("/bin/zsh", ["-lc", cmd], { detached: true, stdio: "ignore" });
		p.on("error", reject);
		p.on("spawn", () => { p.unref(); resolve(); });
	});

export const open = (target: string) =>
	/^[a-z][\w+.-]*:/i.test(target) || target.startsWith("/") || target.startsWith("~")
		? run("/usr/bin/open", [target.replace(/^~/, process.env.HOME ?? "~")])
		: run("/usr/bin/open", ["-a", target]);

export const getClipboard = () => run("/usr/bin/pbpaste", []);
export const setClipboard = (text: string) => run("/usr/bin/pbcopy", [], { input: text });

export async function copySelection(): Promise<string> {
	const marker = `__contextdeck_${Date.now()}__`;
	const previous = await getClipboard().catch(() => "");
	await setClipboard(marker);
	await sendKeys("cmd+c");
	for (let i = 0; i < 15; i++) {
		await new Promise((r) => setTimeout(r, 60));
		const now = await getClipboard();
		if (now !== marker) return now;
	}
	await setClipboard(previous);
	return "";
}

export const notify = (text: string, title = "ContextDeck") =>
	osascript(`display notification ${asStr(text.slice(0, 240))} with title ${asStr(title)}`).catch(() => undefined);

export async function getVolume(): Promise<number> {
	return Number(await osascript("output volume of (get volume settings)")) || 0;
}
export const setVolume = (v: number) => osascript(`set volume output volume ${Math.round(Math.max(0, Math.min(100, v)))}`);
export const toggleMute = () => osascript("set volume output muted (not (output muted of (get volume settings)))");

export async function keychainSecret(service: string, account: string): Promise<string | undefined> {
	try {
		return (await run("/usr/bin/security", ["find-generic-password", "-s", service, "-a", account, "-w"])).trim() || undefined;
	} catch {
		return undefined;
	}
}
