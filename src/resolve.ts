/**
 * Three-level context resolution and page composition.
 *
 *   system   always present (AI key, volume, media …)
 *   app      the app in front (browser tab ops, editor ops …)
 *   sub      what's inside it (a website, a window/document via probe, …)
 *   takeover flag-driven layouts that replace app+sub (e.g. Recording)
 *
 * Page 1 ("smart") mixes the levels by zones; the other pages show each level in full.
 */
import type { Config, Context, DialDef, KeyDef, Level, LayoutDef, Match, PageInfo, Resolved, Zone } from "./types";

/** Layouts are authored for the Stream Deck + (4×2 keys, 4 dials); other devices get the same layouts re-flowed. */
export const KEY_COUNT = 8;
export const DIAL_COUNT = 4;
export const KEY_MAX = 64;     // Stream Deck Mobile (largest)
export const DIAL_MAX = 6;     // Stream Deck + XL

export interface Geometry { keys: number; dials: number; cols: number; rows: number; kind?: string }
export const PLUS: Geometry = { keys: 8, dials: 4, cols: 4, rows: 2, kind: "plus" };

export const DEFAULT_ZONES: Record<"system" | "app" | "sub", Zone> = {
	sub: { keys: [0, 1, 2, 3], dials: [0, 1] },
	app: { keys: [4, 5, 6], dials: [2] },
	system: { keys: [7], dials: [3] },
};

/** Is this the geometry layouts are written for (so slot numbers keep their meaning)? */
export const isNative = (g: Geometry) => g.keys === KEY_COUNT && g.cols === 4;

const range = (a: number, b: number) => Array.from({ length: Math.max(0, b - a) }, (_, i) => a + i);

/**
 * Zones for any device, in reading order: sub first, then app, the system level at the end
 * (bottom-right, where the AI key and volume live on the +).
 *   keys: system gets 1 key up to 8 keys, otherwise ¼ of the deck (max 8); sub ≈ half of the rest.
 *   dials: system gets the last dial; sub ≈ half of the rest.
 * Devices without dials reserve their last key for page navigation (it shows app keys when there's only one page).
 */
export function zonesFor(g: Geometry): Record<"system" | "app" | "sub", Zone> {
	if (g.keys === KEY_COUNT && g.dials === DIAL_COUNT) return DEFAULT_ZONES;
	const n = g.keys, nav = g.dials === 0 && n >= 6 ? 1 : 0;
	const S = n < 4 ? 0 : n <= 8 ? 1 : Math.min(8, Math.ceil(n / 4));
	const rest = n - S - nav, subN = Math.ceil(rest / 2);
	const D = g.dials, DS = D >= 2 ? 1 : 0, dSub = Math.ceil((D - DS) / 2);
	return {
		sub: { keys: range(0, subN), dials: range(0, dSub) },
		app: { keys: [...range(subN, rest), ...range(n - nav, n)], dials: range(dSub, D - DS) },
		system: { keys: range(rest, rest + S), dials: range(D - DS, D) },
	};
}

/** Short device name used for per-device zone overrides (settings.deviceZones). */
export const DEVICE_KINDS: Record<number, string> = { 0: "mk2", 1: "mini", 2: "xl", 3: "mobile", 4: "gkeys", 5: "pedal", 6: "voyager", 7: "plus", 8: "scuf", 9: "neo", 10: "studio", 11: "virtual", 12: "galleon", 13: "plusxl" };
/** Dial count by device type (the SDK reports the key grid, not the dials). */
export const DIALS_BY_TYPE: Record<number, number> = { 7: 4, 10: 2, 12: 2, 13: 6 };

const arr = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

const globCache = new Map<string, RegExp>();
export function glob(pattern: string, value: string): boolean {
	let re = globCache.get(pattern);
	if (!re) {
		if (pattern.startsWith("/") && pattern.lastIndexOf("/") > 0) {
			const end = pattern.lastIndexOf("/");
			re = new RegExp(pattern.slice(1, end), pattern.slice(end + 1) || "i");
		} else {
			const src = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
			re = new RegExp(`^${src}$`, "i");
		}
		globCache.set(pattern, re);
	}
	return re.test(value);
}

