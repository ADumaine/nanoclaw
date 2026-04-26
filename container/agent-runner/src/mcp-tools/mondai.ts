/**
 * MonDAI tools — CryptoMondays community agent integrations.
 *
 * Tools are only registered when CM_API_BASE_URL is set in the environment.
 * Authentication is via CM_API_TOKEN (injected by OneCLI or set directly).
 *
 * Tools:
 *   search_members       — find community members by tags, chapter, company, name
 *   search_knowledge_base — semantic search over event summaries and curated content
 *   get_events           — upcoming events by chapter / date range
 *   get_chapters         — chapter list with name, country, calendar links
 */
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

const BASE_URL = process.env.CM_API_BASE_URL?.replace(/\/$/, '');
const API_TOKEN = process.env.CM_API_TOKEN;

if (!BASE_URL) {
  // Skip registration silently — not a MonDAI deployment.
  // No log output here to avoid noise in non-MonDAI setups.
} else {
  function authHeaders(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (API_TOKEN) h['Authorization'] = `Bearer ${API_TOKEN}`;
    return h;
  }

  function ok(text: string) {
    return { content: [{ type: 'text' as const, text }] };
  }

  function err(text: string) {
    return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
  }

  async function apiFetch(path: string, params?: Record<string, string | number | undefined>): Promise<unknown> {
    const url = new URL(`${BASE_URL}${path}`);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
      }
    }
    const res = await fetch(url.toString(), { headers: authHeaders() });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`${res.status} ${res.statusText}: ${body}`);
    }
    return res.json();
  }

  const tools: McpToolDefinition[] = [
    {
      tool: {
        name: 'search_members',
        description: 'Search CryptoMondays community members. Returns public profiles matching the given filters.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Partial name match' },
            company: { type: 'string', description: 'Company / organization name' },
            chapter: { type: 'string', description: 'Home chapter (e.g. "London", "Sydney")' },
            country: { type: 'string', description: 'Country of the member' },
            tags: { type: 'string', description: 'Comma-separated expertise/interest tags (e.g. "defi,nft")' },
            roles: { type: 'string', description: 'Comma-separated roles (e.g. "member,curator")' },
            limit: { type: 'number', description: 'Max results (default: 10)' },
          },
          additionalProperties: false,
        },
      },
      async handler(args) {
        try {
          const data = await apiFetch('/members/search', {
            name: args.name as string | undefined,
            company: args.company as string | undefined,
            chapter: args.chapter as string | undefined,
            country: args.country as string | undefined,
            tags: args.tags as string | undefined,
            roles: args.roles as string | undefined,
            limit: args.limit as number | undefined,
          });
          return ok(JSON.stringify(data, null, 2));
        } catch (e) {
          return err(e instanceof Error ? e.message : String(e));
        }
      },
    },

    {
      tool: {
        name: 'search_knowledge_base',
        description: 'Semantic search over CryptoMondays event summaries and curated knowledge base content.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query' },
          },
          required: ['query'],
          additionalProperties: false,
        },
      },
      async handler(args) {
        try {
          const data = await apiFetch('/kb/search', { q: args.query as string });
          return ok(typeof data === 'string' ? data : JSON.stringify(data, null, 2));
        } catch (e) {
          return err(e instanceof Error ? e.message : String(e));
        }
      },
    },

    {
      tool: {
        name: 'get_events',
        description: 'Retrieve upcoming CryptoMondays events from Luma. Optionally filter by chapter.',
        inputSchema: {
          type: 'object',
          properties: {
            chapter: { type: 'string', description: 'Chapter name to filter by (optional)' },
            limit: { type: 'number', description: 'Max results (default: 10)' },
          },
          additionalProperties: false,
        },
      },
      async handler(args) {
        try {
          const data = await apiFetch('/luma/calendar-events', {
            chapter: args.chapter as string | undefined,
            limit: args.limit as number | undefined,
          });
          return ok(JSON.stringify(data, null, 2));
        } catch (e) {
          return err(e instanceof Error ? e.message : String(e));
        }
      },
    },

    {
      tool: {
        name: 'get_chapters',
        description: 'Get all CryptoMondays chapters with name, country, and calendar links.',
        inputSchema: {
          type: 'object',
          properties: {},
          additionalProperties: false,
        },
      },
      async handler(_args) {
        try {
          const data = await apiFetch('/chapters');
          return ok(JSON.stringify(data, null, 2));
        } catch (e) {
          return err(e instanceof Error ? e.message : String(e));
        }
      },
    },
  ];

  registerTools(tools);
}
