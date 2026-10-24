/**
 * Windows adapter. One long-lived PowerShell helper (platform/win-host.ps1) does the Win32 / UI Automation /
 * Credential Manager / Core Audio work; we talk to it with one JSON line per request.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseAcceleratorDump, type MenuEntry } from "../menus";
import { parseSequence, resolveMods, type Chord } from "./chords";
import { copyViaClipboard, normalizeUrl, stripBrowserSuffix } from "./common";
import type { Front, Platform, PlatformFacts } from "./types";

// ---------- virtual keys ----------
const VK: Record<string, number> = {
	return: 0x0d, enter: 0x0d, tab: 0x09, space: 0x20, delete: 0x08, backspace: 0x08, fwddelete: 0x2e, esc: 0x1b, escape: 0x1b,
	left: 0x25, up: 0x26, right: 0x27, down: 0x28, home: 0x24, end: 0x23, pageup: 0x21, pagedown: 0x22,
	"=": 0xbb, "-": 0xbd, ",": 0xbc, ".": 0xbe, "/": 0xbf, ";": 0xba, "'": 0xde, "[": 0xdb, "]": 0xdd, "\\": 0xdc, "`": 0xc0,
	print: 0x2c, insert: 0x2d, volumeup: 0xaf, volumedown: 0xae, mute: 0xad, playpause: 0xb3, nexttrack: 0xb0, prevtrack: 0xb1,
};
for (let i = 0; i < 26; i++) VK[String.fromCharCode(97 + i)] = 0x41 + i;
for (let i = 0; i < 10; i++) VK[String(i)] = 0x30 + i;
for (let i = 1; i <= 19; i++) VK[`f${i}`] = 0x6f + i;
const EXTENDED = new Set([0x2c, 0x2d, 0x25, 0x26, 0x27, 0x28, 0x24, 0x23, 0x21, 0x22, 0x2e, 0xaf, 0xae, 0xad, 0xb3, 0xb0, 0xb1]);
const MOD_VK: Record<string, number> = { ctrl: 0x11, shift: 0x10, alt: 0x12, win: 0x5b };

/** Chord → { mods: VK[], key: VK, ext } for the helper. */
export function chordToVk(c: Chord, cmdKey: "ctrl" | "win" = "ctrl"): { mods: number[]; key: number; ext: boolean } {
	const mods = resolveMods(c.mods, "win", cmdKey).map((m) => {
		if (m === "fn") throw new Error("fn can't be sent on Windows");
		return MOD_VK[m];
	});
	const key = VK[c.key];
	if (key === undefined) throw new Error(`Key "${c.key}" can't be sent on Windows`);
	return { mods, key, ext: EXTENDED.has(key) };
}

// ---------- helper process ----------
const HOST_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "platform", "win-host.ps1");

export class PsHost {
	private proc?: ChildProcessWithoutNullStreams;
	private seq = 0;
	private buf = "";
	private waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
	constructor(private script = HOST_SCRIPT, private exe = "powershell.exe") {}

	private start() {
		if (this.proc && !this.proc.killed && this.proc.exitCode === null) return this.proc;
		if (!existsSync(this.script)) throw new Error(`Windows helper missing: ${this.script}`);
		const p = spawn(this.exe, ["-NoLogo", "-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-File", this.script], { windowsHide: true });
		p.stdout.setEncoding("utf8");
		p.stdout.on("data", (d: string) => this.onData(d));
		p.on("exit", () => {
			for (const w of this.waiting.values()) { clearTimeout(w.timer); w.reject(new Error("Windows helper exited")); }
			this.waiting.clear();
			this.proc = undefined;
		});
		this.proc = p;
		return p;
	}

	private onData(d: string) {
		this.buf += d;
		let i: number;
		while ((i = this.buf.indexOf("\n")) >= 0) {
			const line = this.buf.slice(0, i).trim();
			this.buf = this.buf.slice(i + 1);
			if (!line.startsWith("{")) continue;
			try {
				const msg = JSON.parse(line) as { id: number; ok: boolean; out?: unknown; error?: string };
				const w = this.waiting.get(msg.id);
				if (!w) continue;
				clearTimeout(w.timer);
				this.waiting.delete(msg.id);
				if (msg.ok) w.resolve(msg.out); else w.reject(new Error(msg.error ?? "Windows helper error"));
			} catch { /* ignore partial/garbage */ }
		}
	}

	call<T = unknown>(op: string, args: Record<string, unknown> = {}, timeoutMs = 5000): Promise<T> {
		const p = this.start();
		const id = ++this.seq;
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => { this.waiting.delete(id); reject(new Error(`Windows helper timed out (${op})`)); }, timeoutMs);
			this.waiting.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
			p.stdin.write(`${JSON.stringify({ id, op, args })}\n`);
		});
	}

	stop() { this.proc?.kill(); }
}

