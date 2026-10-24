// Stands in for @elgato/mcp-server in tests: two "MCP Actions" tools.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
const s = new McpServer({ name: "fake-elgato", version: "1.0.0" });
s.registerTool("obs__start_recording", { description: "OBS: Start recording" }, async () => ({ content: [{ type: "text", text: "recording" }] }));
s.registerTool("hue__scene", { description: "Hue: set scene", inputSchema: { scene: z.string() } }, async ({ scene }) => ({ content: [{ type: "text", text: `scene ${scene}` }] }));
await s.connect(new StdioServerTransport());
