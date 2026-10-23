import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { deleteLayout, writeLayout } from "./config";
import { askLLM, configuredProviders, providerName, resolveProvider } from "./llm";
import { scanMenus, usefulEntries } from "./menus";
import type { Engine } from "./engine";
import type { LayoutDef, OverlaySpec } from "./types";

/**
 * Local control API — 127.0.0.1 only, bearer token from ~/.contextdeck/token.
 *
 *   GET  /status                       current layout, mode, context, state, key labels
 *   GET  /config                       the full layouts.json
 *   PUT  /layouts/:id                  create/replace one layout (validated, hot-reloads)
 *   DELETE /layouts/:id
 *   POST /flags      {"meeting":true}  set context flags (drive layouts from anything)
 *   POST /state      {"agent":"running"}  set state values shown on keys
 *   POST /mode       {"mode":"color"}
 *   POST /layout     {"id":"resolve"} | {"id":null}
 *   POST /overlay    OverlaySpec (+ "wait": true to block until a key is pressed)
 *   DELETE /overlay
 *   POST /flash      {"key":7,"color":"#22C55E","text":"Done","ms":2000}
 *   POST /press      {"key":3}         simulate a key press
 *   POST /setup      {"force":false,"update":false}  auto-configure the app/site in front (waits; returns the result)
 *   POST /page       {"page":"next"|"prev"|"smart"|"sub"|"app"|"system"|<id>}
 *   POST /reload
 *   GET  /secrets                      declared secrets (names, hosts, where used) and which are missing — never values
 *   POST /secrets/refresh              re-read the Keychain after `deck secret set`
 *   GET  /menus[?bundleId=..&all=1]    the front app's menu items with real shortcuts
 *   GET  /llm                          providers, which one is in use
 *   POST /llm/use    {"provider":"openrouter"} | {"provider":null}
 *   POST /llm/test   {"provider":"ollama"}     round-trip test (latency + reply)
 */
