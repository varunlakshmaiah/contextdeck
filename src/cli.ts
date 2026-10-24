/**
 * `deck` — ContextDeck's command line (macOS, Windows, Linux). Talks to the plugin's local API.
 * Installed by the plugin on every start as ~/.contextdeck/deck (deck.cmd on Windows), using the plugin's own Node.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HELP = `ContextDeck CLI

  deck status                          what the deck shows: levels, page, device, missing secrets
  deck devices                         connected decks (keys, dials, which one is active)
  deck page next|prev|smart|sub|app|system
  deck state agent.status=running      set state values (shown on keys / info keys)
  deck flag recording=true             set context flags (switch layouts)
  deck mode color                      switch mode of the current layout
  deck layout <id> | auto              pin a layout / back to automatic
  deck flash "Render done" [#22C55E] [key]
  deck press 3                         press key 3
  deck setup [--force|--update]        auto-configure the app/site in front
  deck menus [appId]                   the app's real menu items + shortcuts
  deck llm | llm use <id>|default | llm test [id]
  deck secret list                     secrets your layouts use, and which are missing
  deck secret set NAME                 store a secret in the OS credential store (hidden prompt)
  deck secret rm NAME
  deck elgato                          tools of your other Stream Deck plugins (via Elgato's MCP server)
  deck elgato <tool> [key=value …]     run one of them
  deck ui                              open the ContextDeck app (browser)
  deck reload`;

const HOME = process.env.CONTEXTDECK_HOME ?? join(homedir(), ".contextdeck");
const PORT = Number(process.env.CONTEXTDECK_PORT ?? 47811);

function token(): string {
	try { return readFileSync(join(HOME, "token"), "utf8").trim(); } catch { return ""; }
}

async function req(method: string, path: string, body?: unknown, timeoutS = 5): Promise<unknown> {
	try {
		const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
			method,
			headers: { authorization: `Bearer ${token()}`, "content-type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: AbortSignal.timeout(timeoutS * 1000),
		});
		const text = await res.text();
		try { return JSON.parse(text); } catch { return text; }
	} catch (e) {
		const msg = (e as Error).message;
		throw new Error(/ECONNREFUSED|fetch failed/.test(msg) ? "ContextDeck isn't running (is the Stream Deck app / OpenDeck open?)" : msg);
	}
}

/** k=v pairs → object; numbers, booleans and null are typed. */
export function pairs(args: string[]): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const kv of args) {
		const i = kv.indexOf("=");
		if (i < 1) continue;
		const k = kv.slice(0, i), v = kv.slice(i + 1);
		out[k] = /^(true|false|null|-?\d+(\.\d+)?)$/.test(v) ? JSON.parse(v) : v;
	}
	return out;
}

/** Reads a line without echoing it (for secrets). */
function hidden(prompt: string): Promise<string> {
	return new Promise((resolve) => {
		const stdin = process.stdin;
		process.stdout.write(prompt);
		if (!stdin.isTTY) {
			let buf = "";
			stdin.setEncoding("utf8");
			stdin.on("data", (d) => (buf += d));
			stdin.on("end", () => resolve(buf.replace(/\r?\n$/, "")));
			return;
		}
		stdin.setRawMode(true);
		stdin.setEncoding("utf8");
		let value = "";
		const onData = (ch: string) => {
			for (const c of ch) {
				if (c === "\r" || c === "\n") { stdin.setRawMode(false); stdin.pause(); stdin.off("data", onData); process.stdout.write("\n"); return resolve(value); }
				if (c === "\u0003") { process.stdout.write("\n"); process.exit(130); }
				if (c === "\u007f" || c === "\b") value = value.slice(0, -1);
				else value += c;
			}
		};
		stdin.on("data", onData);
		stdin.resume();
	});
}

const print = (v: unknown) => console.log(typeof v === "string" ? v : JSON.stringify(v, null, 2));

export async function main(argv: string[]): Promise<number> {
	const [cmd, a1, a2, a3] = argv;
	switch (cmd) {
		case "status": print(await req("GET", "/status")); break;
		case "devices": print(((await req("GET", "/status")) as { devices?: unknown }).devices); break;
		case "page": print(await req("POST", "/page", { page: a1 ?? "next" })); break;
		case "state": print(await req("POST", "/state", pairs(argv.slice(1)))); break;
		case "flag": case "flags": print(await req("POST", "/flags", pairs(argv.slice(1)))); break;
		case "mode": print(await req("POST", "/mode", { mode: a1 })); break;
		case "layout": print(await req("POST", "/layout", { id: a1 === "auto" || !a1 ? null : a1 })); break;
		case "flash": print(await req("POST", "/flash", { text: a1 ?? "", color: a2 ?? "#22C55E", key: a3 === undefined ? undefined : Number(a3), ms: 3000 })); break;
		case "press": print(await req("POST", "/press", { key: Number(a1 ?? 0) })); break;
		case "reload": print(await req("POST", "/reload")); break;
		case "setup": print(await req("POST", "/setup", { force: a1 === "--force", update: a1 === "--update" }, 300)); break;
		case "menus": print(await req("GET", `/menus${a1 ? `?bundleId=${encodeURIComponent(a1)}` : ""}`, undefined, 90)); break;
		case "llm":
			if (a1 === "use") print(await req("POST", "/llm/use", { provider: a2 === "default" ? null : a2 }));
			else if (a1 === "test") print(await req("POST", "/llm/test", { provider: a2 ?? "" }, 200));
			else print(await req("GET", "/llm"));
			break;
		case "secret": case "secrets":
			if (a1 === "set") {
				if (!a2) { console.error("Usage: deck secret set NAME"); return 1; }
				const value = await hidden(`Value for ${a2} (hidden): `);
				if (!value) { console.error("Nothing saved."); return 1; }
				const r = (await req("POST", "/secrets", { name: a2, value })) as { ok?: boolean; error?: string };
				if (!r.ok) { console.error(r.error ?? "Couldn't save"); return 1; }
				console.log(`Saved ${a2}.`);
			} else if (a1 === "rm" || a1 === "delete") {
				if (!a2) { console.error("Usage: deck secret rm NAME"); return 1; }
				print(await req("DELETE", `/secrets/${encodeURIComponent(a2)}`));
			} else print(await req("GET", "/secrets"));
			break;
		case "elgato":
			if (!a1) print(await req("GET", "/elgato/tools", undefined, 60));
			else print(await req("POST", "/elgato/run", { tool: a1, args: pairs(argv.slice(2)) }, 60));
			break;
		case "ui": print(await req("POST", "/ui/open")); break;
		default: console.log(HELP); return cmd && cmd !== "help" && cmd !== "--help" ? 1 : 0;
	}
	return 0;
}

const isMain = process.argv[1] && /deck(\.mjs)?$/.test(process.argv[1]);
if (isMain) main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error((e as Error).message); process.exit(1); });