const minutes = (hhmm: string) => {
	const [h, m] = hhmm.split(":").map(Number);
	return h * 60 + (m || 0);
};

export function inTime([from, to]: [string, string], now: Date): boolean {
	const t = now.getHours() * 60 + now.getMinutes();
	const a = minutes(from), b = minutes(to);
	return a <= b ? t >= a && t < b : t >= a || t < b;
}

/** Returns a specificity score (>=0) if the match applies, or -1 if it doesn't. */
export function matchScore(m: Match | undefined, ctx: Context): number {
	if (!m) return 0;
	let score = 0;
	const test = (pats: string[], value: string) => pats.length === 0 || pats.some((p) => glob(p, value));
	const checks: [string[], string, number][] = [
		[arr(m.bundleId), ctx.bundleId, 4],
		[arr(m.app), ctx.app, 4],
		[arr(m.url), ctx.url, 8],
		[arr(m.title), ctx.title, 6],
		[arr(m.sub), ctx.sub ?? "", 6],
	];
	for (const [pats, value, w] of checks) {
		if (!test(pats, value)) return -1;
		if (pats.length) {
			score += w;
			// More literal characters in the matching pattern = more specific (studio.youtube.com beats *.youtube.com).
			const best = Math.max(...pats.filter((p) => glob(p, value)).map((p) => p.replace(/[*?]/g, "").length));
			score += Math.min(3, best / 12);
		}
	}
	if (m.time) { if (!inTime(m.time, ctx.now)) return -1; score += 2; }
	if (m.days) { if (!m.days.includes(ctx.now.getDay())) return -1; score += 1; }
	for (const f of arr(m.flags)) { if (!ctx.flags[f]) return -1; score += 10; }
	for (const f of arr(m.notFlags)) { if (ctx.flags[f]) return -1; }
	return score;
}

/** Level of a layout: explicit, or inferred from its id and match (keeps hand-written legacy layouts working). */
export function levelOf(l: LayoutDef): Level {
	if (l.level) return l.level;
	if (l.id === "system" || l.id.startsWith("system.")) return "system";
	if (l.id.startsWith("takeover.") || l.pinned === false) return "takeover";
	if (l.id.startsWith("site.") || l.id.startsWith("sub.")) return "sub";
	if (l.id.startsWith("app.")) return "app";
	const m = l.match ?? {};
	if (m.flags && !m.bundleId && !m.app && !m.url) return "takeover";
	if (m.url || m.sub || m.title) return "sub";
	return "app";
}

/** Folds the legacy `pinned` block into a system layout, and fills in zones. */
export function normalize(cfg: Config, g: Geometry = PLUS): { layouts: LayoutDef[]; zones: Record<"system" | "app" | "sub", Zone> } {
	const layouts = [...cfg.layouts];
	const custom = g.keys === KEY_COUNT && g.dials === DIAL_COUNT ? cfg.settings?.zones : undefined;
	const perDevice = cfg.settings?.deviceZones?.[g.kind ?? ""] ?? cfg.settings?.deviceZones?.[`${g.cols}x${g.rows}`];
	const zones = { ...zonesFor(g), ...custom, ...perDevice } as Record<"system" | "app" | "sub", Zone>;
	const hasSystem = layouts.some((l) => levelOf(l) === "system");
	if (!hasSystem && cfg.pinned) {
		const keyIdx = Object.keys(cfg.pinned.keys ?? {}).map(Number).sort((a, b) => a - b);
		const dialIdx = Object.keys(cfg.pinned.dials ?? {}).map(Number).sort((a, b) => a - b);
		layouts.push({
			id: "system", name: "System", level: "system",
			keys: keyIdx.map((i) => cfg.pinned!.keys![String(i)]),
			dials: dialIdx.map((i) => cfg.pinned!.dials![String(i)]),
		});
		if (!cfg.settings?.zones?.system) zones.system = { keys: keyIdx, dials: dialIdx };
	}
	return { layouts, zones };
}