export function startApi(engine: Engine, port: number, token: string) {
	const server = createServer(async (req, res) => {
		try {
			if (req.headers.authorization !== `Bearer ${token}`) return send(res, 401, { error: "unauthorized" });
			const url = new URL(req.url ?? "/", "http://localhost");
			const body = req.method === "GET" || req.method === "DELETE" ? {} : await readJson(req);
			const route = `${req.method} ${url.pathname}`;
			const layoutMatch = /^\/layouts\/([\w.-]+)$/.exec(url.pathname);

			if (route === "GET /status") return send(res, 200, engine.snapshot());
			if (route === "GET /config") return send(res, 200, engine.config);
			if (layoutMatch && req.method === "PUT") {
				const layout = { ...(body as unknown as LayoutDef), id: layoutMatch[1] };
				const existed = engine.config.layouts.some((l) => l.id === layout.id);
				const file = writeLayout(layout);
				engine.sources[layout.id] = file;
				engine.setConfig({ ...engine.config, layouts: [...engine.config.layouts.filter((l) => l.id !== layout.id), layout] }, []);
				return send(res, 200, { ok: true, created: !existed, file });
			}
			if (layoutMatch && req.method === "DELETE") {
				const removed = deleteLayout(layoutMatch[1]);
				engine.setConfig({ ...engine.config, layouts: engine.config.layouts.filter((l) => l.id !== layoutMatch[1]) }, []);
				return send(res, 200, { ok: true, removed });
			}
			if (route === "POST /setup") {
				const b = body as { force?: boolean; update?: boolean };
				return send(res, 200, await engine.runSetup({ force: !!b.force, update: !!b.update, index: engine.settings.setupSlot ?? 6 }));
			}
			if (route === "POST /page") { engine.goPage((body as { page?: string | number }).page ?? "next"); return send(res, 200, engine.snapshot().page); }
			if (route === "POST /reload") { engine.reloadConfig(); return send(res, 200, { ok: true, errors: engine.configErrors }); }
			if (route === "POST /secrets/refresh") { engine.deps.secrets.forget?.(); await engine.refreshMissingSecrets(); return send(res, 200, { missing: engine.snapshot().missingSecrets }); }
			if (route === "GET /secrets") {
				const out: Record<string, { description?: string; url?: string; hosts?: string[]; usedBy: string[]; stored: boolean }> = {};
				const add = (name: string, by: string, d?: { description?: string; url?: string; hosts?: string[] }) => {
					out[name] ??= { usedBy: [], stored: false };
					if (d) Object.assign(out[name], { description: d.description, url: d.url, hosts: d.hosts });
					if (!out[name].usedBy.includes(by)) out[name].usedBy.push(by);
				};
				for (const [n, d] of Object.entries(engine.settings.secrets ?? {})) add(n, "config", d);
				for (const l of engine.config.layouts) {
					for (const [n, d] of Object.entries(l.secrets ?? {})) add(n, l.id, d);
					const all = [...(l.keys ?? []), ...(l.dials ?? []), ...(l.pages ?? []).flatMap((p) => p.keys ?? [])];
					for (const k of all) for (const n of k?.requires ?? []) add(n, l.id);
				}
				for (const n of Object.keys(out)) out[n].stored = !!(await engine.deps.secrets.get(n).catch(() => undefined));
				return send(res, 200, { secrets: out, missing: Object.entries(out).filter(([, v]) => !v.stored).map(([k]) => k) });
			}
			if (route === "GET /llm") {
				return send(res, 200, {
					inUse: engine.llm, default: engine.settings.llm ?? "anthropic", override: engine.llmOverride, setup: engine.settings.setupLlm ?? engine.llm, fallback: engine.settings.fallbackLlm ?? null,
					providers: configuredProviders(engine.settings).map((id) => {
						const p = resolveProvider(engine.settings, id)!;
						return { id, name: providerName(engine.settings, id), type: p.def.type, baseUrl: p.def.baseUrl, model: p.def.model ?? null, local: !!p.def.noKey };
					}),
				});
			}
			if (route === "POST /llm/use") {
				const id = (body as { provider?: string | null }).provider ?? null;
				if (id && !resolveProvider(engine.settings, id)) return send(res, 400, { error: `unknown provider "${id}"` });
				engine.selectLlm(id);
				return send(res, 200, { inUse: engine.llm });
			}
			if (route === "POST /llm/test") {
				const asked = (body as { provider?: string }).provider;
				// No provider named: test every role the deck uses (AI keys, ✨ Set up, fallback), each once.
				const roles: [string, string][] = asked
					? [[asked, "requested"]]
					: ([[engine.llm, "AI keys (llm)"], [engine.settings.setupLlm ?? engine.llm, "✨ Set up (setupLlm)"], [engine.settings.fallbackLlm ?? "", "fallback (fallbackLlm)"]] as [string, string][]).filter(([id]) => id);
				const byId = new Map<string, string[]>();
				for (const [id, role] of roles) byId.set(id, [...(byId.get(id) ?? []), role]);
				const results = [];
				for (const [id, usedFor] of byId) {
					const t0 = Date.now();
					try {
						const r = await askLLM(engine.settings, { provider: id, prompt: "Reply with exactly: OK", system: "You are a connectivity test. Reply with exactly: OK", maxTokens: 20 });
						results.push({ ok: true, provider: id, usedFor, model: r.model, ms: Date.now() - t0, reply: r.text.slice(0, 80) });
					} catch (e) {
						results.push({ ok: false, provider: id, usedFor, ms: Date.now() - t0, error: (e as Error).message });
					}
				}
				return send(res, 200, asked ? results[0] : { ok: results.every((r) => r.ok), results });
			}
			if (route === "GET /menus") {
				const bundleId = url.searchParams.get("bundleId") || engine.ctx.bundleId;
				if (!bundleId) return send(res, 400, { error: "no app in front" });
				const all = await scanMenus(bundleId);
				const entries = url.searchParams.get("all") ? all : usefulEntries(all, engine.ctx.app);
				return send(res, 200, { bundleId, count: entries.length, withShortcuts: entries.filter((e) => e.chord).length, entries: entries.map((e) => ({ path: e.path.join(" > "), chord: e.chord ?? null })) });
			}
			if (route === "POST /flags") {
				for (const [k, v] of Object.entries(body)) engine.setFlag(k, Boolean(v));
				return send(res, 200, engine.snapshot().context.flags);
			}
			if (route === "POST /state") {
				for (const [k, v] of Object.entries(body)) engine.setState(k, v);
				return send(res, 200, { ok: true });
			}
			if (route === "POST /mode") { engine.setMode(String((body as { mode: string }).mode)); return send(res, 200, engine.snapshot()); }
			if (route === "POST /layout") { engine.forceLayout((body as { id: string | null }).id ?? null); return send(res, 200, engine.snapshot()); }
			if (route === "POST /overlay") {
				const spec = body as OverlaySpec & { wait?: boolean; waitMs?: number };
				const wantsReturn = spec.wait ? { onPick: spec.onPick ?? "return" } : {};
				const id = engine.showOverlay({ ...spec, ...wantsReturn } as OverlaySpec);
				if (!spec.wait) return send(res, 200, { id });
				const result = await engine.waitForPick(id, Math.min(spec.waitMs ?? 120_000, 600_000));
				if (engine.overlay?.id === id) engine.closeOverlay(null);
				return send(res, 200, { id, ...result });
			}
			if (route === "DELETE /overlay") { engine.closeOverlay(null); return send(res, 200, { ok: true }); }
			if (route === "POST /flash") {
				const b = body as { key?: number; color?: string; text?: string; ms?: number };
				engine.flash(b.key ?? 7, b.color, b.text, b.ms);
				return send(res, 200, { ok: true });
			}
			if (route === "POST /press") {
				const k = Number((body as { key: number }).key);
				engine.keyDown(k);
				setTimeout(() => engine.keyUp(k), 60);
				return send(res, 200, { ok: true });
			}
			return send(res, 404, { error: `no route ${route}` });
		} catch (e) {
			return send(res, 400, { error: (e as Error).message });
		}
	});
	server.on("error", (e) => engine.log(`API error: ${e.message}`));
	server.listen(port, "127.0.0.1", () => engine.log(`API on http://127.0.0.1:${port}`));
	return server;
}

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
	return new Promise((resolve, reject) => {
		let data = "";
		req.on("data", (c) => { data += c; if (data.length > 2_000_000) reject(new Error("body too large")); });
		req.on("end", () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error("invalid JSON body")); } });
		req.on("error", reject);
	});
}

function send(res: ServerResponse, status: number, body: unknown) {
	res.writeHead(status, { "content-type": "application/json" });
	res.end(JSON.stringify(body));
}
