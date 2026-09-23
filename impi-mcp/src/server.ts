// src/server.ts — Servidor MCP por stdio. Delgado: solo expone TOOLS/TOOL_DEFS.
// ⚠️ En modo stdio stdout es el canal JSON-RPC: NUNCA console.log aquí.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { TOOLS, TOOL_DEFS } from "./tools.js";

const server = new Server(
  { name: "impi-mcp", version: "2.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const fn = TOOLS[req.params.name];
  if (!fn) throw new Error(`Tool not found: ${req.params.name}`);
  try {
    const out = await fn(req.params.arguments ?? {});
    return { content: [{ type: "text" as const, text: JSON.stringify(out, null, 2) }] };
  } catch (e: any) {
    return { content: [{ type: "text" as const, text: JSON.stringify({ error: e?.message ?? String(e) }) }], isError: true };
  }
});

await server.connect(new StdioServerTransport());
console.error("[impi-mcp] servidor MCP listo por stdio"); // stderr sí es seguro
