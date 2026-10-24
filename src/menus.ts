/**
 * Menu bar data model + parsers shared by the platform adapters
 * (macOS: Accessibility via System Events; Windows: UI Automation accelerator text).
 */
import { MAC_KEY_CODES as KEY_CODES } from "./platform/mac-keys";

export interface MenuEntry {
	path: string[];       // ["View", "Zoom In"]
	chord?: string;       // "cmd+=" in ContextDeck chord syntax, if the item has a shortcut
	enabled?: boolean;
}

export const SEP = "\u001e";

const SPECIAL: Record<string, string> = {
	"": "up", "": "down", "": "left", "": "right",
	"": "f1", "": "f2", "": "f3", "": "f4", "": "f5", "": "f6", "": "f7", "": "f8",
	"": "f9", "": "f10", "": "f11", "": "f12", "": "f13", "": "f14", "": "f15",
	"": "fwddelete", "": "home", "": "end", "": "pageup", "": "pagedown",
	"\u0008": "delete", "\u007F": "delete", "⌫": "delete", "⌦": "fwddelete", "\u001B": "esc", "⎋": "esc",
	"\r": "return", "↩": "return", "\u0003": "enter", "⌤": "enter", "\t": "tab", "⇥": "tab", " ": "space", "␣": "space",
	"←": "left", "→": "right", "↑": "up", "↓": "down",
};
const SHIFTED: Record<string, string> = {
	"+": "=", "_": "-", "?": "/", "{": "[", "}": "]", "<": ",", ">": ".", ":": ";", '"': "'", "|": "\\", "~": "`",
	"!": "1", "@": "2", "#": "3", "$": "4", "%": "5", "^": "6", "&": "7", "*": "8", "(": "9", ")": "0",
};
const NAME_BY_CODE = new Map<number, string>();
for (const [name, code] of Object.entries(KEY_CODES)) if (!NAME_BY_CODE.has(code)) NAME_BY_CODE.set(code, name);

/** Converts an AX shortcut (char, modifier mask, virtual key) to a ContextDeck chord, or undefined. */
export function axToChord(char: string, modsRaw: string, vkRaw: string): string | undefined {
	if (!char && !vkRaw) return undefined;
	const mods = Number(modsRaw || 0);
	const parts: string[] = [];
	if (mods & 4) parts.push("ctrl");
	if (mods & 2) parts.push("alt");
	if (mods & 1) parts.push("shift");
	if (!(mods & 8)) parts.push("cmd");
	let key: string | undefined;
	if (char) {
		if (SPECIAL[char]) key = SPECIAL[char];
		else if (char.length === 1 && KEY_CODES[char.toLowerCase()] !== undefined) key = char.toLowerCase();
		else if (SHIFTED[char]) { key = SHIFTED[char]; if (!parts.includes("shift")) parts.splice(parts.length - (parts.includes("cmd") ? 1 : 0), 0, "shift"); }
	}
	if (!key && vkRaw !== "" && Number.isFinite(Number(vkRaw)) && char === "") {
		const vk = Number(vkRaw);
		key = NAME_BY_CODE.get(vk) ?? `kc${vk}`;
	}
	if (!key) return undefined;
	if (parts.length === 0 && /^[a-z0-9]$/.test(key)) return undefined; // bare letters aren't menu shortcuts
	return [...parts, key].join("+");
}

export function parseMenuDump(text: string): MenuEntry[] {
	const out: MenuEntry[] = [];
	for (const line of text.split(/\r?\n/)) {
		if (!line.trim()) continue;
		const [prefix, name, char = "", mods = "", vk = "", enabled = ""] = line.split("\t");
		if (!prefix || !name) continue;
		const path = [...prefix.split(SEP), name].map((s) => s.trim());
		out.push({ path, chord: axToChord(char, mods, vk), enabled: enabled !== "false" });
	}
	return out;
}

