import type { LlmSettings } from "./llm";

/**
 * ContextDeck schema.
 *
 * NAMING CONVENTION (see README → "Naming"):
 *   Layout ids    system | system.<variant>          → layouts/system/
 *                 app.<bundleId> | app.<group-slug>  → layouts/apps/     (app.com.figma.Desktop, app.browsers)
 *                 site.<host>                        → layouts/sites/    (site.studio.youtube.com)
 *                 sub.<bundleId>.<name>              → layouts/subs/     (window-title / probe sub-contexts)
 *                 takeover.<name>                    → layouts/takeovers/ (flag-driven, replaces everything)
 *   Secrets       UPPER_SNAKE  <SERVICE>_<KIND>, KIND ∈ API_KEY | TOKEN | URL | SECRET   (GITHUB_TOKEN, HOME_ASSISTANT_URL)
 *                 used as {{secret.NAME}}; stored in Keychain (service "contextdeck", account NAME)
 *   State keys    lowercase dotted <namespace>.<name>  (agent.status, render.progress)
 *   Flags         lowercase kebab (recording, meeting)
 *   Pages         smart | sub | app | system | <layoutId>:<pageName>
 */

export type Level = "system" | "app" | "sub" | "takeover";

export type Action =
	| { type: "keys"; keys: string }                       // "cmd+shift+4", or a sequence separated by spaces: "cmd+c cmd+v"
	| { type: "type"; text: string }                       // type literal text
	| { type: "shell"; cmd: string }                       // login shell (zsh on macOS, $SHELL on Linux, cmd.exe on Windows)
	| { type: "open"; target: string }                     // URL, file path, or app name
	| { type: "applescript"; script: string }               // macOS
	| { type: "script"; script: string; lang?: "applescript" | "jxa" | "powershell" | "sh" }  // any OS (lang defaults per OS)
	| { type: "http"; url: string; method?: string; headers?: Record<string, string>; body?: unknown }  // {{secret.X}} allowed (host-bound)
	| { type: "mode"; mode: string; layout?: string }      // switch sub-mode of the key's layout (or the named one)
	| { type: "layout"; id: string | null }                // pin a layout (null = back to automatic)
	| { type: "page"; page: "next" | "prev" | "smart" | "sub" | "app" | "system" | string }
	| { type: "flag"; flag: string; value?: boolean }      // toggle (or set) a context flag
	| { type: "state"; key: string; value: unknown }
	| { type: "overlay"; overlay: OverlaySpec }
	| { type: "closeOverlay" }
	| ({ type: "llm" | "claude" } & LlmAction)            // "claude" is kept as an alias of "llm"
	| { type: "llmSelect"; provider: string | null }       // switch the default LLM provider (null = back to settings.llm)
	| { type: "copy"; text: string }
	| { type: "sequence"; steps: Action[]; delayMs?: number }
	| { type: "menu"; path: string[] }                     // click a menu item of the front app, e.g. ["View","Zoom In"]
	| { type: "setup"; force?: boolean; update?: boolean } // auto-configure the app/site in front
	| { type: "deckMenu" }                                 // ContextDeck's own menu on the keys
	| { type: "secretSet"; name: string }                  // prompt for a secret and store it in the Keychain
	| { type: "reload" }
	| { type: "editLayout"; layout?: string };             // open a layout's file (default: the key's layout)

export interface LlmAction {
	prompt: string;
	input?: "selection" | "clipboard" | "none";
	output?: "clipboard" | "paste" | "notify" | "choices";
	system?: string;
	maxTokens?: number;
	provider?: string;       // provider id from settings.providers (default: settings.llm)
	model?: string;          // override the provider's default model
}

// ---------- info (read-only live data on keys and dials) ----------

export type InfoSource =
	| { type: "http"; url: string; method?: "GET"; headers?: Record<string, string> }   // JSON or text; {{secret.X}} allowed
	| { type: "file"; path: string }                                                    // text or JSON file (~ allowed)
	| { type: "state"; key: string }                                                    // value pushed via API / `deck state`
	| { type: "applescript"; script: string }                                           // read-only `get` scripts
	| { type: "script"; script: string; lang?: string }                                 // hand-written only (not auto-generated unless AppleScript)
	| { type: "command"; cmd: string[] }                                                // allowlisted read-only binaries
	| { type: "uiText"; app?: string; match: string };                                  // regex over the front window's visible text (Accessibility)

export interface InfoSpec {
	source: InfoSource;
	every?: number;                    // refresh interval, seconds (default 60, min 2)
	extract?: string;                  // "a.b[0].c" JSON path, or "/regex/flags" (group 1)
	format?: string;                   // template: "{{value}}%", "{{value|pct}}", "{{value|duration}}"
	progress?: { max?: number; path?: string };  // makes a 0..1 bar: value / max
	thresholds?: { above?: number; below?: number; equals?: string; color: string }[];
	onlyWhenFront?: boolean;           // poll only while this layout is visible (default true)
}

export interface Meta {
	confidence?: "verified" | "documented" | "knowledge";   // menu-verified, from docs, or model memory
	source?: string;                                       // URL or "menu"
}

export interface KeyDef {
	label?: string;          // supports {{state.x}} / {{ctx.app}} / {{info.value}} templates
	sub?: string;            // small second line
	icon?: string;           // lucide icon name, e.g. "scissors"
	glyph?: string;          // fallback big text glyph if no icon (e.g. "B")
	color?: string;          // accent color
	bg?: string;             // background color
	stateKey?: string;       // render as a status light from state[stateKey]
	stateColors?: Record<string, string>;
	action?: Action;         // on press
	release?: Action;        // on release
	hold?: Action;           // on long press (> holdMs)
	info?: InfoSpec;         // live read-only value shown on the key
	requires?: string[];     // secret names needed; the key shows "needs NAME" until they exist
	meta?: Meta;
}

