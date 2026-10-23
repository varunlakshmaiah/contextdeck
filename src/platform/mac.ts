/** macOS adapter: built-in CLIs only (lsappinfo, osascript/System Events, security, pbcopy…). No native modules. */
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { menuClickScript, parseMenuDump, type MenuEntry } from "../menus";
import { parseChord, parseSequence, resolveMods } from "./chords";
import { MAC_KEY_CODES } from "./mac-keys";
import { errText, run } from "./run";
import type { Front, Platform, PlatformFacts } from "./types";

export { run } from "./run";
export const KEY_CODES = MAC_KEY_CODES;

export const osascript = (script: string, timeout = 4000) => run("/usr/bin/osascript", ["-e", script], { timeout }).then((s) => s.trim());

const asStr = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

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
const AS_MODS: Record<string, string> = { cmd: "command down", shift: "shift down", alt: "option down", ctrl: "control down", fn: "fn down" };

/** "cmd+shift+4" -> AppleScript line. Uses key codes so shortcuts work regardless of keyboard layout. */
export function chordToAppleScript(chord: string): string {
	const c = parseChord(chord);
	const mods = resolveMods(c.mods, "mac").map((m) => {
		if (m === "win") throw new Error(`"win" isn't a macOS modifier in "${chord}"`);
		return AS_MODS[m];
	});
	const raw = /^kc(\d+)$/.exec(c.key);
	const code = raw ? Number(raw[1]) : MAC_KEY_CODES[c.key];
	if (code === undefined) throw new Error(`Key "${c.key}" can't be sent on macOS ("${chord}")`);
	return `key code ${code}${mods.length ? ` using {${mods.join(", ")}}` : ""}`;
}

const MEDIA: Record<string, string> = {
	volumeup: "set volume output volume ((output volume of (get volume settings)) + 6)",
	volumedown: "set volume output volume ((output volume of (get volume settings)) - 6)",
	mute: "set volume output muted (not (output muted of (get volume settings)))",
};

export async function sendKeys(spec: string): Promise<void> {
	const chords = parseSequence(spec);
	const lines: string[] = [];
	for (const c of chords) {
		if (MEDIA[c.key]) { await osascript(MEDIA[c.key]); continue; }
		if (["playpause", "nexttrack", "prevtrack"].includes(c.key)) throw new Error(`${c.key} isn't supported on macOS yet`);
		lines.push(chordToAppleScript([...c.mods, c.key].join("+")));
	}
	if (lines.length) await osascript(`tell application "System Events"\n ${lines.join("\n delay 0.05\n ")}\nend tell`);
}

export const typeText = async (text: string) => void (await osascript(`tell application "System Events" to keystroke ${asStr(text)}`, 15000));

// ---------- misc ----------
export const shell = (cmd: string) =>
	new Promise<void>((resolve, reject) => {
		const p = spawn("/bin/zsh", ["-lc", cmd], { detached: true, stdio: "ignore" });
		p.on("error", reject);
		p.on("spawn", () => { p.unref(); resolve(); });
	});

export const open = async (target: string) =>
	void (await (/^[a-z][\w+.-]*:/i.test(target) || target.startsWith("/") || target.startsWith("~")
		? run("/usr/bin/open", [target.replace(/^~/, homedir())])
		: run("/usr/bin/open", ["-a", target])));

export const getClipboard = () => run("/usr/bin/pbpaste", []);
export const setClipboard = async (text: string) => void (await run("/usr/bin/pbcopy", [], { input: text }));

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

export const notify = async (text: string, title = "ContextDeck") =>
	void (await osascript(`display notification ${asStr(text.slice(0, 240))} with title ${asStr(title)}`).catch(() => undefined));

export async function getVolume(): Promise<number> {
	return Number(await osascript("output volume of (get volume settings)")) || 0;
}
export const setVolume = async (v: number) => void (await osascript(`set volume output volume ${Math.round(Math.max(0, Math.min(100, v)))}`));
export const toggleMute = async () => void (await osascript("set volume output muted (not (output muted of (get volume settings)))"));

// ---------- Keychain ----------
export async function keychainSecret(service: string, account: string): Promise<string | undefined> {
	try {
		return (await run("/usr/bin/security", ["find-generic-password", "-s", service, "-a", account, "-w"])).trim() || undefined;
	} catch {
		return undefined;
	}
}
const q = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
/** `security -i` reads the command from stdin, so the value never appears in the process list. */
export const keychainSet = async (service: string, account: string, value: string) =>
	void (await run("/usr/bin/security", ["-i"], { input: `add-generic-password -U -s ${q(service)} -a ${q(account)} -w ${q(value)}\n`, timeout: 8000 }));
export const keychainDelete = async (service: string, account: string) =>
	void (await run("/usr/bin/security", ["delete-generic-password", "-s", service, "-a", account]).catch(() => ""));

