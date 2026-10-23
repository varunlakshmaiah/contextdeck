/**
 * Portable shortcut syntax shared by every platform:  "cmd+shift+n", "ctrl+tab", "f5", "down down down".
 *   modifiers  cmd | shift | alt (opt, option) | ctrl (control) | fn | win (super, meta) | mod
 *   "mod" = cmd on macOS, ctrl on Windows/Linux (use it in layouts meant for every OS).
 *   "cmd" on Windows/Linux maps to settings.cmdKey ("ctrl" by default, or "win").
 */
export type Mod = "cmd" | "shift" | "alt" | "ctrl" | "fn" | "win" | "mod";

export const MOD_ALIASES: Record<string, Mod> = {
	cmd: "cmd", command: "cmd", shift: "shift", alt: "alt", opt: "alt", option: "alt", ctrl: "ctrl", control: "ctrl",
	fn: "fn", win: "win", super: "win", meta: "win", mod: "mod",
};

export const SPECIAL_KEYS = [
	"return", "enter", "tab", "space", "delete", "backspace", "esc", "escape", "left", "right", "up", "down", "home", "end", "pageup", "pagedown", "fwddelete",
	"f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9", "f10", "f11", "f12", "f13", "f14", "f15", "f16", "f17", "f18", "f19",
	"volumeup", "volumedown", "mute", "playpause", "nexttrack", "prevtrack",
] as const;
export const PUNCT_KEYS = ["[", "]", "=", "-", ",", ".", "/", ";", "'", "\\", "`"] as const;
const KEYS = new Set<string>([...SPECIAL_KEYS, ...PUNCT_KEYS, ..."abcdefghijklmnopqrstuvwxyz0123456789".split("")]);

export interface Chord { mods: Mod[]; key: string }

/** Parses one chord; throws a readable error for unknown names. kcNN (raw macOS key code) is allowed. */
export function parseChord(chord: string): Chord {
	const parts = chord.toLowerCase().split("+").map((p) => p.trim()).filter(Boolean);
	// "cmd++" / "cmd+=": a trailing "+" means the plus character itself
	if (chord.endsWith("++")) parts.push("+");
	const key = parts.pop() ?? "";
	const mods = parts.map((m) => {
		const v = MOD_ALIASES[m];
		if (!v) throw new Error(`Unknown modifier "${m}" in "${chord}"`);
		return v;
	});
	if (key === "+") return { mods: [...new Set([...mods, "shift" as Mod])], key: "=" };
	if (!KEYS.has(key) && !/^kc\d+$/.test(key)) throw new Error(`Unknown key "${key}" in "${chord}"`);
	return { mods, key };
}

/** Parses a space-separated sequence ("cmd+l alt+return"). */
export const parseSequence = (spec: string): Chord[] => spec.trim().split(/\s+/).filter(Boolean).map(parseChord);

/** Throws if any chord in the sequence is invalid. */
export function validateKeys(spec: string): void { parseSequence(spec); }

/** Resolves "mod" and (off macOS) "cmd" to the real modifier. */
export function resolveMods(mods: Mod[], os: "mac" | "win" | "linux", cmdKey: "ctrl" | "win" = "ctrl"): Exclude<Mod, "mod">[] {
	const out = mods.map((m) => (m === "mod" ? (os === "mac" ? "cmd" : "ctrl") : m === "cmd" && os !== "mac" ? cmdKey : m));
	return [...new Set(out)] as Exclude<Mod, "mod">[];
}
