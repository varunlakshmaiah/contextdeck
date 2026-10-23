/**
 * Everything ContextDeck needs from the operating system. One adapter per OS (mac.ts, win.ts, linux.ts);
 * the core (engine, setup, info, secrets, research, llm) only talks to this interface.
 *
 * App identity ("appId", stored in ctx.bundleId for compatibility):
 *   macOS   bundle id            com.google.Chrome
 *   Windows executable name      chrome.exe
 *   Linux   WM_CLASS / app id    google-chrome
 */
import type { MenuEntry } from "../menus";

export type OsId = "mac" | "win" | "linux";

export interface Front { bundleId: string; app: string; via: string; errors: string[]; pid?: number }

export interface PlatformFacts {
	os: string;            // "macOS 26.1", "Windows 11 (26100)", "Ubuntu 24.04"
	arch: string;          // arm64 | x64
	keyboard: string;      // "U.S.", "en-US", "us"
	locale: string;
	appVersion?: string;
	browser?: string;
	session?: string;      // linux: x11 | wayland
}

export interface Capabilities {
	menus: boolean;        // can read & click an app's menu bar (✨ Set up ground truth)
	browserTab: boolean;   // can read the active tab without the extension
	windowText: boolean;   // uiText info sources
	scripts: string[];     // script languages for the "script"/"applescript" action: ["applescript","jxa"] | ["powershell"] | ["sh"]
	volume: boolean;
}

export interface Platform {
	id: OsId;
	name: string;
	caps: Capabilities;
	/** App ids that are web browsers (their tab = the sub-context). */
	browsers: string[];
	/** Read-only binaries allowed for "command" info sources on this OS. */
	commandAllowlist: Record<string, string[] | "any">;

	frontmost(): Promise<Front>;
	browserTab(appId: string): Promise<{ url: string; title: string }>;
	windowTitle(): Promise<string>;
	readWindowText(appId?: string): Promise<string>;

	sendKeys(spec: string, opts?: { cmdKey?: "ctrl" | "win" }): Promise<void>;
	typeText(text: string): Promise<void>;
	shell(cmd: string): Promise<void>;
	open(target: string): Promise<void>;
	runScript(script: string, lang?: string, timeoutMs?: number): Promise<string>;

	getClipboard(): Promise<string>;
	setClipboard(text: string): Promise<void>;
	copySelection(): Promise<string>;
	notify(text: string, title?: string): Promise<void>;
	prompt(title: string, message: string): Promise<string | undefined>;

	getVolume(): Promise<number>;
	setVolume(v: number): Promise<void>;
	toggleMute(): Promise<void>;

	secretGet(account: string): Promise<string | undefined>;
	secretSet(account: string, value: string): Promise<void>;
	secretDelete(account: string): Promise<void>;

	scanMenus(appId: string): Promise<MenuEntry[]>;
	clickMenu(appId: string, path: string[]): Promise<void>;

	appVersion(appId: string): Promise<string>;
	facts(appId?: string): Promise<PlatformFacts>;
}

export class Unsupported extends Error {
	constructor(what: string, os: string) { super(`${what} isn't available on ${os}`); }
}
