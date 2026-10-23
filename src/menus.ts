/**
 * Reads the menu bar of a running app (names + real keyboard shortcuts) through System Events,
 * and clicks menu items by path. Uses the Accessibility permission Stream Deck already needs for keystrokes.
 */
import { KEY_CODES, run } from "./mac";

export interface MenuEntry {
	path: string[];       // ["View", "Zoom In"]
	chord?: string;       // "cmd+=" in ContextDeck chord syntax, if the item has a shortcut
	enabled?: boolean;
}

const SEP = "\u001e";

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

export async function scanMenus(bundleId: string, maxDepth = 2): Promise<MenuEntry[]> {
	const out = await run("/usr/bin/osascript", ["-e", MENU_SCAN_SCRIPT, bundleId, String(maxDepth)], { timeout: 90_000 });
	return parseMenuDump(out);
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
