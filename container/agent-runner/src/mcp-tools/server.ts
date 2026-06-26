/**
 * MCP server bootstrap + tool self-registration.
 *
 * Each tool module calls `registerTools([...])` at import time. The
 * barrel (`index.ts`) imports every tool module for side effects, then
 * calls `startMcpServer()` which uses whatever was registered.
 *
 * Default when only `core.ts` is imported: the core `send_message` /
 * `send_file` / `edit_message` / `add_reaction` tools are available.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import type { McpToolDefinition } from './types.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

const allTools: McpToolDefinition[] = [];
const toolMap = new Map<string, McpToolDefinition>();

// Hidden tools are not advertised via ListTools but are callable through the
// discover_tools / call_tool proxy. This keeps domain tools out of the agent's
// tool context while still making them reachable on demand.
const hiddenToolMap = new Map<string, McpToolDefinition>();

export function registerTools(tools: McpToolDefinition[]): void {
  for (const t of tools) {
    if (toolMap.has(t.tool.name)) {
      log(`Warning: tool "${t.tool.name}" already registered, skipping duplicate`);
      continue;
    }
    allTools.push(t);
    toolMap.set(t.tool.name, t);
  }
}

/** Register tools that are callable via the proxy but not listed in ListTools. */
export function registerHiddenTools(tools: McpToolDefinition[]): void {
  for (const t of tools) {
    if (hiddenToolMap.has(t.tool.name)) {
      log(`Warning: hidden tool "${t.tool.name}" already registered, skipping duplicate`);
      continue;
    }
    hiddenToolMap.set(t.tool.name, t);
  }
}

/** Get all hidden tool definitions (for discover_tools). */
export function getHiddenToolDefinitions(): McpToolDefinition[] {
  return Array.from(hiddenToolMap.values());
}

/** Call a hidden tool by name. Returns null if the tool is not found. */
export async function callHiddenTool(
  name: string,
  args: Record<string, unknown>,
): Promise<ReturnType<McpToolDefinition['handler']> | null> {
  const tool = hiddenToolMap.get(name);
  if (!tool) return null;
  return tool.handler(args);
}

export async function startMcpServer(): Promise<void> {
  const server = new Server({ name: 'nanoclaw', version: '2.0.0' }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: allTools.map((t) => t.tool),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const tool = toolMap.get(name);
    if (!tool) {
      return { content: [{ type: 'text', text: `Unknown tool: ${name}` }] };
    }
    return tool.handler(args ?? {});
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`MCP server started with ${allTools.length} tools: ${allTools.map((t) => t.tool.name).join(', ')}`);
}