// ---------- the adapter ----------
export function makeWinPlatform(host = new PsHost(), cmdKey: () => "ctrl" | "win" = () => "ctrl"): Platform {
	const browsers = ["chrome.exe", "msedge.exe", "brave.exe", "firefox.exe", "arc.exe", "vivaldi.exe", "opera.exe", "chromium.exe"];
	const s = (v: unknown) => (v === null || v === undefined ? "" : String(v));
	const sendKeys = async (spec: string, opts?: { cmdKey?: "ctrl" | "win" }) => {
		const chords = parseSequence(spec).map((c) => chordToVk(c, opts?.cmdKey ?? cmdKey()));
		await host.call("chords", { chords }, 4000 + chords.length * 100);
	};
	const getClipboard = async () => s(await host.call("clipget"));
	const setClipboard = async (text: string) => void (await host.call("clipset", { text }));
	return {
		id: "win",
		name: "Windows",
		caps: { menus: true, browserTab: true, windowText: true, scripts: ["powershell"], volume: true },
		browsers,
		commandAllowlist: {
			"C:\\Windows\\System32\\systeminfo.exe": "any", "C:\\Windows\\System32\\ipconfig.exe": "any", "C:\\Windows\\System32\\tasklist.exe": "any",
			gh: ["api", "pr", "issue", "run", "status"], git: ["status", "log", "rev-parse", "branch", "-C"],
		},
		frontmost: async (): Promise<Front> => {
			try {
				const f = await host.call<{ appId: string; app: string; pid: number }>("front", {}, 2500);
				return { bundleId: f.appId, app: f.app, pid: f.pid, via: "win32", errors: [] };
			} catch (e) {
				return { bundleId: "", app: "", via: "none", errors: [`win32: ${(e as Error).message}`] };
			}
		},
		browserTab: async () => {
			const t = await host.call<{ url: string; title: string }>("tab", {}, 2500);
			return { url: normalizeUrl(s(t.url)), title: stripBrowserSuffix(s(t.title)) };
		},
		windowTitle: async () => s(await host.call("title", {}, 1500)),
		readWindowText: async () => s(await host.call("wintext", {}, 15_000)),
		sendKeys,
		typeText: async (text) => void (await host.call("type", { text }, 15_000)),
		shell: async (cmd) => { const p = spawn("cmd.exe", ["/d", "/s", "/c", cmd], { detached: true, stdio: "ignore", windowsHide: true }); p.unref(); },
		open: async (target) => { const p = spawn("cmd.exe", ["/d", "/c", "start", "", target], { detached: true, stdio: "ignore", windowsHide: true }); p.unref(); },
		runScript: async (script, lang = "powershell", timeoutMs = 30_000) => {
			if (lang !== "powershell") throw new Error(`${lang} scripts aren't available on Windows (use powershell)`);
			return s(await host.call("script", { script }, timeoutMs));
		},
		getClipboard,
		setClipboard,
		copySelection: () => copyViaClipboard(getClipboard, setClipboard, () => sendKeys("ctrl+c")),
		notify: async (text, title = "ContextDeck") => void (await host.call("notify", { title, text: text.slice(0, 240) }).catch(() => undefined)),
		prompt: async (title, message) => { const v = await host.call("prompt", { title, message }, 300_000).catch(() => null); return v ? String(v) : undefined; },
		getVolume: async () => Number(await host.call("volget")) || 0,
		setVolume: async (v) => void (await host.call("volset", { value: Math.max(0, Math.min(100, v)) })),
		toggleMute: async () => void (await host.call("mute")),
		secretGet: async (account) => { const v = await host.call("secretget", { account }).catch(() => null); return v ? String(v) : undefined; },
		secretSet: async (account, value) => void (await host.call("secretset", { account, value })),
		secretDelete: async (account) => void (await host.call("secretdel", { account })),
		scanMenus: async (): Promise<MenuEntry[]> => parseAcceleratorDump(s(await host.call("menus", {}, 60_000))),
		clickMenu: async (_appId, path) => void (await host.call("click", { path }, 8000)),
		appVersion: async (appId) => s(await host.call("version", { appId }).catch(() => "")),
		facts: async (appId): Promise<PlatformFacts> => {
			const f = await host.call<{ os: string; arch: string; keyboard: string; locale: string }>("facts", {}, 8000);
			const appVersion = appId ? s(await host.call("version", { appId }).catch(() => "")) || undefined : undefined;
			return { os: f.os, arch: f.arch?.toLowerCase() === "amd64" ? "x64" : f.arch?.toLowerCase(), keyboard: f.keyboard, locale: f.locale, appVersion };
		},
	};
}