/** Best layout of one level: highest priority, then most specific match, then file order. */
export function pick(layouts: LayoutDef[], ctx: Context, level: Level): LayoutDef | undefined {
	let best: LayoutDef | undefined;
	let bestRank: [number, number] = [-Infinity, -Infinity];
	for (const l of layouts) {
		if (levelOf(l) !== level) continue;
		const s = matchScore(l.match, ctx);
		if (s < 0) continue;
		const rank: [number, number] = [l.priority ?? 0, s];
		if (rank[0] > bestRank[0] || (rank[0] === bestRank[0] && rank[1] > bestRank[1])) {
			best = l;
			bestRank = rank;
		}
	}
	return best;
}

export function activeMode(l: LayoutDef, modes: Record<string, string> = {}): string | undefined {
	const names = Object.keys(l.modes ?? {});
	if (!names.length) return undefined;
	const m = modes[l.id] ?? l.defaultMode ?? names[0];
	return l.modes?.[m] ? m : names[0];
}

function positional<T>(n: number, ...sources: ((T | null)[] | undefined)[]): (T | null)[] {
	const out: (T | null)[] = Array(n).fill(null);
	for (const src of sources) {
		if (!src) continue;
		src.slice(0, n).forEach((v, i) => { if (v !== undefined && v !== null) out[i] = v; });
	}
	return out;
}

/** A layout's keys/dials with its active mode applied. */
export function applied(l: LayoutDef, modes: Record<string, string>): { keys: (KeyDef | null)[]; dials: (DialDef | null)[] } {
	const m = activeMode(l, modes);
	const md = m ? l.modes![m] : undefined;
	return { keys: positional<KeyDef>(KEY_MAX, l.keys, md?.keys), dials: positional<DialDef>(DIAL_MAX, l.dials, md?.dials) };
}

type Slots<T> = { items: (T | null)[]; owners: (LayoutDef | null)[] };

/**
 * Smart page: each level fills its zone in order of importance (array order).
 * An absent/empty neighbour's zone is handed over; spare slots take overflow (sub first, then app).
 */
export function composeSmart<T>(n: number, kind: "keys" | "dials", levels: Partial<Record<Level, LayoutDef>>, lists: Partial<Record<Level, (T | null)[]>>, zones: Record<"system" | "app" | "sub", Zone>): Slots<T> {
	const out: Slots<T> = { items: Array(n).fill(null), owners: Array(n).fill(null) };
	const queue = (lv: Level) => (lists[lv] ?? []).filter((x): x is T => !!x);
	const q = { sub: queue("sub"), app: queue("app"), system: queue("system") };
	const zone = (lv: "system" | "app" | "sub") => [...zones[lv][kind]].filter((i) => i < n);
	let subZ = zone("sub"), appZ = zone("app");
	const sysZ = zone("system");
	if (!q.sub.length) { appZ = [...appZ, ...subZ].sort((a, b) => a - b); subZ = []; }
	else if (!q.app.length) { subZ = [...subZ, ...appZ].sort((a, b) => a - b); appZ = []; }
	const spare: number[] = [];
	const place = (lv: "system" | "app" | "sub", slots: number[]) => {
		for (const i of slots) {
			const it = q[lv].shift();
			if (it === undefined) { spare.push(i); continue; }
			out.items[i] = it;
			out.owners[i] = levels[lv] ?? null;
		}
	};
	place("system", sysZ);
	place("sub", subZ);
	place("app", appZ);
	spare.sort((a, b) => a - b);
	for (const lv of ["sub", "app"] as const) {
		while (q[lv].length && spare.length) {
			const i = spare.shift()!;
			out.items[i] = q[lv].shift()!;
			out.owners[i] = levels[lv] ?? null;
		}
	}
	return out;
}

/** Lays a layout's items onto n slots: by slot number on the device they were written for, else in order around `reserved`. */
function fit<T>(n: number, own: (T | null)[], native: boolean, reserved: number[]): (T | null)[] {
	if (native) return positional<T>(n, own);
	const out: (T | null)[] = Array(n).fill(null);
	const items = own.filter((x): x is T => !!x);
	range(0, n).filter((i) => !reserved.includes(i)).forEach((i, k) => { if (items[k] !== undefined) out[i] = items[k]; });
	return out;
}