// ---------- menus (Accessibility) ----------
/** AppleScript: dumps every menu (top level + `maxDepth`-1 submenu levels) as tab-separated lines. */
export const MENU_SCAN_SCRIPT = `
on run argv
	set bid to item 1 of argv
	set maxDepth to (item 2 of argv) as integer
	set out to {}
	tell application "System Events"
		set procs to (application processes whose bundle identifier is bid)
		if (count of procs) is 0 then error "Process not running: " & bid
		set p to item 1 of procs
		set mb to menu bar 1 of p
		set tops to name of menu bar items of mb
	end tell
	repeat with i from 2 to count of tops
		set tName to item i of tops
		if tName is not missing value then
			try
				tell application "System Events" to set m to menu 1 of menu bar item i of mb
				my dumpMenu(m, tName, out, 1, maxDepth)
			end try
		end if
	end repeat
	set AppleScript's text item delimiters to linefeed
	return out as text
end run

on fmt(v)
	if v is missing value then return ""
	try
		return v as text
	on error
		return ""
	end try
end fmt

on dumpMenu(m, prefix, out, depth, maxDepth)
	tell application "System Events"
		set nms to name of menu items of m
		try
			set chs to value of attribute "AXMenuItemCmdChar" of menu items of m
			set mds to value of attribute "AXMenuItemCmdModifiers" of menu items of m
			set vks to value of attribute "AXMenuItemCmdVirtualKey" of menu items of m
			set ens to enabled of menu items of m
		on error
			set chs to {}
			set mds to {}
			set vks to {}
			set ens to {}
			repeat with j from 1 to count of nms
				try
					set end of chs to value of attribute "AXMenuItemCmdChar" of menu item j of m
				on error
					set end of chs to missing value
				end try
				try
					set end of mds to value of attribute "AXMenuItemCmdModifiers" of menu item j of m
				on error
					set end of mds to missing value
				end try
				try
					set end of vks to value of attribute "AXMenuItemCmdVirtualKey" of menu item j of m
				on error
					set end of vks to missing value
				end try
				set end of ens to true
			end repeat
		end try
	end tell
	repeat with j from 1 to count of nms
		set nm to item j of nms
		if nm is not missing value and nm is not "" then
			set c to my fmt(item j of chs)
			set end of out to prefix & tab & nm & tab & c & tab & my fmt(item j of mds) & tab & my fmt(item j of vks) & tab & my fmt(item j of ens)
			if c is "" and depth < maxDepth then
				try
					tell application "System Events" to set sm to menu 1 of menu item j of m
					my dumpMenu(sm, prefix & (character id 30) & nm, out, depth + 1, maxDepth)
				end try
			end if
		end if
	end repeat
end dumpMenu
`;


export async function scanMenus(bundleId: string, maxDepth = 2): Promise<MenuEntry[]> {
	const out = await run("/usr/bin/osascript", ["-e", MENU_SCAN_SCRIPT, bundleId, String(maxDepth)], { timeout: 90_000 });
	return parseMenuDump(out);
}

export async function readWindowText(appId?: string): Promise<string> {
	const target = appId ? `(first application process whose bundle identifier is ${asStr(appId)})` : "(first application process whose frontmost is true)";
	return osascript(`tell application "System Events" to tell ${target}\nset AppleScript's text item delimiters to linefeed\nreturn (value of every static text of entire contents of front window) as text\nend tell`, 15_000);
}

// ---------- facts ----------
const versionCache = new Map<string, string>();
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

export async function facts(bundleId?: string): Promise<PlatformFacts> {
	const safe = async (f: () => Promise<string>) => { try { return (await f()).trim(); } catch { return ""; } };
	const ver = await safe(() => run("/usr/bin/sw_vers", ["-productVersion"]));
	const arch = await safe(() => run("/usr/bin/uname", ["-m"]));
	const sources = await safe(() => run("/usr/bin/defaults", ["read", `${homedir()}/Library/Preferences/com.apple.HIToolbox.plist`, "AppleSelectedInputSources"]));
	const keyboard = /"KeyboardLayout Name"\s*=\s*"?([^";\n]+)"?/.exec(sources)?.[1]?.trim() ?? "U.S.";
	return { os: `macOS ${ver || "?"}`, arch: arch || "?", keyboard, locale: Intl.DateTimeFormat().resolvedOptions().locale, appVersion: bundleId ? (await appVersionOf(bundleId)) || undefined : undefined };
}

// ---------- the adapter ----------
export const macPlatform: Platform = {
	id: "mac",
	name: "macOS",
	caps: { menus: true, browserTab: true, windowText: true, scripts: ["applescript", "jxa"], volume: true },
	browsers: BROWSERS,
	commandAllowlist: {
		"/usr/bin/pmset": ["-g"], "/bin/date": "any", "/bin/df": "any", "/usr/bin/uptime": "any", "/usr/bin/sw_vers": "any",
		"/usr/sbin/sysctl": ["-n"], "/usr/bin/defaults": ["read"], "/usr/sbin/ioreg": "any", "/usr/sbin/networksetup": ["-getairportnetwork", "-getinfo"],
		gh: ["api", "pr", "issue", "run", "status"], git: ["status", "log", "rev-parse", "branch", "-C"],
	},
	frontmost,
	browserTab,
	windowTitle,
	readWindowText,
	sendKeys: (spec) => sendKeys(spec),
	typeText,
	shell,
	open,
	runScript: async (script, lang = "applescript", timeoutMs = 30_000) =>
		lang === "jxa" ? (await run("/usr/bin/osascript", ["-l", "JavaScript", "-e", script], { timeout: timeoutMs })).trim() : osascript(script, timeoutMs),
	getClipboard,
	setClipboard,
	copySelection,
	notify,
	prompt: promptHidden,
	getVolume,
	setVolume,
	toggleMute,
	secretGet: (account) => keychainSecret("contextdeck", account),
	secretSet: (account, value) => keychainSet("contextdeck", account, value),
	secretDelete: (account) => keychainDelete("contextdeck", account),
	scanMenus: (appId) => scanMenus(appId),
	clickMenu: async (appId, path) => void (await osascript(menuClickScript(appId, path), 8000)),
	appVersion: appVersionOf,
	facts,
};
