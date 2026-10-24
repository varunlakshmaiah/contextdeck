/**
 * Linux adapter (for OpenDeck). Uses common desktop tools, each optional; whatever is missing degrades gracefully:
 *   front window  hyprctl (Hyprland) → swaymsg (Sway) → kdotool (KDE) → GNOME "Window Calls" extension → xprop/xdotool (X11 / XWayland)
 *   keys/typing   wtype (wlroots Wayland) → ydotool (any Wayland, needs ydotoold) → xdotool (X11)
 *   clipboard     wl-copy/wl-paste → xclip
 *   secrets       secret-tool (libsecret: GNOME Keyring / KWallet)
 *   prompt        zenity → kdialog
 *   volume        wpctl (PipeWire) → pactl (PulseAudio)
 *   browser tab   the ContextDeck browser extension (no portable OS API)
 *   menus         not available (✨ Set up uses research + model knowledge)
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { parseSequence, resolveMods, type Chord } from "./chords";
import { copyViaClipboard, stripBrowserSuffix } from "./common";
import { errText, run } from "./run";
import { Unsupported, type Front, type Platform, type PlatformFacts } from "./types";

const XDO_KEYS: Record<string, string> = {
	return: "Return", enter: "KP_Enter", tab: "Tab", space: "space", delete: "BackSpace", backspace: "BackSpace", fwddelete: "Delete", esc: "Escape", escape: "Escape",
	left: "Left", right: "Right", up: "Up", down: "Down", home: "Home", end: "End", pageup: "Prior", pagedown: "Next",
	"=": "equal", "-": "minus", ",": "comma", ".": "period", "/": "slash", ";": "semicolon", "'": "apostrophe", "[": "bracketleft", "]": "bracketright", "\\": "backslash", "`": "grave",
	print: "Print", insert: "Insert", volumeup: "XF86AudioRaiseVolume", volumedown: "XF86AudioLowerVolume", mute: "XF86AudioMute", playpause: "XF86AudioPlay", nexttrack: "XF86AudioNext", prevtrack: "XF86AudioPrev",
};
const XDO_MODS: Record<string, string> = { ctrl: "ctrl", shift: "shift", alt: "alt", win: "super" };

/** Chord → xdotool/wtype key names, e.g. { mods: ["ctrl","shift"], key: "t" }. */
export function chordToXdo(c: Chord, cmdKey: "ctrl" | "win" = "ctrl"): { mods: string[]; key: string } {
	const mods = resolveMods(c.mods, "linux", cmdKey).map((m) => {
		if (m === "fn") throw new Error("fn can't be sent on Linux");
		return XDO_MODS[m];
	});
	const key = /^f\d+$/.test(c.key) ? c.key.toUpperCase() : XDO_KEYS[c.key] ?? c.key;
	if (/^kc\d+$/.test(key)) throw new Error("Raw macOS key codes can't be sent on Linux");
	return { mods, key };
}