/** Full page of one layout with the system zone kept, so the AI key and volume never move. */
function fullPage<T>(n: number, ownRaw: (T | null)[], owner: LayoutDef, sys: (T | null)[], sysOwner: LayoutDef | undefined, sysZone: number[], keepSystem: boolean, native: boolean): Slots<T> {
	const sysItems = keepSystem && sysOwner ? sys.filter((x): x is T => !!x) : [];
	const z = sysZone.filter((i) => i < n);
	const own = fit(n, ownRaw, native, z.slice(0, sysItems.length));
	const out: Slots<T> = { items: [...own], owners: own.map((x) => (x ? owner : null)) };
	z.forEach((i, k) => {
		if (sysItems[k] !== undefined) { out.items[i] = sysItems[k]; out.owners[i] = sysOwner!; }
	});
	return out;
}

export interface ResolveOptions {
	forcedId?: string | null;                  // pin one layout at its level
	modes?: Record<string, string>;
	page?: number | string;                    // index or page id
	geometry?: Geometry;                       // the device being drawn (default: Stream Deck +)
}

export function resolve(cfg: Config, ctx: Context, opts: ResolveOptions = {}): Resolved {
	const g = opts.geometry ?? PLUS;
	const NK = g.keys, ND = g.dials, natK = isNative(g), natD = ND === DIAL_COUNT;
	const { layouts, zones } = normalize(cfg, g);
	const levels: Partial<Record<Level, LayoutDef>> = {};
	const forced = opts.forcedId ? layouts.find((l) => l.id === opts.forcedId) : undefined;
	levels.system = forced && levelOf(forced) === "system" ? forced : pick(layouts, ctx, "system");
	if (forced && levelOf(forced) !== "system") {
		levels[levelOf(forced)] = forced;
	} else {
		const takeover = pick(layouts, ctx, "takeover");
		if (takeover) levels.takeover = takeover;
		else {
			levels.app = pick(layouts, ctx, "app");
			levels.sub = pick(layouts, ctx, "sub");
		}
	}
	const modes = opts.modes ?? {};
	const a = (l?: LayoutDef) => (l ? applied(l, modes) : undefined);
	const sys = a(levels.system), app = a(levels.app), sub = a(levels.sub), tk = a(levels.takeover);
	const sysZ = zones.system;
	// Bigger decks show a layout's extra pages on the smart page too.
	const more = <T>(l: LayoutDef | undefined, base: (T | null)[] | undefined, kind: "keys" | "dials", cap: number): (T | null)[] | undefined =>
		!l || !base ? base : cap > (kind === "keys" ? KEY_COUNT : DIAL_COUNT) ? [...base, ...(l.pages ?? []).flatMap((p) => (p[kind] ?? []) as (T | null)[])] : base;

	const pages: { info: PageInfo; keys: Slots<KeyDef>; dials: Slots<DialDef> }[] = [];
	if (levels.takeover && tk) {
		const keep = levels.takeover.pinned !== false;
		pages.push({ info: { id: "smart", name: levels.takeover.name ?? levels.takeover.id, level: "smart" },
			keys: fullPage(NK, tk.keys, levels.takeover, sys?.keys ?? [], levels.system, sysZ.keys, keep, natK),
			dials: fullPage(ND, tk.dials, levels.takeover, sys?.dials ?? [], levels.system, sysZ.dials, keep, natD) });
	} else {
		pages.push({ info: { id: "smart", name: "Smart", level: "smart" },
			keys: composeSmart(NK, "keys", levels, { system: sys?.keys, app: more(levels.app, app?.keys, "keys", NK), sub: more(levels.sub, sub?.keys, "keys", NK) }, zones),
			dials: composeSmart(ND, "dials", levels, { system: sys?.dials, app: more(levels.app, app?.dials, "dials", ND), sub: more(levels.sub, sub?.dials, "dials", ND) }, zones) });
		for (const lv of ["sub", "app"] as const) {
			const l = levels[lv], ap = lv === "sub" ? sub : app;
			if (!l || !ap) continue;
			// A site/sub layout without dials borrows the app's (e.g. browser tabs/scroll/zoom).
			const ownDials = ap.dials.some(Boolean) || lv !== "sub" || !app || !levels.app;
			pages.push({ info: { id: lv, name: l.name ?? l.id, level: lv },
				keys: fullPage(NK, ap.keys, l, sys?.keys ?? [], levels.system, sysZ.keys, true, natK),
				dials: fullPage(ND, ownDials ? ap.dials : app!.dials, ownDials ? l : levels.app!, sys?.dials ?? [], levels.system, sysZ.dials, true, natD) });
			for (const p of l.pages ?? []) {
				pages.push({ info: { id: `${l.id}:${p.name}`, name: p.name, level: lv },
					keys: fullPage(NK, positional<KeyDef>(KEY_MAX, p.keys), l, sys?.keys ?? [], levels.system, sysZ.keys, true, natK),
					dials: fullPage(ND, positional<DialDef>(DIAL_MAX, p.dials), l, sys?.dials ?? [], levels.system, sysZ.dials, true, natD) });
			}
		}
	}
	if (levels.system && sys) {
		const own = (x: (KeyDef | DialDef | null)[]) => x.filter(Boolean).length;
		const sk = fit<KeyDef>(NK, sys.keys, natK, []), sd = fit<DialDef>(ND, sys.dials, natD, []);
		if (own(sys.keys) > sysZ.keys.filter((i) => i < NK).length || own(sys.dials) > sysZ.dials.filter((i) => i < ND).length) {
			pages.push({ info: { id: "system", name: levels.system.name ?? "System", level: "system" },
				keys: { items: sk, owners: sk.map((x) => (x ? levels.system! : null)) },
				dials: { items: sd, owners: sd.map((x) => (x ? levels.system! : null)) } });
		}
		for (const p of levels.system.pages ?? []) {
			const keys = fit<KeyDef>(NK, positional<KeyDef>(KEY_MAX, p.keys), natK, []), dials = fit<DialDef>(ND, positional<DialDef>(DIAL_MAX, p.dials), natD, []);
			pages.push({ info: { id: `${levels.system.id}:${p.name}`, name: p.name, level: "system" },
				keys: { items: keys, owners: keys.map((x) => (x ? levels.system! : null)) },
				dials: { items: dials, owners: dials.map((x) => (x ? levels.system! : null)) } });
		}
	}
	// Drop full pages identical to an earlier page (e.g. app page == smart page when there's no sub layout).
	const sig = (p: (typeof pages)[number]) => JSON.stringify([p.keys.items, p.dials.items]);
	const seen = new Set<string>();
	const unique = pages.filter((p) => { const s = sig(p); if (seen.has(s)) return false; seen.add(s); return true; });

	let page = typeof opts.page === "string" ? unique.findIndex((p) => p.info.id === opts.page) : opts.page ?? 0;
	if (page < 0 || page >= unique.length) page = 0;
	const cur = unique[page];
	const primary = levels.takeover ?? levels.sub ?? levels.app ?? levels.system ?? { id: "__empty", name: "No layout", keys: [], dials: [] };
	const allModes: Record<string, string | undefined> = {};
	for (const l of Object.values(levels)) if (l) allModes[l.id] = activeMode(l, modes);
	return {
		levels, layout: primary, mode: activeMode(primary, modes), modes: allModes,
		pages: unique.map((p) => p.info), page,
		keys: cur.keys.items, dials: cur.dials.items, keyOwners: cur.keys.owners, dialOwners: cur.dials.owners,
	};
}

/** Very small template engine: {{state.x}}, {{ctx.app}}, {{mode}}, {{layout}}, {{info.value}}, {{secret.X}} is handled elsewhere. */
export function template(s: string | undefined, scope: Record<string, unknown>): string {
	if (!s) return "";
	return s.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (whole, path: string) => {
		if (path.startsWith("secret.")) return whole; // never rendered on keys; substituted only inside actions
		// state keys are flat dotted names ("agent.status"), so try the whole remainder as one key first
		if (path.startsWith("state.")) {
			const st = scope.state as Record<string, unknown> | undefined;
			const flat = st?.[path.slice(6)];
			if (flat !== undefined && flat !== null) return String(flat);
		}
		let v: unknown = scope;
		for (const p of path.split(".")) v = v && typeof v === "object" ? (v as Record<string, unknown>)[p] : undefined;
		return v === undefined || v === null ? "" : String(v);
	});
}
