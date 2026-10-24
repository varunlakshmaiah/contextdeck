/**
 * ContextDeck MCP bridge — lets Claude (Desktop or Code) read and drive your Stream Deck+.
 * Talks to the plugin's local API (127.0.0.1:47811) using the token in ~/.contextdeck/token.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { stripJsonComments, validate } from "../src/config";

const HOME = process.env.CONTEXTDECK_HOME ?? join(homedir(), ".contextdeck");

function port(): number {
	if (process.env.CONTEXTDECK_PORT) return Number(process.env.CONTEXTDECK_PORT);
	try {
		return JSON.parse(stripJsonComments(readFileSync(join(HOME, "layouts.json"), "utf8"))).settings?.apiPort ?? 47811;
	} catch {
		return 47811;
	}
}

async function api(method: string, path: string, body?: unknown, timeoutMs = 15_000): Promise<unknown> {
	let token: string;
	try {
		token = readFileSync(join(HOME, "token"), "utf8").trim();
	} catch {
		throw new Error("ContextDeck token not found. Is the ContextDeck Stream Deck plugin installed and running?");
	}
	let res: Response;
	try {
		res = await fetch(`http://127.0.0.1:${port()}${path}`, {
			method,
			headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: AbortSignal.timeout(timeoutMs),
		});
	} catch (e) {
		throw new Error(`Can't reach the ContextDeck plugin (${(e as Error).message}). Is the Stream Deck app running?`);
	}
	const data = await res.json().catch(() => ({}));
	if (!res.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
	return data;
}

const text = (v: unknown) => ({ content: [{ type: "text" as const, text: typeof v === "string" ? v : JSON.stringify(v, null, 2) }] });
const wrap = <A>(fn: (a: A) => Promise<unknown>) => async (a: A) => {
	try { return text(await fn(a)); } catch (e) { return { ...text(`Error: ${(e as Error).message}`), isError: true }; }
};

const LAYOUT_DOC = `APP IDS: macOS bundle id (com.google.Chrome), Windows exe name lowercase (chrome.exe), Linux WM_CLASS/app id lowercase (google-chrome). One layout can list all three in match.bundleId.
NAMING: ids are system | app.<bundleId> (or app.<group>) | site.<host> | sub.<bundleId>.<name> | takeover.<name>; set "level" to system|app|sub|takeover. Files land in ~/.contextdeck/layouts/{system,apps,sites,takeovers}/<id>.json.
LEVELS: the deck shows system (AI key, volume) + app (the app in front, e.g. browser tab ops) + sub (the site/tab or window inside it). Sub layouts must NOT repeat app-level actions.
Layouts are written for the Stream Deck + (8 keys, 4 dials); other decks (Mini, MK.2, XL, Neo, Studio, + XL, Mobile) re-flow them automatically, and bigger decks also show the extra pages on page 1. Page 1 on the + mixes them (sub keys 0-3, app keys 4-6, system key 7; dials sub 0-1, app 2, system 3); each layout also gets its own full page; "pages": [{name, keys, dials}] adds more.
Layout JSON: { id, level, name?, color? (hex, also the top stripe of its keys), priority?, match?: { bundleId?, app?, url?, title?, sub? (globs, * wildcard, or "/regex/i"), time?: ["HH:MM","HH:MM"], days?, flags?, notFlags?, os?: "mac"|"win"|"linux" },
keys?: ordered MOST IMPORTANT FIRST (up to 8; null = blank), dials?: up to 4, pages?, modes?: { name: { keys?, dials? } }, defaultMode?, probe?: {type:"windowTitle"} | {type:"applescript",script} (native app sub-context → match.sub),
secrets?: { NAME: { description, url, hosts: ["api.example.com" | "secret:OTHER_URL_SECRET"] } } }.
Key: { label, sub?, icon? (lucide name), glyph?, color?, stateKey?, stateColors?, action?, release?, hold?, info?, requires?: ["SECRET_NAME"] }.
Info (read-only live value): { source: {type:"http",url,headers?} | {type:"state",key} | {type:"file",path} | {type:"applescript",script (get only)} | {type:"command",cmd:[allowlisted]} | {type:"uiText",match:"regex (group)"},
  extract?: "a.b[0].c" | "/regex (group)/", format?: "{{value|pct}}" (filters pct round k duration until ago money), progress?: {max}, thresholds?: [{above|below|equals, color}], every?: seconds }.
Dial: { label, icon?, color?, press?, touch?, info?, kind?: "actions" (cw/ccw) | "volume" (step) | "value" (key,min,max,step,unit,onChange) }.
Action: {type:"keys",keys:"cmd+shift+4"} (space-separated sequence ok) | {type:"type",text} | {type:"shell",cmd} | {type:"open",target} | {type:"applescript",script} |
{type:"http",url,method?,headers?,body?} (use {{secret.NAME}} placeholders, never real keys) | {type:"menu",path:["View","Zoom In"]} (use deck_read_menus) |
{type:"mode",mode} | {type:"page",page:"next"|"prev"|"sub"|"app"|"system"|<id>} | {type:"layout",id|null} | {type:"flag",flag,value?} | {type:"state",key,value} | {type:"copy",text} |
{type:"overlay",overlay:{title,items:[{label,value?}],onPick:"copy"|"paste"}} | {type:"llm",prompt,input?,output?:"clipboard"|"paste"|"notify"|"choices",provider?,model?} | {type:"sequence",steps,delayMs?} |
{type:"secretSet",name} | {type:"setup",force?,update?} | {type:"deckMenu"} | {type:"editLayout"} | {type:"reload"} | {type:"ui"} |
{type:"elgato",tool,args?} (an action from the Stream Deck app's "MCP Actions" profile; see deck_elgato_tools) | {type:"script",script,lang?:"applescript"|"jxa"|"powershell"|"sh"}.
CROSS-PLATFORM: chords use cmd/ctrl/alt/shift/win; "mod" = cmd on macOS, ctrl elsewhere; "cmd" on Windows/Linux becomes ctrl (settings.cmdKey). Any action may carry "on": {"win": {…action}, "linux": {…action}} replacements, and info specs "on": {"win": {source…}}.
Strings support {{state.x}}, {{ctx.app}}, {{ctx.url}}, {{mode}}, {{llm}}. State keys are dotted lowercase (agent.status); secrets UPPER_SNAKE (SERVICE_API_KEY, SERVICE_TOKEN, SERVICE_URL).`;

const server = new McpServer({ name: "contextdeck", version: "0.5.0" });

server.registerTool("deck_status", {
	description: "What the Stream Deck+ is showing right now: active layout and mode, the frontmost app/URL it detected, flags, state values, and key labels.",
}, wrap(async () => api("GET", "/status")));

server.registerTool("deck_ask", {
	description: "Ask the user a question answered by pressing a key. Shows up to 7 options on the keys (key 8 = dismiss) and WAITS for the press. Use for quick decisions while they're working. Returns the picked option or null.",
	inputSchema: {
		title: z.string().describe("Short question, also shown in status"),
		options: z.array(z.string()).min(1).max(7).describe("Options, ideally under 14 characters each"),
		timeoutSeconds: z.number().min(5).max(600).default(120),
	},
}, wrap(async ({ title, options, timeoutSeconds }) => {
	const r = (await api("POST", "/overlay", { title, items: options.map((label) => ({ label })), wait: true, waitMs: timeoutSeconds * 1000 }, (timeoutSeconds + 10) * 1000)) as { picked: string | null };
	return r.picked === null ? "No choice (dismissed or timed out)." : `User picked: ${r.picked}`;
}));

server.registerTool("deck_show_choices", {
	description: "Put up to 7 text options (titles, replies, tags, snippets...) on the keys. When the user presses one, its full value is copied or pasted. Doesn't wait.",
	inputSchema: {
		title: z.string().optional(),
		items: z.array(z.object({ label: z.string().describe("Short key label"), value: z.string().optional().describe("Full text to copy/paste; defaults to label") })).min(1).max(7),
		onPick: z.enum(["copy", "paste"]).default("copy"),
	},
}, wrap(async ({ title, items, onPick }) => api("POST", "/overlay", { title, items, onPick })));

server.registerTool("deck_notify", {
	description: "Flash a key with a color and short text, e.g. when a long task finishes.",
	inputSchema: { text: z.string().max(20), color: z.string().default("#22C55E"), key: z.number().int().min(0).max(7).default(7), seconds: z.number().min(0.5).max(30).default(3) },
}, wrap(async ({ text, color, key, seconds }) => api("POST", "/flash", { text, color, key, ms: seconds * 1000 })));

server.registerTool("deck_set_state", {
	description: "Set state values that keys display: labels using {{state.name}}, or status lights with stateKey (e.g. {\"agent\":\"running\"}).",
	inputSchema: { values: z.record(z.string(), z.any()) },
}, wrap(async ({ values }) => api("POST", "/state", values)));

server.registerTool("deck_set_flags", {
	description: "Set context flags (true/false) that layouts can match on, e.g. {\"recording\":true} or {\"meeting\":false}.",
	inputSchema: { flags: z.record(z.string(), z.boolean()) },
}, wrap(async ({ flags }) => api("POST", "/flags", flags)));

server.registerTool("deck_switch", {
	description: "Switch the current layout's mode (e.g. Resolve 'edit' -> 'color'), or force a layout by id (null = return to automatic).",
	inputSchema: { mode: z.string().optional(), layout: z.string().nullable().optional() },
}, wrap(async ({ mode, layout }) => {
	if (layout !== undefined) await api("POST", "/layout", { id: layout });
	if (mode) await api("POST", "/mode", { mode });
	return api("GET", "/status");
}));

server.registerTool("deck_get_config", {
	description: "Read the full ContextDeck config (all layouts, pinned keys, settings).",
}, wrap(async () => api("GET", "/config")));

server.registerTool("deck_upsert_layout", {
	description: `Create or replace one layout. It's validated and hot-reloads immediately. Read deck_get_config first when editing. ${LAYOUT_DOC}`,
	inputSchema: { layout: z.record(z.string(), z.any()).describe("Layout object; must include id") },
}, wrap(async ({ layout }) => {
	const errors = validate({ layouts: [layout] });
	if (errors.length) throw new Error(errors.join("; "));
	return api("PUT", `/layouts/${encodeURIComponent(String(layout.id))}`, layout);
}));

server.registerTool("deck_read_menus", {
	description: "List the menu bar items and their real keyboard shortcuts for a running app (default: the app in front; macOS menus, Windows classic menu bars; not Linux). Use the results to build accurate layouts: chord -> {type:'keys'}, no chord -> {type:'menu', path}.",
	inputSchema: { bundleId: z.string().optional().describe("e.g. com.figma.Desktop; omit for the frontmost app"), all: z.boolean().default(false).describe("include boilerplate items like Copy/Paste/Quit") },
}, wrap(async ({ bundleId, all }) => {
	const q = new URLSearchParams();
	if (bundleId) q.set("bundleId", bundleId);
	if (all) q.set("all", "1");
	return api("GET", `/menus?${q}`, undefined, 95_000);
}));

server.registerTool("deck_setup_app", {
	description: "Auto-configure the app or website currently in front: reads its menus, researches current docs (if research is enabled), picks the most useful keys/dials/info keys, saves the layout file and switches the deck to it. force=true rebuilds a generated layout; update=true refreshes it for a new app version.",
	inputSchema: { force: z.boolean().default(false), update: z.boolean().default(false) },
}, wrap(async ({ force, update }) => api("POST", "/setup", { force, update }, 300_000)));

server.registerTool("deck_llm", {
	description: "See which LLM providers the deck's AI keys can use (Claude, OpenAI, OpenRouter, Ollama, …), switch the one in use, or test a provider's connection.",
	inputSchema: { action: z.enum(["list", "use", "test"]).default("list"), provider: z.string().nullable().optional().describe("provider id; for use, null = back to settings default") },
}, wrap(async ({ action, provider }) => {
	if (action === "use") return api("POST", "/llm/use", { provider: provider ?? null });
	if (action === "test") return api("POST", "/llm/test", { provider: provider ?? "" }, 200_000);
	return api("GET", "/llm");
}));

server.registerTool("deck_page", {
	description: "Change the deck page: next, prev, smart (mixed page 1), sub (site/window layout in full), app (app layout in full), system, or a page id like app.browsers:Tabs.",
	inputSchema: { page: z.string().default("next") },
}, wrap(async ({ page }) => api("POST", "/page", { page })));

server.registerTool("deck_secrets", {
	description: "List the secrets (API keys/tokens) the layouts use: names, allowed hosts, which layouts use them, and whether each is stored. Never returns values. The user stores one with: ~/.contextdeck/deck secret set NAME, the ContextDeck app (Keys & secrets) (or by pressing the key that says 'needs NAME').",
}, wrap(async () => api("GET", "/secrets")));

server.registerTool("deck_elgato_tools", {
	description: "List actions from the user's other Stream Deck plugins (OBS, Hue, Spotify …) that they put on the Stream Deck app's \"MCP Actions\" profile. Bind one to a key with {type:\"elgato\", tool}. macOS/Windows, Stream Deck 7.4+.",
}, wrap(async () => api("GET", "/elgato/tools", undefined, 60_000)));

server.registerTool("deck_elgato_run", {
	description: "Trigger one of those Stream Deck plugin actions now.",
	inputSchema: { tool: z.string(), args: z.record(z.string(), z.any()).optional() },
}, wrap(async ({ tool, args }) => api("POST", "/elgato/run", { tool, args }, 60_000)));

server.registerTool("deck_devices", {
	description: "The Stream Decks connected (model, keys, dials, which one was used last).",
}, wrap(async () => api("GET", "/devices")));

server.registerTool("deck_delete_layout", {
	description: "Delete a layout by id.",
	inputSchema: { id: z.string() },
}, wrap(async ({ id }) => api("DELETE", `/layouts/${encodeURIComponent(id)}`)));

await server.connect(new StdioServerTransport());
