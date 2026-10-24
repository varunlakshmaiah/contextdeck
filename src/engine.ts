import { EventEmitter } from "node:events";
import { deleteLayout, LAYOUTS_DIR, writeLayout } from "./config";
import { evaluate, intervalMs, type InfoResult } from "./info";
import { askLLM, configuredProviders, parseChoices, providerName, type AskOptions } from "./llm";
import { ElgatoBridge } from "./elgato";
import { usefulEntries, type MenuEntry } from "./menus";
import { platform, setCmdKey, type Platform as OsPlatform } from "./platform";
import { loadIcons, renderDial, renderKey, toDataUrl } from "./render";
import { digestPrompt, fetchPage, queriesFor, rankHits, search, type Digest, type Platform, type SearchHit } from "./research";
import { KEY_COUNT, PLUS, isNative, levelOf, normalize, pick, resolve, template, type Geometry } from "./resolve";
import { keychainStore, MissingSecretError, withSecrets, type SecretStore } from "./secrets";
import { ICON_HINTS, buildPrompt, extractJson, planToLayout, targetForApp, targetForSite, type SetupTarget } from "./setup";
import type { Action, Config, Context, DialDef, InfoSpec, KeyDef, LayoutDef, LlmAction, OverlaySpec, Resolved, SecretDecl } from "./types";

/** Minimal surface of the SDK action objects the engine needs (keeps the engine testable without Stream Deck). */
export interface KeySurface { id: string; setImage(img?: string): Promise<void>; setTitle(t?: string): Promise<void>; showAlert(): Promise<void>; showOk(): Promise<void> }
export interface DialSurface { id: string; setFeedback(f: Record<string, unknown>): Promise<void>; setTriggerDescription(d: Record<string, string>): Promise<void>; showAlert(): Promise<void> }

/** A physical (or virtual) deck. Each one gets its own page, page memory and pressed/busy state. */
export interface BrowserReport { url: string; title: string; browser?: string; focused: boolean; incognito?: boolean; at: number }

export interface DeviceInfo extends Geometry { id: string; name?: string }

class View {
	resolved!: Resolved;
	page: number | string = 0;
	pageMemory = new Map<string, string>();
	contextKey = "";
	signature = "";
	pressed = new Set<number>();
	busy = new Map<number, string>();
	flashes = new Map<number, { color: string; text?: string }>();
	holdTimers = new Map<number, { timer: NodeJS.Timeout; held: boolean }>();
	constructor(public id: string, public geo: Geometry, public name = id) {}
}

interface Overlay extends OverlaySpec { id: string; keys: (KeyDef | null)[]; timer?: NodeJS.Timeout }

const DEFAULT_ACCENT = "#F97316";
const DEFAULT_BG = "#111113";
const SETUP_COLOR = "#A78BFA";
const NEEDS_KEY_COLOR = "#FBBF24";
/** Never offer setup for these (system UI, the deck itself, search engines). */
const SETUP_IGNORE = ["com.apple.finder", "com.apple.loginwindow", "com.apple.dock", "com.apple.systemuiserver", "com.apple.Spotlight", "com.apple.controlcenter", "com.apple.notificationcenterui", "com.elgato.StreamDeck", "com.apple.ScreenSaver.Engine", "com.apple.SecurityAgent", "com.apple.UserNotificationCenter",
	"explorer.exe", "searchhost.exe", "searchapp.exe", "shellexperiencehost.exe", "startmenuexperiencehost.exe", "lockapp.exe", "streamdeck.exe", "applicationframehost.exe", "gnome-shell", "plasmashell", "opendeck", "xfdesktop", "nautilus-desktop",
	"google.com", "search.brave.com", "bing.com", "duckduckgo.com", "perplexity.ai", "localhost"];
const NON_WEB = /^(newtab|about|chrome|edge|brave|arc|file|data|blob|devtools|chrome-extension)/i;

export interface SetupRecord { at: string; ok: boolean; error?: string; layout?: string }
export interface SetupResult { ok: boolean; layout?: string; name?: string; keys?: number; dials?: number; info?: number; source?: string; secrets?: string[]; dropped?: string[]; error?: string }

/** Side-effecting dependencies, swappable in tests. */
export interface EngineDeps {
	scanMenus: (bundleId: string) => Promise<MenuEntry[]>;
	ask: (o: AskOptions) => Promise<string>;
	writeLayout: (l: LayoutDef) => string;
	removeLayout: (id: string) => void;
	saveSetupState: (s: Record<string, SetupRecord>) => void;
	savePrefs: (p: { llm?: string | null }) => void;
	openFile: (path: string) => Promise<void>;
	icons: () => Record<string, string>;
	secrets: SecretStore;
	prompt: (title: string, message: string) => Promise<string | undefined>;
	platform: (bundleId?: string) => Promise<Platform>;
	appVersion: (bundleId: string) => Promise<string>;
	search: (q: string) => Promise<SearchHit[]>;
	fetchPage: (url: string) => Promise<string>;
	loadResearch: (key: string) => Digest | undefined;
	saveResearch: (key: string, d: Digest) => void;
	evaluateInfo: (spec: InfoSpec, decls: Record<string, SecretDecl>) => Promise<InfoResult>;
	fetch: typeof fetch;
}

type Slot = { def: KeyDef | null; owner: LayoutDef | null };
type Target = SetupTarget & { update?: boolean };

export class Engine extends EventEmitter {
	config: Config = { layouts: [] };
	configErrors: string[] = [];
	ctx: Context = { bundleId: "", app: "", url: "", title: "", sub: "", flags: {}, now: new Date() };
	state: Record<string, unknown> = {};
	forcedLayout: string | null = null;
	modes: Record<string, string> = {};
	overlay: Overlay | null = null;
	sources: Record<string, string> = {};           // layout id -> file
	setupState: Record<string, SetupRecord> = {};
	setupRunning: string | null = null;
	llmOverride: string | null = null;
	reloadConfig: () => void = () => undefined;
	/** Last 200 log lines (for the app's Logs view). */
	logs: { at: string; msg: string }[] = [];
	private logSink: (msg: string) => void = () => undefined;
	get log(): (msg: string) => void {
		return (msg) => { this.logs.push({ at: new Date().toISOString(), msg }); if (this.logs.length > 200) this.logs.shift(); this.logSink(msg); };
	}
	set log(fn: (msg: string) => void) { this.logSink = fn; }
	/** The ContextDeck app (local web UI), set by the API. */
	uiUrl = "";
	openUi() { if (!this.uiUrl) throw new Error("The app isn't available (API not started)"); return this.os.open(this.uiUrl); }

	/** What a deck shows right now, as SVG (for the app's live preview). */
	preview(deviceId?: string) {
		const v = (deviceId && this.views.get(deviceId)) || this.active;
		return this.inView(v, () => ({
			device: { id: v.id, name: v.name, ...v.geo },
			page: { index: this.resolved.page, of: this.resolved.pages.length, name: this.resolved.pages[this.resolved.page]?.name },
			keys: Array.from({ length: v.geo.keys }, (_, i) => this.keyImage(i)),
			dials: Array.from({ length: v.geo.dials }, (_, i) => this.dialVisual(i).svg),
		}));
	}
	onDiag: () => void = () => undefined;
	diag: { detector: string; detectErrors: string[]; urlError: string; lastDetect: string; tab?: string } = { detector: "", detectErrors: [], urlError: "", lastDetect: "" };

	private keys = new Map<string, { surface: KeySurface; index: number; device: string }>();
	private dials = new Map<string, { surface: DialSurface; index: number; device: string }>();
	private views = new Map<string, View>([["default", new View("default", PLUS, "Stream Deck +")]]);
	/** The view being computed/drawn; between events it's the deck you touched last. */
	private cur: View = this.views.get("default")!;
	private active: View = this.cur;

