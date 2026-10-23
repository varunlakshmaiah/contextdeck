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

export const KEY_COUNT = 8;
export const DIAL_COUNT = 4;

export const DEFAULT_ZONES: Record<"system" | "app" | "sub", Zone> = {
	sub: { keys: [0, 1, 2, 3], dials: [0, 1] },
	app: { keys: [4, 5, 6], dials: [2] },
	system: { keys: [7], dials: [3] },
};

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
export function normalize(cfg: Config): { layouts: LayoutDef[]; zones: Record<"system" | "app" | "sub", Zone> } {
	const layouts = [...cfg.layouts];
	const zones = { ...DEFAULT_ZONES, ...cfg.settings?.zones } as Record<"system" | "app" | "sub", Zone>;
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
	return { keys: positional<KeyDef>(KEY_COUNT, l.keys, md?.keys), dials: positional<DialDef>(DIAL_COUNT, l.dials, md?.dials) };
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

/** Full page of one layout (positional) with the system zone kept, so the AI key and volume never move. */
function fullPage<T>(n: number, own: (T | null)[], owner: LayoutDef, sys: (T | null)[], sysOwner: LayoutDef | undefined, sysZone: number[], keepSystem: boolean): Slots<T> {
	const out: Slots<T> = { items: [...own], owners: own.map((x) => (x ? owner : null)) };
	if (keepSystem && sysOwner) {
		const sysItems = sys.filter((x): x is T => !!x);
		sysZone.filter((i) => i < n).forEach((i, k) => {
			if (sysItems[k] !== undefined) { out.items[i] = sysItems[k]; out.owners[i] = sysOwner; }
		});
	}
	return out;
}

export interface ResolveOptions {
	forcedId?: string | null;                  // pin one layout at its level
	modes?: Record<string, string>;
	page?: number | string;                    // index or page id
}

export function resolve(cfg: Config, ctx: Context, opts: ResolveOptions = {}): Resolved {
	const { layouts, zones } = normalize(cfg);
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

	const pages: { info: PageInfo; keys: Slots<KeyDef>; dials: Slots<DialDef> }[] = [];
	if (levels.takeover && tk) {
		const keep = levels.takeover.pinned !== false;
		pages.push({ info: { id: "smart", name: levels.takeover.name ?? levels.takeover.id, level: "smart" },
			keys: fullPage(KEY_COUNT, tk.keys, levels.takeover, sys?.keys ?? [], levels.system, sysZ.keys, keep),
			dials: fullPage(DIAL_COUNT, tk.dials, levels.takeover, sys?.dials ?? [], levels.system, sysZ.dials, keep) });
	} else {
		pages.push({ info: { id: "smart", name: "Smart", level: "smart" },
			keys: composeSmart(KEY_COUNT, "keys", levels, { system: sys?.keys, app: app?.keys, sub: sub?.keys }, zones),
			dials: composeSmart(DIAL_COUNT, "dials", levels, { system: sys?.dials, app: app?.dials, sub: sub?.dials }, zones) });
		for (const lv of ["sub", "app"] as const) {
			const l = levels[lv], ap = lv === "sub" ? sub : app;
			if (!l || !ap) continue;
			// A site/sub layout without dials borrows the app's (e.g. browser tabs/scroll/zoom).
			const ownDials = ap.dials.some(Boolean) || lv !== "sub" || !app || !levels.app;
			pages.push({ info: { id: lv, name: l.name ?? l.id, level: lv },
				keys: fullPage(KEY_COUNT, ap.keys, l, sys?.keys ?? [], levels.system, sysZ.keys, true),
				dials: fullPage(DIAL_COUNT, ownDials ? ap.dials : app!.dials, ownDials ? l : levels.app!, sys?.dials ?? [], levels.system, sysZ.dials, true) });
			for (const p of l.pages ?? []) {
				pages.push({ info: { id: `${l.id}:${p.name}`, name: p.name, level: lv },
					keys: fullPage(KEY_COUNT, positional<KeyDef>(KEY_COUNT, p.keys), l, sys?.keys ?? [], levels.system, sysZ.keys, true),
					dials: fullPage(DIAL_COUNT, positional<DialDef>(DIAL_COUNT, p.dials), l, sys?.dials ?? [], levels.system, sysZ.dials, true) });
			}
		}
	}
	if (levels.system && sys) {
		const own = (x: (KeyDef | DialDef | null)[]) => x.filter(Boolean).length;
		if (own(sys.keys) > sysZ.keys.length || own(sys.dials) > sysZ.dials.length) {
			pages.push({ info: { id: "system", name: levels.system.name ?? "System", level: "system" },
				keys: { items: sys.keys, owners: sys.keys.map((x) => (x ? levels.system! : null)) },
				dials: { items: sys.dials, owners: sys.dials.map((x) => (x ? levels.system! : null)) } });
		}
		for (const p of levels.system.pages ?? []) {
			const keys = positional<KeyDef>(KEY_COUNT, p.keys), dials = positional<DialDef>(DIAL_COUNT, p.dials);
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
