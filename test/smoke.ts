// End-to-end: engine + local API + bundled MCP bridge + deck CLI, against a temp home and a mock LLM.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFile } from "node:child_process";
import { copyFileSync, chmodSync, mkdtempSync, readdirSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

const home = mkdtempSync(join(process.env.SCRATCH!, "cd04-"));
process.env.CONTEXTDECK_HOME = home;
const { installDefaults, loadConfig, readToken, ensureHome } = await import("../src/config");
const { Engine } = await import("../src/engine");
const { startApi } = await import("../src/api");
const { memoryStore } = await import("../src/secrets");
installDefaults("com.var.contextdeck.sdPlugin/defaults", home);
ensureHome();
copyFileSync("com.var.contextdeck.sdPlugin/scripts/deck.sh", join(home, "deck")); chmodSync(join(home, "deck"), 0o755);

const mock = createServer((req, res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ choices: [{ message: { content: "OK" } }] })); }); }).listen(47334);
const e = new Engine();
e.deps.secrets = memoryStore();
const load = () => { const r = loadConfig(join(home, "config.json"), join(home, "layouts")); e.sources = r.sources; e.setConfig(r.config ? { ...r.config, settings: { ...r.config.settings, llm: "local", providers: { local: { type: "openai", baseUrl: "http://127.0.0.1:47334/v1", model: "m", noKey: true } } } } : undefined, r.errors); };
e.reloadConfig = load; load();
const api = startApi(e, 47996, readToken());
const deck = (...a: string[]) => new Promise<string>((r) => execFile(join(home, "deck"), a, { env: { ...process.env, CONTEXTDECK_PORT: "47996" } }, (_x, out) => r(out.trim())));

e.updateContext({ bundleId: "com.google.Chrome", app: "Chrome", url: "https://www.youtube.com/watch?v=1" });
const st = JSON.parse(await deck("status"));
console.log("levels:", JSON.stringify(st.levels), "| keys:", st.keys.join(", "));
console.log("page next:", await deck("page", "next"));
console.log("page app:", await deck("page", "app"));
console.log("state:", await deck("state", "agent.status=running", "render.progress=40"), JSON.stringify(e.state));
const sec = JSON.parse(await deck("secret", "list"));
console.log("secrets missing:", sec.missing.join(", "));
console.log("llm test:", await deck("llm", "test"));

const client = new Client({ name: "smoke", version: "1" });
await client.connect(new StdioClientTransport({ command: "node", args: ["com.var.contextdeck.sdPlugin/mcp/contextdeck-mcp.mjs"], env: { ...process.env, CONTEXTDECK_HOME: home, CONTEXTDECK_PORT: "47996" } as Record<string, string> }));
const call = async (name: string, args: Record<string, unknown> = {}) => ((await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean });
console.log("mcp tools:", (await client.listTools()).tools.map((t) => t.name).join(", "));
const up = await call("deck_upsert_layout", { layout: { id: "site.linear.app", level: "sub", name: "Linear", color: "#5E6AD2", match: { url: "*://linear.app/*" }, keys: [{ label: "New Issue", icon: "plus", action: { type: "keys", keys: "c" } }] } });
console.log("mcp upsert:", up.content[0].text.replace(/\s+/g, " "));
console.log("files:", readdirSync(join(home, "layouts", "sites")).join(", "));
e.updateContext({ bundleId: "com.google.Chrome", app: "Chrome", url: "https://linear.app/x" });
console.log("now:", JSON.stringify(e.snapshot().levels), e.snapshot().keys.slice(0, 5).join(", "));
console.log("mcp page:", JSON.parse((await call("deck_page", { page: "sub" })).content[0].text).id);
console.log("mcp secrets:", JSON.parse((await call("deck_secrets")).content[0].text).missing.length, "missing");
await client.close(); api.close(); mock.close();
process.exit(0);