	get resolved(): Resolved { return this.cur.resolved; }
	set resolved(r: Resolved) { this.cur.resolved = r; }
	get geo(): Geometry { return this.cur.geo; }
	private get page() { return this.cur.page; }
	private set page(p: number | string) { this.cur.page = p; }
	private get pageMemory() { return this.cur.pageMemory; }
	private get contextKey() { return this.cur.contextKey; }
	private set contextKey(k: string) { this.cur.contextKey = k; }
	private get signature() { return this.cur.signature; }
	private set signature(k: string) { this.cur.signature = k; }
	private get pressed() { return this.cur.pressed; }
	private get busy() { return this.cur.busy; }
	private get flashes() { return this.cur.flashes; }
	private get holdTimers() { return this.cur.holdTimers; }

	/** Run fn with `v` as the current view (sync part only), then return to the active deck. */
	private inView<T>(v: View, fn: () => T): T {
		const prev = this.cur;
		this.cur = v;
		try { return fn(); } finally { this.cur = prev === v ? this.active : prev; }
	}
	/** An input arrived from this deck: it becomes the active one. */
	private touch(device?: string): View {
		const v = (device && this.views.get(device)) || this.active;
		this.active = this.cur = v;
		return v;
	}
	/** Views that have something registered (or the default one, for the API/tests). */
	private liveViews(): View[] {
		const used = new Set([...this.keys.values(), ...this.dials.values()].map((x) => x.device));
		const vs = [...this.views.values()].filter((v) => used.has(v.id));
		return vs.length ? vs : [this.views.get("default")!];
	}
	devices() { return [...this.views.values()].filter((v) => v.id !== "default" || this.liveViews()[0] === v).map((v) => ({ id: v.id, name: v.name, ...v.geo, active: v === this.active })); }
	private viewFor(d?: DeviceInfo): View {
		if (!d) return this.views.get("default")!;
		let v = this.views.get(d.id);
		if (!v) {
			v = new View(d.id, { keys: d.keys, dials: d.dials, cols: d.cols, rows: d.rows, kind: d.kind }, d.name ?? d.kind ?? d.id);
			this.views.set(d.id, v);
			if (this.active.id === "default") this.active = this.cur = v;
			this.inView(v, () => this.recomputeView(true));
		}
		return v;
	}
	private lastImage = new Map<string, string>();
	private valueTimers = new Map<string, NodeJS.Timeout>();
	private volume = 0;
	private pollTimer?: NodeJS.Timeout;
	private infoTimer?: NodeJS.Timeout;
	private needsTitle = false;
	private pickWaiters = new Map<string, (v: { picked: string | null; index: number | null }) => void>();
	private dwellTimer?: NodeJS.Timeout;
	private dwellTarget = "";
	private probeAt = new Map<string, number>();
	private infos = new Map<string, InfoResult>();
	private infoInflight = new Set<string>();
	private missing = new Map<string, boolean>();    // secret name -> missing?
	versions = new Map<string, string>();            // bundle id -> installed app version

	deps: EngineDeps = {
		scanMenus: (b) => this.os.scanMenus(b),
		ask: async (o) => (await askLLM(this.settings, { ...o, provider: o.provider ?? this.llm })).text,
		writeLayout: (l) => writeLayout(l),
		removeLayout: (id) => void deleteLayout(id),
		saveSetupState: () => undefined,
		savePrefs: () => undefined,
		openFile: (p) => this.os.open(p),
		icons: () => loadIcons(),
		secrets: keychainStore(),
		prompt: (t, m) => this.os.prompt(t, m),
		platform: (b) => this.os.facts(b),
		appVersion: (b) => this.os.appVersion(b),
		search: (q) => search(q, this.settings.research ?? {}, this.deps.secrets),
		fetchPage: (u) => fetchPage(u),
		loadResearch: () => undefined,
		saveResearch: () => undefined,
		evaluateInfo: (spec, decls) => evaluate(spec, { state: this.state, secrets: this.deps.secrets, decls, fetchImpl: this.deps.fetch }),
		fetch: (...a) => fetch(...a),
	};

	constructor() {
		super();
		for (const v of this.views.values()) v.resolved = resolve(this.config, this.ctx, { geometry: v.geo });
	}

	/** Official plugins' actions, through Elgato's MCP server. */
	elgato = new ElgatoBridge(() => this.settings.elgato ?? {}, (m) => this.log(m));

	/** The OS adapter (swap with setPlatform() in tests). */
	get os(): OsPlatform { return platform(); }
	get browsers(): string[] { return [...this.os.browsers, ...(this.settings.browsers ?? [])]; }
	get settings() { return this.config.settings ?? {}; }
	get accent() { return this.settings.accent ?? DEFAULT_ACCENT; }
	get bg() { return this.settings.background ?? DEFAULT_BG; }
	get llm(): string { return this.llmOverride ?? this.settings.llm ?? "anthropic"; }
	get llmName(): string { return providerName(this.settings, this.llm); }

	setConfig(cfg: Config | undefined, errors: string[]) {
		this.configErrors = errors;
		if (cfg) {
			this.config = cfg;
			setCmdKey(cfg.settings?.cmdKey);
			this.needsTitle = cfg.layouts.some((l) => !!l.match?.title && !l.match?.url);
		}
		if (errors.length) this.log(`Config errors:\n${errors.join("\n")}`);
		this.recompute(true);
		void this.refreshMissingSecrets();
	}

	// ---------- registration ----------
	addKey(surface: KeySurface, index: number, device?: DeviceInfo) {
		const v = this.viewFor(device);
		this.keys.set(surface.id, { surface, index, device: v.id });
		this.lastImage.delete(surface.id);
		this.inView(v, () => this.drawKey(index));
	}
	removeKey(id: string) { this.keys.delete(id); this.lastImage.delete(id); }
	addDial(surface: DialSurface, index: number, device?: DeviceInfo) {
		const v = this.viewFor(device);
		this.dials.set(surface.id, { surface, index, device: v.id });
		// The host may not say how many dials a deck has; trust what actually appears.
		if (index >= v.geo.dials) { v.geo = { ...v.geo, dials: index + 1 }; v.contextKey = ""; this.inView(v, () => this.recomputeView(true)); }
		this.lastImage.delete(surface.id);
		this.inView(v, () => this.drawDial(index));
	}
	removeDial(id: string) { this.dials.delete(id); this.lastImage.delete(id); }

	// ---------- context loop ----------
	start() {
		const tick = async () => {
			try { await this.detect(); } catch (e) { this.log(`detect: ${(e as Error).message}`); }
			this.pollTimer = setTimeout(tick, this.settings.pollMs ?? 700);
		};
		void tick();
		setInterval(() => void this.refreshVolume(), 2500);
		const infoTick = () => { void this.pollInfo(); this.infoTimer = setTimeout(infoTick, 1000); };
		infoTick();
	}
	stop() { clearTimeout(this.pollTimer); clearTimeout(this.infoTimer); }

	/** Latest report from the ContextDeck browser extension (exact URL + title, any OS). */
	browserReport?: BrowserReport;
	setBrowserReport(r: Omit<BrowserReport, "at">) {
		this.browserReport = { ...r, at: Date.now() };
		if (this.browsers.includes(this.ctx.bundleId) || r.focused) void this.detect().catch(() => undefined);
	}
	private freshReport(): BrowserReport | undefined {
		const r = this.browserReport;
		return r && r.focused && Date.now() - r.at < 30 * 60_000 ? r : undefined;
	}

	/** Pairing: a client (the browser extension) asks for the API token; you allow it on the deck. */
	async requestPair(client: string, timeoutMs = 60_000): Promise<boolean> {
		const id = this.showOverlay({
			title: `Pair ${client}?`,
			items: [
				{ label: "Allow", sub: client.slice(0, 14), icon: "check", color: "#22C55E", value: "allow" },
				{ label: "Deny", icon: "x", color: "#EF4444", value: "deny" },
			],
			onPick: "return",
			timeoutMs,
		});
		void this.os.notify(`${client} wants to connect. Press Allow on your Stream Deck.`, "ContextDeck");
		const r = await this.waitForPick(id, timeoutMs);
		return r.picked === "allow";
	}