/** Parses `xprop -id <w> WM_CLASS _NET_WM_NAME _NET_WM_PID`. */
export function parseXprop(out: string): { appId: string; title: string; pid?: number } {
	const cls = /WM_CLASS\([^)]*\)\s*=\s*"([^"]*)"(?:,\s*"([^"]*)")?/.exec(out);
	const title = /_NET_WM_NAME\([^)]*\)\s*=\s*"((?:[^"\\]|\\.)*)"/.exec(out)?.[1] ?? "";
	const pid = Number(/_NET_WM_PID\([^)]*\)\s*=\s*(\d+)/.exec(out)?.[1]) || undefined;
	return { appId: (cls?.[2] || cls?.[1] || "").toLowerCase(), title: title.replace(/\\"/g, '"'), pid };
}

const has = async (bin: string) => { try { await run("/bin/sh", ["-c", `command -v ${bin}`], { timeout: 1000 }); return true; } catch { return false; } };

export function makeLinuxPlatform(cmdKey: () => "ctrl" | "win" = () => "ctrl"): Platform {
	const wayland = !!process.env.WAYLAND_DISPLAY;
	const tools = new Map<string, Promise<boolean>>();
	const can = (bin: string) => { if (!tools.has(bin)) tools.set(bin, has(bin)); return tools.get(bin)!; };
	let lastTitle = "";

	const frontmost = async (): Promise<Front> => {
		const errors: string[] = [];
		const done = (via: string, appId: string, title: string, pid?: number): Front => { lastTitle = title; return { bundleId: appId.toLowerCase(), app: prettyName(appId), pid, via, errors }; };
		if (process.env.HYPRLAND_INSTANCE_SIGNATURE && (await can("hyprctl"))) {
			try { const j = JSON.parse(await run("hyprctl", ["activewindow", "-j"], { timeout: 1500 })); if (j.class) return done("hyprctl", j.class, j.title ?? "", j.pid); } catch (e) { errors.push(`hyprctl: ${errText(e)}`); }
		}
		if (process.env.SWAYSOCK && (await can("swaymsg"))) {
			try {
				const tree = JSON.parse(await run("swaymsg", ["-t", "get_tree"], { timeout: 1500 }));
				const f = findFocused(tree);
				if (f) return done("swaymsg", f.app_id ?? f.window_properties?.class ?? "", f.name ?? "", f.pid);
			} catch (e) { errors.push(`swaymsg: ${errText(e)}`); }
		}
		if (await can("kdotool")) {
			try {
				const w = (await run("kdotool", ["getactivewindow"], { timeout: 1500 })).trim();
				const cls = (await run("kdotool", ["getwindowclassname", w], { timeout: 1500 })).trim();
				const name = (await run("kdotool", ["getwindowname", w], { timeout: 1500 })).trim();
				if (cls) return done("kdotool", cls, name);
			} catch (e) { errors.push(`kdotool: ${errText(e)}`); }
		}
		if (wayland && (await can("gdbus"))) {
			try {
				const out = await run("gdbus", ["call", "--session", "--dest", "org.gnome.Shell", "--object-path", "/org/gnome/Shell/Extensions/Windows", "--method", "org.gnome.Shell.Extensions.Windows.List"], { timeout: 1500 });
				const json = out.slice(out.indexOf("'") + 1, out.lastIndexOf("'"));
				const f = (JSON.parse(json) as { focus?: boolean; wm_class?: string; title?: string; pid?: number }[]).find((w) => w.focus);
				if (f?.wm_class) return done("gnome-window-calls", f.wm_class, f.title ?? "", f.pid);
			} catch (e) { errors.push(`gnome: ${errText(e)}`); }
		}
		if (await can("xprop")) {
			try {
				const id = /window id # (0x[0-9a-f]+)/i.exec(await run("xprop", ["-root", "_NET_ACTIVE_WINDOW"], { timeout: 1500 }))?.[1];
				if (id && id !== "0x0") {
					const p = parseXprop(await run("xprop", ["-id", id, "WM_CLASS", "_NET_WM_NAME", "_NET_WM_PID"], { timeout: 1500 }));
					if (p.appId) return done("xprop", p.appId, p.title, p.pid);
				}
			} catch (e) { errors.push(`xprop: ${errText(e)}`); }
		}
		return { bundleId: "", app: "", via: "none", errors: errors.length ? errors : ["no supported window tool found (install xprop, kdotool, or the GNOME 'Window Calls' extension)"] };
	};

	const sendKeys = async (spec: string, opts?: { cmdKey?: "ctrl" | "win" }) => {
		const chords = parseSequence(spec).map((c) => chordToXdo(c, opts?.cmdKey ?? cmdKey()));
		if (wayland && (await can("wtype"))) {
			for (const c of chords) {
				const args: string[] = [];
				for (const m of c.mods) args.push("-M", m === "super" ? "logo" : m);
				args.push("-k", c.key);
				for (const m of [...c.mods].reverse()) args.push("-m", m === "super" ? "logo" : m);
				await run("wtype", args, { timeout: 2000 });
			}
			return;
		}
		if (await can("xdotool")) { await run("xdotool", ["key", "--clearmodifiers", ...chords.map((c) => [...c.mods, c.key].join("+"))], { timeout: 3000 }); return; }
		if (await can("ydotool")) throw new Error("ydotool needs raw key codes; install wtype (wlroots) or xdotool");
		throw new Error("Install xdotool (X11) or wtype (Wayland) to send keys");
	};
	const getClipboard = async () => (wayland && (await can("wl-paste"))) ? run("wl-paste", ["--no-newline"]) : run("xclip", ["-selection", "clipboard", "-o"]);
	const setClipboard = async (text: string) => void (await ((wayland && (await can("wl-copy"))) ? run("wl-copy", [], { input: text }) : run("xclip", ["-selection", "clipboard"], { input: text })));

	return {
		id: "linux",
		name: "Linux",
		caps: { menus: false, browserTab: false, windowText: false, scripts: ["sh"], volume: true },
		browsers: ["google-chrome", "chromium", "chromium-browser", "brave-browser", "firefox", "firefox-esr", "microsoft-edge", "vivaldi-stable", "opera", "zen", "librewolf"],
		commandAllowlist: { "/usr/bin/upower": ["-i", "-e"], "/usr/bin/acpi": "any", "/usr/bin/df": "any", "/usr/bin/uptime": "any", gh: ["api", "pr", "issue", "run", "status"], git: ["status", "log", "rev-parse", "branch", "-C"] },
		frontmost,
		browserTab: async () => ({ url: "", title: stripBrowserSuffix(lastTitle) }),
		windowTitle: async () => lastTitle,
		readWindowText: async () => { throw new Unsupported("Reading on-screen text", "Linux"); },
		sendKeys,
		typeText: async (text) => {
			if (wayland && (await can("wtype"))) return void (await run("wtype", [text], { timeout: 15_000 }));
			await run("xdotool", ["type", "--delay", "8", text], { timeout: 15_000 });
		},
		shell: async (cmd) => { const p = spawn("/bin/sh", ["-lc", cmd], { detached: true, stdio: "ignore" }); p.unref(); },
		open: async (target) => {
			const isPath = /^[a-z][\w+.-]*:/i.test(target) || target.startsWith("/") || target.startsWith("~");
			const p = isPath
				? spawn("xdg-open", [target.replace(/^~/, process.env.HOME ?? "~")], { detached: true, stdio: "ignore" })
				: spawn("/bin/sh", ["-lc", `gtk-launch ${JSON.stringify(target)} 2>/dev/null || ${JSON.stringify(target.toLowerCase())}`], { detached: true, stdio: "ignore" });
			p.unref();
		},
		runScript: async (script, lang = "sh", timeoutMs = 30_000) => {
			if (lang !== "sh") throw new Error(`${lang} scripts aren't available on Linux (use sh)`);
			return (await run("/bin/sh", ["-c", script], { timeout: timeoutMs })).trim();
		},
		getClipboard,
		setClipboard,
		copySelection: () => copyViaClipboard(getClipboard, setClipboard, () => sendKeys("ctrl+c")),
		notify: async (text, title = "ContextDeck") => void (await run("notify-send", [title, text.slice(0, 240)]).catch(() => "")),
		prompt: async (title, message) => {
			try {
				if (await can("zenity")) return (await run("zenity", ["--password", "--title", title, "--text", message], { timeout: 300_000 })).trim() || undefined;
				if (await can("kdialog")) return (await run("kdialog", ["--title", title, "--password", message], { timeout: 300_000 })).trim() || undefined;
			} catch { return undefined; }
			throw new Error("Install zenity or kdialog for the secret prompt, or use: ~/.contextdeck/deck secret set NAME");
		},
		getVolume: async () => {
			if (await can("wpctl")) { const m = /Volume:\s*([\d.]+)/.exec(await run("wpctl", ["get-volume", "@DEFAULT_AUDIO_SINK@"])); return Math.round(Number(m?.[1] ?? 0) * 100); }
			const m = /(\d+)%/.exec(await run("pactl", ["get-sink-volume", "@DEFAULT_SINK@"]));
			return Number(m?.[1] ?? 0);
		},
		setVolume: async (v) => {
			const pct = Math.round(Math.max(0, Math.min(100, v)));
			if (await can("wpctl")) return void (await run("wpctl", ["set-volume", "@DEFAULT_AUDIO_SINK@", `${pct}%`]));
			await run("pactl", ["set-sink-volume", "@DEFAULT_SINK@", `${pct}%`]);
		},
		toggleMute: async () => {
			if (await can("wpctl")) return void (await run("wpctl", ["set-mute", "@DEFAULT_AUDIO_SINK@", "toggle"]));
			await run("pactl", ["set-sink-mute", "@DEFAULT_SINK@", "toggle"]);
		},
		secretGet: async (account) => { try { return (await run("secret-tool", ["lookup", "service", "contextdeck", "account", account])).trim() || undefined; } catch { return undefined; } },
		secretSet: async (account, value) => void (await run("secret-tool", ["store", "--label", `ContextDeck ${account}`, "service", "contextdeck", "account", account], { input: value, timeout: 8000 })),
		secretDelete: async (account) => void (await run("secret-tool", ["clear", "service", "contextdeck", "account", account]).catch(() => "")),
		scanMenus: async () => { throw new Unsupported("Reading app menus", "Linux"); },
		clickMenu: async () => { throw new Unsupported("Clicking app menus", "Linux"); },
		appVersion: async () => "",
		facts: async (): Promise<PlatformFacts> => {
			let os = "Linux";
			try { os = /PRETTY_NAME="?([^"\n]+)"?/.exec(readFileSync("/etc/os-release", "utf8"))?.[1] ?? os; } catch { /* keep */ }
			let keyboard = "us";
			try { keyboard = /layout:\s*(\S+)/.exec(await run("setxkbmap", ["-query"]))?.[1] ?? keyboard; } catch { /* keep */ }
			return { os, arch: process.arch, keyboard, locale: Intl.DateTimeFormat().resolvedOptions().locale, session: wayland ? "wayland" : "x11" };
		},
	};
}

interface SwayNode { focused?: boolean; nodes?: SwayNode[]; floating_nodes?: SwayNode[]; app_id?: string; name?: string; pid?: number; window_properties?: { class?: string } }
function findFocused(node: SwayNode): SwayNode | undefined {
	if (node.focused) return node;
	for (const n of [...(node.nodes ?? []), ...(node.floating_nodes ?? [])]) { const f = findFocused(n); if (f) return f; }
	return undefined;
}

/** "google-chrome" → "Google Chrome", "org.gnome.Nautilus" → "Nautilus". */
export const prettyName = (appId: string) => {
	const last = appId.split(".").pop() ?? appId;
	return last.split(/[-_]/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
};