const q = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** AppleScript that clicks a menu item by path in the given app. */
export function menuClickScript(bundleId: string, path: string[]): string {
	if (path.length < 2) throw new Error(`Menu path needs at least 2 parts: ${path.join(" > ")}`);
	let ref = `menu bar item ${q(path[0])} of menu bar 1 of (first application process whose bundle identifier is ${q(bundleId)})`;
	for (const p of path.slice(1, -1)) ref = `menu item ${q(p)} of menu 1 of ${ref}`;
	ref = `menu item ${q(path[path.length - 1])} of menu 1 of ${ref}`;
	return `tell application "System Events" to click ${ref}`;
}

/** Items that never make useful deck keys. */
const BOILERPLATE = /^(about .*|services|hide .*|hide others|show all|quit .*|settings…|preferences…|check for updates.*|minimize|zoom|bring all to front|enter full screen|exit full screen|.*help|close window|close|cut|copy|paste|select all|emoji & symbols|start dictation.*|autofill|show tab bar|show all tabs|move window to .*|tile window .*|remove window from set|merge all windows|fill|center|move & resize|full screen tile)$/i;

export function usefulEntries(entries: MenuEntry[], app: string): MenuEntry[] {
	return entries.filter((e) => {
		const last = e.path[e.path.length - 1];
		if (BOILERPLATE.test(last)) return false;
		if (e.path[0] === "Window" && !e.chord) return false;
		if (e.path[0] === app && !e.chord) return false; // app menu items without shortcuts
		if (/^\d+$/.test(last) || last.length > 60) return false;
		return true;
	});
}

/** Windows/Linux accelerator text ("Ctrl+Shift+N", "Alt+F4", "Ctrl+=") → ContextDeck chord ("ctrl+shift+n"). */
export function acceleratorToChord(text: string): string | undefined {
	const t = text.trim();
	if (!t) return undefined;
	const parts = t.split("+").map((p) => p.trim().toLowerCase());
	if (t.endsWith("++")) { parts.splice(-2, 2, "="); parts.unshift("shift"); }
	const key = parts.pop() ?? "";
	const MOD: Record<string, string> = { ctrl: "ctrl", control: "ctrl", strg: "ctrl", shift: "shift", umschalt: "shift", alt: "alt", win: "win", windows: "win", super: "win", cmd: "cmd" };
	const mods: string[] = [];
	for (const p of parts) { const m = MOD[p]; if (!m) return undefined; mods.push(m); }
	const NAMES: Record<string, string> = { del: "fwddelete", delete: "fwddelete", ins: "insert", insert: "insert", prtsc: "print", print: "print", enter: "return", esc: "esc", escape: "esc", tab: "tab", space: "space", backspace: "delete", bksp: "delete",
		left: "left", right: "right", up: "up", down: "down", home: "home", end: "end", pgup: "pageup", pageup: "pageup", pgdn: "pagedown", pagedown: "pagedown", plus: "=", minus: "-", "num +": "=", "num -": "-" };
	let k = NAMES[key] ?? key;
	if (/^f([1-9]|1[0-9])$/.test(k) || /^[a-z0-9]$/.test(k) || ["[", "]", "=", "-", ",", ".", "/", ";", "'", "\\", "`"].includes(k) || ["return", "tab", "space", "delete", "fwddelete", "esc", "left", "right", "up", "down", "home", "end", "pageup", "pagedown"].includes(k)) {
		if (!mods.length && /^[a-z0-9]$/.test(k)) return undefined;
		return [...mods, k].join("+");
	}
	return undefined;
}

/** Generic dump format used by non-mac adapters: path parts joined by SEP, then TAB, then accelerator text. */
export function parseAcceleratorDump(text: string): MenuEntry[] {
	const out: MenuEntry[] = [];
	for (const line of text.split(/\r?\n/)) {
		if (!line.trim()) continue;
		const [p, accel = "", enabled = ""] = line.split("\t");
		const path = p.split(SEP).map((x) => x.replace(/&(?=\w)/g, "").trim()).filter(Boolean);
		if (path.length < 2) continue;
		out.push({ path, chord: acceleratorToChord(accel), enabled: enabled !== "false" });
	}
	return out;
}