	async detect() {
		const front = await this.os.frontmost();
		let url = "", title = "", urlError = "", sub = "", tabVia = "";
		if (this.browsers.includes(front.bundleId)) {
			const ext = this.freshReport();
			if (ext) { url = ext.incognito ? "" : ext.url; title = ext.title; tabVia = "extension"; }
			else {
				const tab = await this.os.browserTab(front.bundleId).catch((e) => {
					urlError = ((e as { stderr?: string }).stderr || (e as Error).message).trim().slice(0, 200);
					return { url: this.ctx.url, title: this.ctx.title };
				});
				url = tab.url; title = tab.title; tabVia = this.os.caps.browserTab ? "os" : "window title";
			}
		} else {
			// Native app: run its layout's probe (if any) to read the sub-context.
			const appLayout = pick(normalize(this.config).layouts, { ...this.ctx, bundleId: front.bundleId, app: front.app, url: "", title: "", sub: "" }, "app");
			const probe = appLayout?.probe;
			if (probe || this.needsTitle) {
				const due = front.bundleId !== this.ctx.bundleId || (this.probeAt.get(front.bundleId) ?? 0) + (probe?.every ?? 1.5) * 1000 <= Date.now();
				if (due) {
					this.probeAt.set(front.bundleId, Date.now());
					if (probe?.type === "applescript" || probe?.type === "script") sub = (await this.os.runScript(probe.script, probe.type === "script" ? probe.lang : "applescript", 2500).catch(() => "")).slice(0, 200);
					if (probe?.type === "windowTitle" || this.needsTitle) title = await this.os.windowTitle().catch(() => "");
					if (probe?.type === "windowTitle") sub = title;
				} else { sub = this.ctx.sub; title = this.ctx.title; }
			}
		}
		const changed = front.bundleId !== this.ctx.bundleId || url !== this.ctx.url || front.via !== this.diag.detector || urlError !== this.diag.urlError || sub !== this.ctx.sub;
		this.diag = { detector: front.via, detectErrors: front.errors, urlError, lastDetect: new Date().toISOString(), tab: tabVia };
		this.updateContext({ bundleId: front.bundleId, app: front.app, url, title, sub });
		if (changed) {
			this.drawKey(0);
			this.log(`detect[${front.via}] ${front.bundleId || "(none)"} ${url}${sub ? ` sub="${sub.slice(0, 40)}"` : ""}${front.errors.length ? `  errors: ${front.errors.join(" | ")}` : ""}${urlError ? `  url error: ${urlError}` : ""}`);
			this.onDiag();
			if (front.bundleId && !this.versions.has(front.bundleId)) {
				this.versions.set(front.bundleId, "");
				void this.deps.appVersion(front.bundleId).then((v) => { this.versions.set(front.bundleId, v); this.recompute(true); }).catch(() => undefined);
			}
		}
	}

	updateContext(patch: Partial<Context>) {
		this.ctx = { ...this.ctx, ...patch, os: this.os.id, now: new Date() };
		this.recompute();
	}

	setFlag(flag: string, value?: boolean) {
		this.ctx.flags = { ...this.ctx.flags, [flag]: value ?? !this.ctx.flags[flag] };
		this.recompute();
	}

	setState(key: string, value: unknown) {
		this.state[key] = value;
		for (const k of [...this.infos.keys()]) if (k.includes(`"type":"state","key":"${key}"`)) this.infos.delete(k);
		void this.pollInfo();
		this.redrawAll();
	}

	/** Switch the mode of a layout (default: the most specific active layout that has this mode). */
	setMode(mode: string, layoutId?: string) {
		const lv = this.resolved.levels;
		const target = layoutId ?? [lv.takeover, lv.sub, lv.app, lv.system].find((l) => l?.modes?.[mode])?.id ?? this.resolved.layout.id;
		this.modes[target] = mode;
		this.recompute(true);
	}

	forceLayout(id: string | null) {
		this.forcedLayout = id;
		this.recompute(true);
	}

	/** next | prev | smart | sub | app | system | <page id> | index */
	goPage(p: string | number) {
		const pages = this.resolved.pages;
		let idx = this.resolved.page;
		if (p === "next") idx = (idx + 1) % pages.length;
		else if (p === "prev") idx = (idx - 1 + pages.length) % pages.length;
		else if (typeof p === "number") idx = Math.max(0, Math.min(pages.length - 1, p));
		else idx = Math.max(0, pages.findIndex((x) => x.id === p || x.level === p));
		this.page = pages[idx]?.id ?? 0;
		this.pageMemory.set(this.contextKey, String(this.page));
		this.recompute(true);
	}

	recompute(force = false) {
		for (const v of this.liveViews()) this.inView(v, () => this.recomputeView(force, v === this.active || this.liveViews().length === 1));
	}

	private recomputeView(force = false, primary = true) {
		const geometry = this.geo;
		const base = resolve(this.config, this.ctx, { forcedId: this.forcedLayout, modes: this.modes, page: 0, geometry });
		const ck = [base.levels.takeover?.id, base.levels.app?.id, base.levels.sub?.id].join("|");
		if (ck !== this.contextKey) {
			this.contextKey = ck;
			this.page = this.pageMemory.get(ck) ?? 0;
		}
		const r = this.page === 0 ? base : resolve(this.config, this.ctx, { forcedId: this.forcedLayout, modes: this.modes, page: this.page, geometry });
		const target = this.setupTargetFor(r);
		if (target && r.page === 0) {
			const slot = isNative(geometry) ? Math.min(KEY_COUNT - 1, Math.max(0, this.settings.setupSlot ?? 6)) : normalize(this.config, geometry).zones.app.keys.filter((i) => i < geometry.keys).at(-1) ?? 0;
			const rec = this.setupState[target.id];
			r.keys = [...r.keys];
			r.keyOwners = [...r.keyOwners];
			r.keys[slot] = {
				label: rec?.ok === false ? "Retry setup" : target.update ? "Update" : "Set up",
				sub: target.update ? `to v${this.versions.get(this.ctx.bundleId)}` : target.name.length > 14 ? `${target.name.slice(0, 13)}…` : target.name,
				icon: target.update ? "refresh-cw" : "wand-sparkles", color: SETUP_COLOR, action: { type: "setup", update: target.update },
			};
			r.keyOwners[slot] = null;
			if (!target.update) this.maybeAutoSetup(target);
		}
		// Decks without dials: the last key pages (tap = next, hold = previous).
		if (geometry.dials === 0 && r.pages.length > 1 && geometry.keys >= 6) {
			const at = geometry.keys - 1;
			r.keys = [...r.keys];
			r.keyOwners = [...r.keyOwners];
			r.keys[at] = { label: r.pages[r.page].name.slice(0, 14), sub: `page ${r.page + 1}/${r.pages.length}`, icon: "chevrons-right", color: "#71717A", action: { type: "page", page: "next" }, hold: { type: "page", page: "prev" } };
			r.keyOwners[at] = null;
		}
		const sig = `${ck}|${JSON.stringify(r.modes)}|${r.page}/${r.pages.length}|${this.ctx.now.getHours()}|${target?.id ?? ""}|${this.setupRunning ?? ""}`;
		const layoutChanged = primary && r.layout.id !== this.resolved?.layout.id;
		this.resolved = r;
		if (layoutChanged) {
			this.emit("context", this.snapshot());
			this.log(`→ ${[r.levels.takeover?.id, r.levels.app?.id, r.levels.sub?.id].filter(Boolean).join(" + ") || "(none)"}  (${this.ctx.app} ${this.ctx.url})`);
		}
		if (force || sig !== this.signature) {
			this.signature = sig;
			this.redrawAll();
			void this.refreshMissingSecrets();
		}
	}

