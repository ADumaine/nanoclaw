/**
 * MonDAI proxy tools — lightweight gateway to domain-specific tools.
 *
 * The full set of MonDAI tools (members, events, chapters, opportunities, etc.)
 * is registered as "hidden" — they are not listed in the agent's tool context
 * but are reachable through these two proxy tools, keeping the visible tool
 * count to ~8 instead of ~20+.
 *
 * Usage pattern:
 *   1. discover_tools("events")  → returns names + descriptions of event tools
 *   2. call_tool("get_events", { chapter: "Sydney" }) → dispatches and returns result
 *
 * Tools are only registered when CM_API_BASE_URL is set.
 */
import { registerTools, getHiddenToolDefinitions, callHiddenTool } from './server.js';
import type { McpToolDefinition } from './types.js';

const BASE_URL = process.env.CM_API_BASE_URL?.replace(/\/$/, '');

if (BASE_URL) {
  function ok(text: string) {
    return { content: [{ type: 'text' as const, text }] };
  }

  function err(text: string) {
    return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
  }

  const tools: McpToolDefinition[] = [
    {
      tool: {
        name: 'discover_tools',
        description:
          'Find available CryptoMondays community tools by topic. Returns tool names and descriptions matching the query. ' +
          'Use this before call_tool when you are unsure which tool to use. ' +
          'Example topics: "member", "event", "chapter", "video", "opportunity", "email".',
        inputSchema: {
          type: 'object',
          properties: {
            topic: {
              type: 'string',
              description: 'Topic or keyword to match against tool names and descriptions (case-insensitive).',
            },
          },
          required: ['topic'],
          additionalProperties: false,
        },
      },
      handler(args) {
        const topic = ((args.topic as string) || '').toLowerCase();
        const all = getHiddenToolDefinitions();
        const matches = topic
          ? all.filter(
              (t) =>
                t.tool.name.toLowerCase().includes(topic) ||
                (typeof t.tool.description === 'string' && t.tool.description.toLowerCase().includes(topic)),
            )
          : all;

        if (matches.length === 0) {
          return Promise.resolve(ok(`No tools found matching "${args.topic as string}". Try broader terms like "member", "event", "chapter", "video", or "opportunity".`));
        }

        const lines = matches.map((t) => `**${t.tool.name}** — ${t.tool.description ?? '(no description)'}`);
        return Promise.resolve(ok(`Found ${matches.length} tool${matches.length === 1 ? '' : 's'}:\n\n${lines.join('\n\n')}`));
      },
    },

    {
      tool: {
        name: 'call_tool',
        description:
          'Call a CryptoMondays community tool by name with the given parameters. ' +
          'Use discover_tools first if you are unsure which tool to call or what parameters it accepts. ' +
          'The params object must match the target tool\'s input schema exactly.',
        inputSchema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Exact name of the tool to call (from discover_tools output).',
            },
            params: {
              type: 'object',
              description: "Parameters to pass to the tool. Must match the target tool's input schema.",
              additionalProperties: true,
            },
          },
          required: ['name'],
          additionalProperties: false,
        },
      },
      async handler(args) {
        const name = args.name as string;
        const params = (args.params as Record<string, unknown>) ?? {};
        try {
          const result = await callHiddenTool(name, params);
          if (result === null) {
            // List available tool names to help the agent self-correct
            const available = getHiddenToolDefinitions().map((t) => t.tool.name).join(', ');
            return err(`Unknown tool "${name}". Available tools: ${available}`);
          }
          return result;
        } catch (e) {
          return err(e instanceof Error ? e.message : String(e));
        }
      },
    },
  ];

  registerTools(tools);
}
