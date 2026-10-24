/**
 * Bridge to Elgato's own MCP server (@elgato/mcp-server, Stream Deck 7.4+, macOS/Windows).
 * Any action you put on the Stream Deck app's "MCP Actions" profile (Preferences → General → Enable MCP Deck)
 * becomes a tool here, so a ContextDeck key can trigger an official plugin's action:
 *
 *   { "type": "elgato", "tool": "obs__start_recording" }
 *
 * The server is started on first use with your Node (npx) and kept running.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export interface ElgatoSettings {
	enabled?: boolean;          // default true on macOS/Windows
	command?: string[];         // default: npx -y @elgato/mcp-server@latest
	shell?: boolean;            // run it through your login shell (default true, so PATH from your profile applies)
}

export interface ElgatoTool { name: string; description?: string; inputSchema?: unknown }

/** How to start the server on this OS. On macOS/Linux a login shell gives the plugin your PATH (Homebrew, nvm …). */
export function elgatoCommand(s: ElgatoSettings = {}, os: NodeJS.Platform = process.platform): { command: string; args: string[] } {
	const cmd = s.command?.length ? s.command : ["npx", "-y", "@elgato/mcp-server@latest"];
	if (s.shell === false) return { command: cmd[0], args: cmd.slice(1) };
	if (os === "win32") return { command: "cmd.exe", args: ["/d", "/s", "/c", ...cmd] };
	const q = (v: string) => `'${v.replace(/'/g, "'\\''")}'`;
	return { command: os === "darwin" ? "/bin/zsh" : process.env.SHELL || "/bin/sh", args: ["-lc", `exec ${cmd.map(q).join(" ")}`] };
}

export class ElgatoBridge {
	private client?: Client;
	private connecting?: Promise<Client>;
	private tools?: { at: number; list: ElgatoTool[] };
	constructor(private settings: () => ElgatoSettings, private log: (m: string) => void = () => undefined, private os: NodeJS.Platform = process.platform) {}

	get available(): boolean { return this.settings().enabled !== false && this.os !== "linux"; }

	private async connect(): Promise<Client> {
		if (!this.available) throw new Error(this.os === "linux" ? "Elgato's MCP server needs the Stream Deck app (macOS or Windows)" : "The Elgato bridge is turned off (settings.elgato.enabled)");
		if (this.client) return this.client;
		this.connecting ??= (async () => {
			const { command, args } = elgatoCommand(this.settings(), this.os);
			const transport = new StdioClientTransport({ command, args, stderr: "pipe" });
			transport.stderr?.on("data", (d) => this.log(`elgato-mcp: ${String(d).trim().slice(0, 300)}`));
			const c = new Client({ name: "contextdeck", version: "0.5.0" });
			transport.onclose = () => { this.client = undefined; this.tools = undefined; };
			try {
				await c.connect(transport);
			} catch (e) {
				throw new Error(`Couldn't start Elgato's MCP server (${(e as Error).message}). It needs Node.js (node -v) and Stream Deck 7.4+ with "Enable MCP Deck" on.`);
			}
			this.client = c;
			this.log("elgato-mcp: connected");
			return c;
		})().finally(() => { this.connecting = undefined; });
		return this.connecting;
	}

	/** Tools from the "MCP Actions" profile (cached 30 s). */
	async listTools(force = false): Promise<ElgatoTool[]> {
		if (!force && this.tools && Date.now() - this.tools.at < 30_000) return this.tools.list;
		const c = await this.connect();
		const { tools } = await c.listTools();
		const list = tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
		this.tools = { at: Date.now(), list };
		return list;
	}

	async call(tool: string, args: Record<string, unknown> = {}): Promise<string> {
		const c = await this.connect();
		const res = await c.callTool({ name: tool, arguments: args }, undefined, { timeout: 30_000 });
		const text = ((res.content as { type: string; text?: string }[] | undefined) ?? []).filter((x) => x.type === "text").map((x) => x.text).join("\n");
		if (res.isError) {
			const names = (await this.listTools().catch(() => [])).map((t) => t.name);
			throw new Error(`${text || "tool failed"}${names.length && !names.includes(tool) ? ` (available: ${names.slice(0, 8).join(", ")})` : ""}`);
		}
		return text;
	}

	async stop() { await this.client?.close().catch(() => undefined); this.client = undefined; }
}