	snapshot() {
		const r = this.resolved;
		return {
			layout: r.layout.id,
			layoutName: r.layout.name ?? r.layout.id,
			levels: Object.fromEntries(Object.entries(r.levels).map(([k, v]) => [k, v?.id ?? null])),
			mode: r.mode ?? null,
			modes: Object.keys(r.layout.modes ?? {}),
			page: { index: r.page, id: r.pages[r.page]?.id, name: r.pages[r.page]?.name, of: r.pages.length, pages: r.pages.map((p) => p.id) },
			forcedLayout: this.forcedLayout,
			context: { app: this.ctx.app, bundleId: this.ctx.bundleId, url: this.ctx.url, title: this.ctx.title, sub: this.ctx.sub, flags: this.ctx.flags, appVersion: this.versions.get(this.ctx.bundleId) || null },
			state: this.state,
			overlay: this.overlay ? { id: this.overlay.id, title: this.overlay.title } : null,
			keys: this.currentSlots().map((s) => (s.def ? this.label(s.def) : null)),
			dials: r.dials.map((d) => d?.label ?? null),
			device: { id: this.cur.id, name: this.cur.name, ...this.geo },
			devices: this.devices(),
			configErrors: this.configErrors,
			diagnostics: this.diag,
			setup: { target: this.setupTargetFor(r)?.id ?? null, running: this.setupRunning, mode: this.settings.autoSetup ?? "key" },
			layoutFile: this.sources[r.layout.id] ?? null,
			missingSecrets: [...this.missing.entries()].filter(([, m]) => m).map(([n]) => n),
			llm: { provider: this.llm, name: this.llmName, setup: this.settings.setupLlm ?? this.llm, fallback: this.settings.fallbackLlm ?? null, available: configuredProviders(this.settings) },
		};
	}

	// ---------- drawing ----------
	private scope(info?: InfoResult) {
		return { state: this.state, ctx: this.ctx, mode: this.resolved.mode ?? "", layout: this.resolved.layout.name ?? this.resolved.layout.id, llm: this.llmName, info: info ? { value: info.text, raw: info.value } : undefined };
	}
	private label(k: KeyDef) { return template(k.label, this.scope()); }
	private currentSlots(): Slot[] {
		if (this.overlay) {
			const n = this.geo.keys, ks = this.overlay.keys;
			if (n === ks.length) return ks.map((def) => ({ def, owner: null }));
			// Re-flow onto this deck: items in order, Close on the last key.
			const out: (KeyDef | null)[] = Array(n).fill(null);
			ks.slice(0, -1).filter(Boolean).slice(0, n - 1).forEach((d, i) => (out[i] = d));
			out[n - 1] = ks[ks.length - 1];
			return out.map((def) => ({ def, owner: null }));
		}
		return this.resolved.keys.map((def, i) => ({ def, owner: this.resolved.keyOwners[i] }));
	}

	redrawAll() {
		for (let i = 0; i < this.geo.keys; i++) this.drawKey(i);
		for (let i = 0; i < this.geo.dials; i++) this.drawDial(i);
	}

	private infoKey(owner: LayoutDef | null, spec: InfoSpec) { return `${owner?.id ?? "-"}|${JSON.stringify(spec)}`; }
	private declsFor(owner: LayoutDef | null): Record<string, SecretDecl> { return { ...this.settings.secrets, ...owner?.secrets }; }
	private missingFor(def: { requires?: string[] } | null): string[] { return (def?.requires ?? []).filter((n) => this.missing.get(n) !== false); }

	private keyImage(index: number): string {
		const { def, owner } = this.currentSlots()[index];
		const stripe = this.overlay ? "#A78BFA" : owner?.color ?? this.resolved.layout.color;
		if (this.configErrors.length && index === 0 && !this.overlay) {
			return renderKey({ label: "Config error", sub: "see debug.json", icon: "triangle-alert", color: "#EF4444", bg: this.bg, stripe: "#EF4444" });
		}
		if (this.diag.detector === "none" && index === 0 && !this.overlay) {
			return renderKey({ label: "Can't see apps", sub: "debug.json", icon: "eye-off", color: "#EF4444", bg: this.bg, stripe: "#EF4444" });
		}
		const flash = this.flashes.get(index);
		if (flash && !def) return renderKey({ label: flash.text ?? "", icon: "bell", color: flash.color, bg: this.bg, pressed: true });
		if (!def) return renderKey({ label: "", color: this.accent, bg: this.bg, stripe, empty: true });
		const busy = this.busy.get(index);
		const color = flash?.color ?? def.color ?? owner?.color ?? this.resolved.layout.color ?? this.accent;
		const missing = this.missingFor(def);
		if (missing.length && !busy) {
			return renderKey({ label: this.label(def), sub: `needs ${missing[0]}`, icon: "key-round", color: NEEDS_KEY_COLOR, bg: this.bg, stripe, pressed: this.pressed.has(index) });
		}
		if (def.info && !busy) {
			const res = this.infos.get(this.infoKey(owner, def.info));
			return renderKey({ label: this.label(def), sub: res?.error ? "unavailable" : template(def.sub, this.scope(res)), glyph: res ? res.text : "…", color: res?.color ?? color, bg: def.bg ?? this.bg, stripe, bar: res?.progress, pressed: this.pressed.has(index) || !!flash });
		}
		let status: string | undefined;
		if (def.stateKey) {
			const v = String(this.state[def.stateKey] ?? "");
			status = def.stateColors?.[v] ?? (v ? def.color ?? this.accent : "#3F3F46");
		}
		return renderKey({
			label: busy ? "Working…" : this.label(def),
			sub: busy ?? template(def.sub, this.scope()),
			icon: busy ? "loader" : def.icon,
			glyph: def.glyph ? template(def.glyph, this.scope()) : undefined,
			color, bg: def.bg ?? this.bg, stripe, status,
			pressed: this.pressed.has(index) || !!flash,
		});
	}

	drawKey(index: number) {
		for (const [id, k] of this.keys) {
			if (k.index !== index || k.device !== this.cur.id) continue;
			if (index >= this.geo.keys) continue;
			const img = toDataUrl(this.keyImage(index));
			if (this.lastImage.get(id) === img) continue;
			this.lastImage.set(id, img);
			void k.surface.setImage(img).catch(() => undefined);
			void k.surface.setTitle("").catch(() => undefined);
		}
	}

	private dialVisual(index: number): { svg: string; desc: Record<string, string> } {
		const d = this.resolved.dials[index];
		const owner = this.resolved.dialOwners[index];
		const stripe = owner?.color ?? this.resolved.layout.color;
		const pages = this.resolved.pages.length;
		const nav = pages > 1 ? {
			prev: index === 0, next: index === this.geo.dials - 1,
			pageText: index === this.geo.dials - 1 ? `${this.resolved.page + 1}/${pages}` : index === 0 && this.resolved.page > 0 ? this.resolved.pages[this.resolved.page].name.slice(0, 16) : undefined,
		} : {};
		if (!d) return { svg: renderDial({ label: "", color: this.accent, bg: this.bg, stripe, ...nav }), desc: {} };
		const color = d.color ?? owner?.color ?? this.accent;
		const label = template(d.label, this.scope());
		let value: string | undefined, bar: number | undefined, hint: string | undefined, c = color;
		if (d.kind === "volume") {
			value = `${this.volume}%`; bar = this.volume / 100;
		} else if (d.kind === "value") {
			const v = this.numValue(d);
			value = `${v}${d.unit ?? ""}`; bar = (v - (d.min ?? 0)) / ((d.max ?? 100) - (d.min ?? 0));
		} else if (d.info) {
			const res = this.infos.get(this.infoKey(owner, d.info));
			value = res ? res.text : "…"; bar = res?.progress; c = res?.color ?? color;
		} else {
			value = template(d.value, this.scope()) || undefined;
			hint = d.press ? "turn · press" : "turn";
		}
		return {
			svg: renderDial({ label: label || " ", value, bar, hint, icon: d.icon, color: c, bg: this.bg, stripe, ...nav }),
			desc: { rotate: label || "Turn", push: d.press ? "Press" : "", touch: pages > 1 ? "Swipe: pages" : d.touch ? "Tap" : "" },
		};
	}

	drawDial(index: number) {
		for (const [id, d] of this.dials) {
			if (d.index !== index || d.device !== this.cur.id) continue;
			const { svg, desc } = this.dialVisual(index);
			const img = toDataUrl(svg);
			if (this.lastImage.get(id) === img) continue;
			this.lastImage.set(id, img);
			void d.surface.setFeedback({ canvas: img }).catch(() => undefined);
			void d.surface.setTriggerDescription(desc).catch(() => undefined);
		}
	}