export type DialDef = {
	label?: string;
	icon?: string;
	color?: string;
	press?: Action;
	touch?: Action;
	longTouch?: Action;
	info?: InfoSpec;
	requires?: string[];
	meta?: Meta;
} & (
	| { kind?: "actions"; cw?: Action; ccw?: Action; value?: string }
	| { kind: "volume"; step?: number }
	| { kind: "value"; key: string; min?: number; max?: number; step?: number; unit?: string; onChange?: Action; debounceMs?: number }
);

export interface Match {
	bundleId?: string | string[];   // glob, e.g. "com.microsoft.VSCode*"
	app?: string | string[];        // app name glob
	url?: string | string[];        // glob against active browser tab URL
	title?: string | string[];      // window / tab title glob
	sub?: string | string[];        // glob against the app's probe output (ctx.sub)
	time?: [string, string];        // ["06:00","11:00"], wraps past midnight
	days?: number[];                // 0=Sun..6=Sat
	flags?: string | string[];      // all listed flags must be true
	notFlags?: string | string[];
}

export interface ModeDef {
	keys?: (KeyDef | null)[];
	dials?: (DialDef | null)[];
}

export interface PageDef extends ModeDef {
	name: string;
}

/** How a sub-context is read for a native app (feeds ctx.sub, matched by match.sub). */
export type Probe =
	| { type: "windowTitle"; every?: number }
	| { type: "applescript"; script: string; every?: number }
	| { type: "script"; script: string; lang?: string; every?: number };

export interface SecretDecl {
	description?: string;
	url?: string;                   // where to get it
	hosts?: string[];               // the only hosts this secret may be sent to (required for http use)
	optional?: boolean;
}

export interface LayoutDef extends ModeDef {
	id: string;
	name?: string;
	level?: Level;                  // inferred when omitted (see levels.ts)
	color?: string;
	priority?: number;
	match?: Match;
	modes?: Record<string, ModeDef>;
	defaultMode?: string;
	pages?: PageDef[];              // extra pages after this layout's full page
	probe?: Probe;                  // app layouts: how to read the sub-context
	secrets?: Record<string, SecretDecl>;
	pinned?: boolean;               // legacy: false = no system zone (now: level "takeover")
	generic?: boolean;              // a catch-all (e.g. Browser): apps/sites under it can still be auto-configured
	generated?: {
		at: string; model: string; source: "menus" | "knowledge" | "research";
		app?: string; bundleId?: string; host?: string; appVersion?: string; platform?: string; sources?: string[];
	};
}

export interface OverlaySpec {
	id?: string;
	title?: string;
	items?: { label: string; value?: string; icon?: string; sub?: string; color?: string }[];
	keys?: (KeyDef | null)[];       // raw keys instead of items
	onPick?: "copy" | "paste" | "return";
	timeoutMs?: number;
}

export interface Zone { keys: number[]; dials: number[] }

export interface ResearchSettings {
	provider?: "none" | "brave" | "tavily" | "exa" | "searxng" | "openrouter-online";
	baseUrl?: string;               // searxng
	maxResults?: number;            // search results to consider (default 6)
	fetchPages?: number;            // pages to read in full (default 3)
	allowKnowledge?: boolean;       // keep shortcuts only the model "knows" (default true when research is off)
}

export interface Settings extends LlmSettings {
	pollMs?: number;
	model?: string;
	accent?: string;
	background?: string;
	holdMs?: number;
	apiPort?: number;
	browsers?: string[];                  // extra app ids to treat as browsers
	cmdKey?: "ctrl" | "win";              // Windows/Linux: what "cmd" in layouts means (default ctrl; "mod" is always cmd on macOS, ctrl elsewhere)
	autoSetup?: "key" | "auto" | "off";   // key = show a "Set up" key on unconfigured apps (default); auto = configure on first open
	setupSlot?: number;                   // which key shows "Set up" (default 6)
	setupIgnore?: string[];               // bundle IDs / hosts never offered setup
	setupDwellMs?: number;                // auto mode: how long an app must stay in front before configuring (default 4000)
	zones?: Partial<Record<"system" | "app" | "sub", Zone>>;
	research?: ResearchSettings;
	secrets?: Record<string, SecretDecl>;   // global secret declarations (layouts can declare their own)
}

export interface Config {
	settings?: Settings;
	pinned?: { keys?: Record<string, KeyDef>; dials?: Record<string, DialDef> };  // legacy; becomes the system layout
	layouts: LayoutDef[];
}

export interface Context {
	bundleId: string;
	app: string;
	url: string;
	title: string;
	sub: string;               // probe output for native apps
	flags: Record<string, boolean>;
	now: Date;
}

export interface PageInfo { id: string; name: string; level: Level | "smart" }

/** What the deck shows right now. keyOwners/dialOwners say which layout each slot came from. */
export interface Resolved {
	levels: Partial<Record<Level, LayoutDef>>;
	layout: LayoutDef;         // the most specific active layout (takeover ?? sub ?? app ?? system)
	mode: string | undefined;  // mode of `layout`
	modes: Record<string, string | undefined>;  // active mode per layout id
	pages: PageInfo[];
	page: number;
	keys: (KeyDef | null)[];   // 8
	dials: (DialDef | null)[]; // 4
	keyOwners: (LayoutDef | null)[];
	dialOwners: (LayoutDef | null)[];
}