	private numValue(d: Extract<DialDef, { kind: "value" }>): number {
		const v = Number(this.state[d.key]);
		return Number.isFinite(v) ? v : d.min ?? 0;
	}

	private async refreshVolume() {
		if (!this.liveViews().some((v) => v.resolved?.dials.some((d) => d?.kind === "volume"))) return;
		try {
			const v = await this.os.getVolume();
			if (v !== this.volume) { this.volume = v; for (const view of this.liveViews()) this.inView(view, () => this.resolved.dials.forEach((d, i) => d?.kind === "volume" && this.drawDial(i))); }
		} catch { /* ignore */ }
	}

	flash(index: number, color = "#22C55E", text?: string, ms = 1600) {
		const v = this.cur;
		if (index < 0 || index >= v.geo.keys) index = v.geo.keys - 1;
		v.flashes.set(index, { color, text });
		this.drawKey(index);
		setTimeout(() => this.inView(v, () => { v.flashes.delete(index); this.drawKey(index); }), ms);
	}

	// ---------- info + secrets ----------
	/** Polls info sources for what's on screen now (each on its own interval). */
	async pollInfo(now = Date.now()) {
		if (this.overlay) return;
		const visible: { spec: InfoSpec; owner: LayoutDef | null; requires?: string[] }[] = [];
		this.resolved.keys.forEach((k, i) => k?.info && visible.push({ spec: k.info, owner: this.resolved.keyOwners[i], requires: k.requires }));
		this.resolved.dials.forEach((d, i) => d?.info && visible.push({ spec: d.info, owner: this.resolved.dialOwners[i], requires: d.requires }));
		await Promise.all(visible.map(async ({ spec, owner, requires }) => {
			if (this.missingFor({ requires }).length) return;
			const key = this.infoKey(owner, spec);
			const prev = this.infos.get(key);
			if (this.infoInflight.has(key) || (prev && now - prev.at < intervalMs(spec))) return;
			this.infoInflight.add(key);
			try {
				const res = await this.deps.evaluateInfo(spec, this.declsFor(owner));
				this.infos.set(key, res);
				if (res.error && res.error !== prev?.error) this.log(`info ${owner?.id ?? ""}: ${res.error}`);
				if (!prev || prev.text !== res.text || prev.progress !== res.progress || prev.color !== res.color) this.redrawAll();
			} finally {
				this.infoInflight.delete(key);
			}
		}));
	}

	/** Which required secrets are missing (drives the "needs …" rendering). */
	async refreshMissingSecrets() {
		const names = new Set<string>();
		for (const k of [...this.resolved.keys, ...this.resolved.dials]) for (const n of k?.requires ?? []) names.add(n);
		let changed = false;
		for (const n of names) {
			const missing = !(await this.deps.secrets.get(n).catch(() => undefined));
			if (this.missing.get(n) !== missing) { this.missing.set(n, missing); changed = true; }
		}
		if (changed) this.redrawAll();
	}

	async setSecret(name: string): Promise<boolean> {
		const decl = Object.values(this.resolved.levels).map((l) => l?.secrets?.[name]).find(Boolean) ?? this.settings.secrets?.[name];
		const msg = `Enter ${name}${decl?.description ? `\n${decl.description}` : ""}${decl?.url ? `\nGet it at: ${decl.url}` : ""}\n\nSaved in your macOS Keychain only.`;
		const v = await this.deps.prompt("ContextDeck", msg);
		if (!v) return false;
		await this.deps.secrets.set(name, v.trim());
		this.missing.set(name, false);
		this.infos.clear();
		this.redrawAll();
		void this.pollInfo();
		return true;
	}

	// ---------- input ----------
	keyDown(index: number, device?: string) {
		this.touch(device);
		if (index >= this.geo.keys) return;
		const { def } = this.currentSlots()[index];
		this.pressed.add(index);
		this.drawKey(index);
		if (!def) return;
		if (def.hold) {
			const v = this.cur;
			const entry = { held: false, timer: setTimeout(() => this.inView(v, () => { entry.held = true; void this.exec(def.hold!, index); }), this.settings.holdMs ?? 500) };
			this.holdTimers.set(index, entry);
		} else {
			this.pressAction(index);
		}
	}

	private pressAction(index: number) {
		const { def, owner } = this.currentSlots()[index];
		if (!def) return;
		const missing = this.missingFor(def);
		if (missing.length) return void this.exec({ type: "secretSet", name: missing[0] }, index);
		if (def.action) void this.exec(def.action, index);
		else if (def.info) { this.infos.delete(this.infoKey(owner, def.info)); void this.pollInfo(); }
	}

	keyUp(index: number, device?: string) {
		this.touch(device);
		if (index >= this.geo.keys) return;
		const { def } = this.currentSlots()[index];
		this.pressed.delete(index);
		this.drawKey(index);
		const h = this.holdTimers.get(index);
		if (h) {
			clearTimeout(h.timer);
			this.holdTimers.delete(index);
			if (!h.held) this.pressAction(index);
		}
		if (def?.release) void this.exec(def.release, index);
	}

	async dialRotate(index: number, ticks: number, device?: string) {
		this.touch(device);
		const d = this.resolved.dials[index];
		if (!d) return;
		const owner = this.resolved.dialOwners[index];
		if (d.kind === "volume") {
			this.volume = Math.max(0, Math.min(100, this.volume + ticks * (d.step ?? 3)));
			this.drawDial(index);
			await this.os.setVolume(this.volume).catch(() => undefined);
		} else if (d.kind === "value") {
			const step = d.step ?? 1;
			const v = Math.max(d.min ?? 0, Math.min(d.max ?? 100, this.numValue(d) + ticks * step));
			this.state[d.key] = Math.round(v * 1000) / 1000;
			this.drawDial(index);
			if (d.onChange) {
				clearTimeout(this.valueTimers.get(d.key));
				this.valueTimers.set(d.key, setTimeout(() => void this.exec(d.onChange!, -1, owner), d.debounceMs ?? 120));
			}
		} else {
			const a = ticks > 0 ? d.cw : d.ccw;
			if (!a) return;
			for (let i = 0; i < Math.min(Math.abs(ticks), 12); i++) await this.exec(a, -1, owner);
		}
	}

	dialPress(index: number, device?: string) {
		this.touch(device);
		const d = this.resolved.dials[index];
		if (d?.kind === "volume" && !d.press) return void this.os.toggleMute().catch(() => undefined);
		if (d?.press) void this.exec(d.press, -1, this.resolved.dialOwners[index]);
	}

	/** A swipe on the deck (detected from Stream Deck page changes; see swipe.ts). */
	swipe(dir: "next" | "prev", device?: string) {
		this.touch(device);
		if (this.resolved.pages.length > 1) this.goPage(dir);
	}

	/** Touch strip: tap the outer edges to change page; long-touch anywhere = next page; otherwise the dial's touch action. */
	dialTouch(index: number, long: boolean, x = 100, device?: string) {
		this.touch(device);
		const many = this.resolved.pages.length > 1;
		if (many && index === 0 && x < 50) return this.goPage("prev");
		if (many && index === this.geo.dials - 1 && x > 150) return this.goPage("next");
		const d = this.resolved.dials[index];
		const a = long ? d?.longTouch ?? d?.touch : d?.touch;
		if (a) return void this.exec(a, -1, this.resolved.dialOwners[index]);
		if (long && many) this.goPage("next");
	}

	// ---------- overlays ----------
	showOverlay(spec: OverlaySpec): string {
		this.closeOverlay(null);
		const id = spec.id ?? `ov_${Date.now().toString(36)}`;
		const pickMode = spec.onPick ?? "copy";
		let keys: (KeyDef | null)[];
		if (spec.keys) {
			keys = spec.keys.slice(0, KEY_COUNT);
		} else {
			const items = (spec.items ?? []).slice(0, KEY_COUNT - 1);
			keys = items.map((it, i) => ({
				label: it.label.length > 14 ? `${it.label.slice(0, 13)}…` : it.label,
				sub: it.sub ?? (it.label.length > 14 ? it.label.slice(13, 28) : undefined),
				icon: it.icon,
				glyph: it.icon ? undefined : String(i + 1),
				color: it.color ?? "#A78BFA",
				action: { type: "state", key: `__pick:${id}`, value: { index: i, value: it.value ?? it.label, mode: pickMode } } as Action,
			}));
		}
		while (keys.length < KEY_COUNT) keys.push(null);
		keys[KEY_COUNT - 1] ??= { label: "Close", icon: "x", color: "#71717A", action: { type: "closeOverlay" } };
		this.overlay = { ...spec, id, keys };
		if (spec.timeoutMs) this.overlay.timer = setTimeout(() => this.closeOverlay(null), spec.timeoutMs);
		this.emit("context", this.snapshot());
		this.redrawAll();
		return id;
	}

	closeOverlay(result: { picked: string | null; index: number | null } | null) {
		if (!this.overlay) return;
		const { id, timer } = this.overlay;
		clearTimeout(timer);
		this.overlay = null;
		this.pickWaiters.get(id)?.(result ?? { picked: null, index: null });
		this.pickWaiters.delete(id);
		this.redrawAll();
	}

	waitForPick(id: string, timeoutMs: number): Promise<{ picked: string | null; index: number | null }> {
		return new Promise((res) => {
			const t = setTimeout(() => { this.pickWaiters.delete(id); res({ picked: null, index: null }); }, timeoutMs);
			this.pickWaiters.set(id, (v) => { clearTimeout(t); res(v); });
		});
	}

	// ---------- actions ----------
	/** owner = the layout the pressed key came from (for secrets, modes and editing). */
	async exec(a: Action, index: number, owner?: LayoutDef | null): Promise<void> {
		a = a.on?.[this.os.id] ?? a;
		const own = owner !== undefined ? owner : index >= 0 ? this.currentSlots()[index]?.owner ?? null : null;
		try {
			await this.run(a, index, own);
		} catch (e) {
			if (e instanceof MissingSecretError) { this.missing.set(e.secret, true); this.redrawAll(); }
			this.log(`action ${a.type} failed: ${(e as Error).message}`);
			if (index >= 0) for (const k of this.keys.values()) if (k.index === index) void k.surface.showAlert();
			void this.os.notify((e as Error).message, "ContextDeck");
		}
	}

	private async run(a: Action, index: number, owner: LayoutDef | null): Promise<void> {
		a = a.on?.[this.os.id] ?? a;
		const t = (s: string) => template(s, this.scope());
		switch (a.type) {
			case "keys": return this.os.sendKeys(a.keys);
			case "type": return void (await this.os.typeText(t(a.text)));
			case "shell": return this.os.shell(t(a.cmd));
			case "open": return void (await this.os.open(t(a.target)));
			case "applescript": return void (await this.os.runScript(a.script, "applescript", 30000));
			case "script": return void (await this.os.runScript(a.script, a.lang, 30000));
			case "copy": return void (await this.os.setClipboard(t(a.text)));
			case "http": {
				const raw = { url: t(a.url), headers: { "content-type": "application/json", ...a.headers }, body: a.body === undefined ? undefined : t(JSON.stringify(a.body)) };
				const req = await withSecrets(raw, raw.url, this.declsFor(owner), this.deps.secrets);
				const res = await this.deps.fetch(req.url, { method: a.method ?? (a.body ? "POST" : "GET"), headers: req.headers, body: req.body, signal: AbortSignal.timeout(10_000) });
				if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(req.url).host}`);
				if (index >= 0) this.flash(index, "#22C55E", undefined, 600);
				return;
			}
			case "mode": return this.setMode(a.mode, a.layout ?? (owner?.modes?.[a.mode] ? owner.id : undefined));
			case "layout": return this.forceLayout(a.id);
			case "page": return this.goPage(a.page);
			case "flag": return this.setFlag(a.flag, a.value);
			case "closeOverlay": return this.closeOverlay(null);
			case "overlay": return void this.showOverlay(a.overlay);
			case "state": {
				if (a.key.startsWith("__pick:")) {
					const p = a.value as { index: number; value: string; mode: string };
					const id = a.key.slice(7);
					if (p.mode !== "return") await this.os.setClipboard(p.value);
					this.closeOverlay({ picked: p.value, index: p.index });
					if (p.mode === "paste") { await new Promise((r) => setTimeout(r, 80)); await this.os.sendKeys("mod+v"); }
					else if (p.mode === "copy") this.flash(this.geo.keys - 1, "#22C55E", "Copied", 900);
					this.emit("pick", { id, ...p });
					return;
				}
				if (a.key === "__providers") return this.showProviderPicker();
				return this.setState(a.key, a.value);
			}
			case "elgato": {
				const out = await this.elgato.call(a.tool, a.args ?? {});
				if (index >= 0) this.flash(index, "#22C55E", out ? out.slice(0, 14) : undefined, 900);
				return;
			}
			case "sequence":
				for (const s of a.steps) {
					await this.run(s, index, owner);
					if (a.delayMs) await new Promise((r) => setTimeout(r, a.delayMs));
				}
				return;
			case "claude":
			case "llm": return this.runLlm(a, index);
			case "llmSelect": return this.selectLlm(a.provider);
			case "menu": {
				if (!this.ctx.bundleId) throw new Error("No app in front");
				return void (await this.os.clickMenu(this.ctx.bundleId, a.path));
			}
			case "setup": {
				const r = await this.runSetup({ force: a.force, update: a.update, index });
				if (!r.ok) throw new Error(r.error ?? "Setup failed");
				return;
			}
			case "secretSet": { await this.setSecret(a.name); return; }
			case "deckMenu": return void this.showDeckMenu();
			case "ui": return this.openUi();
			case "reload": this.reloadConfig(); this.flash(index >= 0 ? index : 0, "#22C55E", "Reloaded", 900); return;
			case "editLayout": {
				const id = a.layout ?? owner?.id ?? this.resolved.layout.id;
				const file = this.sources[id];
				if (!file) throw new Error(`"${id}" has no file (built-in fallback)`);
				return this.deps.openFile(file);
			}
		}
	}

	// ---------- auto-setup ----------
	private isSpecific(l: LayoutDef | undefined): boolean {
		if (!l || l.generic) return false;
		const m = l.match ?? {};
		return !!(m.bundleId || m.app || m.url || m.title || m.flags || m.sub);
	}

	/** The app or site in front that has no layout of its own yet (or an outdated generated one). */
	setupTargetFor(r: Resolved): Target | undefined {
		if ((this.settings.autoSetup ?? "key") === "off" || this.forcedLayout || this.overlay || r.levels.takeover) return undefined;
		const { bundleId, app, url } = this.ctx;
		if (!bundleId) return undefined;
		const ignore = new Set([...SETUP_IGNORE, ...(this.settings.setupIgnore ?? [])]);
		if (ignore.has(bundleId)) return undefined;
		if (this.browsers.includes(bundleId)) {
			if ((r.levels.sub && !r.levels.sub.generic) || !url || NON_WEB.test(url)) return undefined;
			const t = targetForSite(bundleId, url);
			return t && !ignore.has(t.host!) ? t : undefined;
		}
		const appL = r.levels.app;
		if (this.isSpecific(appL)) {
			const installed = this.versions.get(bundleId);
			const g = appL!.generated;
			if (g?.appVersion && installed && installed !== g.appVersion) return { ...targetForApp(bundleId, app), id: appL!.id, update: true };
			return undefined;
		}
		return targetForApp(bundleId, app);
	}

	private maybeAutoSetup(t: SetupTarget) {
		if (this.settings.autoSetup !== "auto" || this.setupRunning || this.setupState[t.id]) return;
		if (this.dwellTarget === t.id) return;
		clearTimeout(this.dwellTimer);
		this.dwellTarget = t.id;
		this.dwellTimer = setTimeout(() => {
			this.dwellTarget = "";
			const now = this.setupTargetFor(this.resolved);
			if (now?.id === t.id) void this.runSetup({ index: this.settings.setupSlot ?? 6 });
		}, this.settings.setupDwellMs ?? 4000);
	}

	/** Research (optional) → condensed digest, cached per app version. */
	private async research(t: SetupTarget, platform: Platform, busy: (m: string) => void): Promise<Digest | undefined> {
		const rs = this.settings.research ?? {};
		const provider = rs.provider ?? "none";
		if (provider === "none") return undefined;
		const cacheKey = `${t.id}@${platform.appVersion || "latest"}`;
		const cached = this.deps.loadResearch(cacheKey);
		if (cached) { this.log(`research ${t.id}: using cache ${cacheKey}`); return cached; }
		const llm = this.settings.setupLlm ?? this.llm;
		const subject = t.kind === "site" ? t.host! : t.name;
		let digestText: string;
		if (provider === "openrouter-online") {
			busy("researching (web)");
			const base = this.settings.providers?.openrouter?.model;
			if (!base) throw new Error("research.provider openrouter-online needs providers.openrouter.model");
			const { system, prompt } = digestPrompt(subject, t.kind, platform, []);
			digestText = await this.deps.ask({ provider: "openrouter", model: `${base.replace(/:online$/, "")}:online`, system, prompt: `${prompt}\n\nNo documents are attached: search the web for the current official documentation first.`, maxTokens: 3000, json: true });
		} else {
			busy("searching the web");
			const hits: SearchHit[] = [];
			for (const q of queriesFor(t.name, t.kind, platform, t.host)) hits.push(...(await this.deps.search(q).catch((e) => { this.log(`research search: ${(e as Error).message}`); return [] as SearchHit[]; })));
			const seen = new Set<string>();
			const ranked = rankHits(hits.filter((h) => !seen.has(h.url) && !!seen.add(h.url)), t.name, t.host);
			busy("reading docs");
			const n = rs.fetchPages ?? 3;
			const docs: { url: string; text: string }[] = [];
			for (const h of ranked.slice(0, n)) {
				try { docs.push({ url: h.url, text: await this.deps.fetchPage(h.url) }); } catch (e) { this.log(`research fetch ${h.url}: ${(e as Error).message}`); }
			}
			for (const h of ranked.slice(n, n + 5)) docs.push({ url: h.url, text: `${h.title}\n${h.snippet}` });
			if (!docs.length) return undefined;
			busy(`reading (${providerName(this.settings, llm)})`);
			const { system, prompt } = digestPrompt(subject, t.kind, platform, docs);
			digestText = await this.deps.ask({ provider: llm, system, prompt, maxTokens: 3000, json: true });
		}
		const raw = extractJson(digestText) as Partial<Digest>;
		const digest: Digest = { app: raw.app ?? t.name, version: raw.version ?? platform.appVersion, shortcuts: raw.shortcuts ?? [], info: raw.info ?? [], apis: raw.apis ?? [], notes: raw.notes, sources: [] };
		digest.sources = [...new Set([...digest.shortcuts, ...digest.info].map((x) => x.source).filter((s): s is string => !!s))];
		this.deps.saveResearch(cacheKey, digest);
		this.log(`research ${t.id}: ${digest.shortcuts.length} shortcuts, ${digest.info.length} info ideas, ${digest.apis.length} APIs from ${digest.sources.length} sources`);
		return digest;
	}

	/** Menus + research → model plan → validated layout file; switches the deck to it. */
	async runSetup(opts: { force?: boolean; update?: boolean; index?: number } = {}): Promise<SetupResult> {
		let target: Target | undefined = this.setupTargetFor(this.resolved);
		const appL = this.resolved.levels.app, subL = this.resolved.levels.sub;
		const generatedHere = (subL?.generated ? subL : undefined) ?? (appL?.generated ? appL : undefined);
		let existing: LayoutDef | undefined = target?.update ? appL : undefined;
		if (!target && (opts.force || opts.update)) {
			if (generatedHere) {
				const g = generatedHere.generated!;
				target = g.host
					? { kind: "site", id: `site.${g.host}`, name: g.host, bundleId: this.ctx.bundleId, host: g.host }
					: targetForApp(g.bundleId ?? this.ctx.bundleId, g.app ?? this.ctx.app);
				if (opts.update) existing = generatedHere;
				if (generatedHere.id !== target.id) target.legacyId = generatedHere.id;
			} else if (this.isSpecific(subL) || this.isSpecific(appL)) {
				const l = subL ?? appL!;
				return { ok: false, error: `"${l.name ?? l.id}" is hand-written. Edit its file instead (hold the AI key → Edit).` };
			}
		}
		if (!target) return { ok: false, error: "Nothing to set up here (no app in front, or it's ignored)." };
		if (this.setupRunning) return { ok: false, error: `Already setting up ${this.setupRunning}` };
		const tgt: Target = target;

		const index = opts.index ?? this.settings.setupSlot ?? 6;
		const view = this.cur;
		const busy = (msg: string) => { if (index >= 0) this.inView(view, () => { view.busy.set(index, msg); this.drawKey(index); }); };
		this.setupRunning = tgt.id;
		this.log(`setup ${tgt.id}: start${existing ? " (update)" : ""}`);
		try {
			busy("checking platform");
			const platform = await this.deps.platform(tgt.kind === "app" ? tgt.bundleId : undefined).catch(() => undefined);
			if (platform && tgt.kind === "site") platform.browser = this.ctx.app;
			let entries: MenuEntry[] = [];
			if (tgt.kind === "app") {
				busy("reading menus");
				try {
					entries = usefulEntries(await this.deps.scanMenus(tgt.bundleId), tgt.name);
					this.log(`setup ${tgt.id}: ${entries.length} menu items (${entries.filter((e) => e.chord).length} with shortcuts)`);
				} catch (e) {
					this.log(`setup ${tgt.id}: menu scan failed: ${(e as Error).message}`);
				}
			}
			let digest: Digest | undefined;
			try {
				digest = platform ? await this.research(tgt, platform, busy) : undefined;
			} catch (e) {
				this.log(`setup ${tgt.id}: research failed, continuing without: ${(e as Error).message}`);
			}

			const { zones } = normalize(this.config);
			const keySlots = KEY_COUNT - zones.system.keys.length;
			const dialSlots = Math.max(1, PLUS.dials - zones.system.dials.length);
			const { system, prompt } = buildPrompt({ target: tgt, entries, slots: { keys: keySlots, dials: dialSlots }, iconHints: ICON_HINTS, platform, digest, existing });
			const primary = this.settings.setupLlm ?? this.llm;
			const fallback = this.settings.fallbackLlm && this.settings.fallbackLlm !== primary ? this.settings.fallbackLlm : undefined;
			const allowKnowledge = this.settings.research?.allowKnowledge ?? true;
			const attempt = async (provider: string) => {
				const modelOverride = provider === primary ? this.settings.setupModel : undefined;
				const model = modelOverride ?? this.settings.providers?.[provider]?.model ?? (provider === "anthropic" ? this.settings.model ?? "default" : "default");
				busy(`designing (${providerName(this.settings, provider)})`);
				const text = await this.deps.ask({ provider, model: modelOverride, prompt, system, maxTokens: 4000, json: true });
				return planToLayout(tgt, extractJson(text) as never, entries, this.deps.icons(), { keySlots, dialSlots, model: `${provider}:${model}`, digest, platform, allowKnowledge });
			};
			let planned: ReturnType<typeof planToLayout>;
			try {
				planned = await attempt(primary);
			} catch (e) {
				if (!fallback) throw e;
				this.log(`setup ${tgt.id}: ${providerName(this.settings, primary)} failed (${(e as Error).message}); trying ${providerName(this.settings, fallback)}`);
				planned = await attempt(fallback);
			}
			const { layout, dropped } = planned;

			// Dry-run every info source once; keep those that work or only lack a secret.
			busy("testing info keys");
			const decls = { ...this.settings.secrets, ...layout.secrets };
			const check = async (list: (KeyDef | DialDef | null)[] | undefined, what: string) => {
				if (!list) return;
				for (let i = list.length - 1; i >= 0; i--) {
					const k = list[i];
					if (!k?.info) continue;
					const res = await this.deps.evaluateInfo(k.info, decls);
					if (res.error && !/^Needs [A-Z0-9_]+\./.test(res.error)) { dropped.push(`${what} ${i + 1} (${k.label}): info failed: ${res.error}`); list.splice(i, 1); }
				}
			};
			await check(layout.keys, "key");
			await check(layout.dials, "dial");
			for (const p of layout.pages ?? []) await check(p.keys, "more key");

			busy("writing layout");
			const file = this.deps.writeLayout(layout);
			if (tgt.legacyId) { try { this.deps.removeLayout(tgt.legacyId); } catch { /* ignore */ } }
			this.sources[layout.id] = file;
			this.config = { ...this.config, layouts: [...this.config.layouts.filter((l) => l.id !== layout.id && l.id !== tgt.legacyId), layout] };
			this.setupState[tgt.id] = { at: new Date().toISOString(), ok: true, layout: layout.id };
			this.deps.saveSetupState(this.setupState);
			const all = [...(layout.keys ?? []), ...(layout.pages ?? []).flatMap((p) => p.keys ?? [])].filter(Boolean) as KeyDef[];
			const nKeys = all.length, nDials = (layout.dials ?? []).filter(Boolean).length, nInfo = all.filter((k) => k.info).length;
			const secretList = Object.keys(layout.secrets ?? {});
			this.log(`setup ${tgt.id}: wrote ${file} (${nKeys} keys, ${nDials} dials, ${nInfo} info, secrets: ${secretList.join(", ") || "none"}${dropped.length ? `; dropped: ${dropped.join("; ")}` : ""})`);
			void this.os.notify(`${layout.name}: ${nKeys} keys${nInfo ? ` (${nInfo} live)` : ""}, ${nDials} dials · ${layout.generated?.source}${secretList.length ? ` · optional keys: ${secretList.join(", ")}` : ""}`, "ContextDeck set up");
			return { ok: true, layout: layout.id, name: layout.name, keys: nKeys, dials: nDials, info: nInfo, source: layout.generated?.source, secrets: secretList, dropped };
		} catch (e) {
			const error = (e as Error).message;
			this.setupState[tgt.id] = { at: new Date().toISOString(), ok: false, error };
			this.deps.saveSetupState(this.setupState);
			this.log(`setup ${tgt.id}: failed: ${error}`);
			return { ok: false, error };
		} finally {
			this.setupRunning = null;
			if (index >= 0) view.busy.delete(index);
			for (const v of this.views.values()) { v.pageMemory.delete(v.contextKey); v.contextKey = ""; }
			this.recompute(true);
			if (this.setupState[tgt.id]?.ok) this.flash(0, "#22C55E", undefined, 900);
		}
	}

	/** ContextDeck's own menu (hold the AI key). */
	showDeckMenu() {
		const r = this.resolved;
		const l = r.layout;
		const gen = r.levels.sub?.generated ? r.levels.sub : r.levels.app?.generated ? r.levels.app : undefined;
		const target = this.setupTargetFor(r);
		const close = (a: Action): Action => ({ type: "sequence", steps: [{ type: "closeOverlay" }, a] });
		const pinned = !!this.forcedLayout;
		const missing = [...this.missing.entries()].filter(([, m]) => m).map(([n]) => n);
		this.showOverlay({
			title: "ContextDeck",
			keys: [
				target ? { label: target.update ? "Update" : "Set up", sub: target.name, icon: "wand-sparkles", color: SETUP_COLOR, action: close({ type: "setup", update: target.update }) }
					: gen ? { label: "Rebuild", sub: gen.name ?? gen.id, icon: "wand-sparkles", color: SETUP_COLOR, action: close({ type: "setup", force: true }) }
					: { label: "Hand-made", sub: "edit file", icon: "wand-sparkles", color: "#52525B" },
				{ label: "Edit", sub: l.name ?? l.id, icon: "file-pen-line", color: SETUP_COLOR, action: close({ type: "editLayout", layout: l.id }) },
				missing.length
					? { label: "Add key", sub: missing[0], icon: "key-round", color: NEEDS_KEY_COLOR, action: close({ type: "secretSet", name: missing[0] }) }
					: { label: "Folder", sub: "all layouts", icon: "folder-open", color: SETUP_COLOR, action: close({ type: "open", target: LAYOUTS_DIR }) },
				{ label: "App", sub: "layouts, keys, logs", icon: "app-window", color: SETUP_COLOR, action: close({ type: "ui" }) },
				{ label: pinned ? "Unpin" : "Pin", sub: pinned ? "back to auto" : "keep this layout", icon: pinned ? "pin-off" : "pin", color: SETUP_COLOR, action: close({ type: "layout", id: pinned ? null : l.id }) },
				{ label: "AI model", sub: this.llmName, icon: "cpu", color: "#D97757", action: close({ type: "state", key: "__providers", value: true }) },
				r.pages.length > 1
					? { label: "Next page", sub: `${r.page + 1}/${r.pages.length}`, icon: "chevrons-right", color: "#71717A", action: close({ type: "page", page: "next" }) }
					: { label: this.ctx.app || "No app", sub: l.id, icon: "info", color: "#71717A" },
				{ label: "Close", icon: "x", color: "#71717A", action: { type: "closeOverlay" } },
			],
		});
	}

	/** Overlay listing configured providers; pressing one makes it the default. */
	showProviderPicker() {
		const ids = configuredProviders(this.settings).slice(0, KEY_COUNT - 1);
		this.showOverlay({
			title: "AI provider",
			keys: ids.map((id) => ({
				label: providerName(this.settings, id),
				sub: id === this.llm ? "● in use" : (this.settings.providers?.[id]?.model ?? (id === "anthropic" ? this.settings.model ?? "claude" : "")).split("/").pop()?.slice(0, 14),
				icon: id === this.llm ? "circle-check" : "cpu",
				color: id === this.llm ? "#22C55E" : "#D97757",
				action: { type: "sequence", steps: [{ type: "closeOverlay" }, { type: "llmSelect", provider: id }] },
			})),
		});
	}

	selectLlm(provider: string | null) {
		this.llmOverride = provider && provider !== this.settings.llm ? provider : null;
		this.deps.savePrefs({ llm: this.llmOverride });
		this.log(`LLM provider → ${this.llm}`);
		this.redrawAll();
		this.flash(this.geo.keys - 1, "#22C55E", this.llmName, 1200);
	}

	private async runLlm(a: { type: "llm" | "claude" } & LlmAction, index: number) {
		const inputMode = a.input ?? "selection";
		const provider = a.provider ?? this.llm;
		const view = this.cur;
		if (index >= 0) { view.busy.set(index, `asking ${providerName(this.settings, provider)}`); this.drawKey(index); }
		try {
			let input = "";
			if (inputMode === "selection") input = (await this.os.copySelection()) || (await this.os.getClipboard());
			else if (inputMode === "clipboard") input = await this.os.getClipboard();
			const out = a.output ?? "clipboard";
			const prompt = template(a.prompt, this.scope()) + (out === "choices" ? "\n\nReturn up to 7 options, one per line, no numbering, each under 60 characters." : "");
			let text: string;
			try {
				text = await this.deps.ask({ provider, model: a.model, prompt, input: input || undefined, system: a.system, maxTokens: a.maxTokens });
			} catch (e) {
				const fb = this.settings.fallbackLlm;
				if (!fb || fb === provider) throw e;
				this.log(`${provider} failed (${(e as Error).message}); falling back to ${fb}`);
				text = await this.deps.ask({ provider: fb, prompt, input: input || undefined, system: a.system, maxTokens: a.maxTokens });
			}
			if (out === "choices") {
				this.showOverlay({ title: "Pick one", items: parseChoices(text).map((label) => ({ label })), onPick: "copy" });
			} else if (out === "paste") {
				await this.os.setClipboard(text);
				await this.os.sendKeys("mod+v");
			} else if (out === "notify") {
				await this.os.setClipboard(text);
				await this.os.notify(text, providerName(this.settings, provider));
			} else {
				await this.os.setClipboard(text);
				if (index >= 0) this.flash(index, "#22C55E", "Copied", 1200);
			}
		} finally {
			if (index >= 0) this.inView(view, () => { view.busy.delete(index); this.drawKey(index); });
		}
	}
}
