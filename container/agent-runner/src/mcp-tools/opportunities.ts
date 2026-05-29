/**
 * Opportunities MCP tools — Earn opportunity CRUD and search for MonDAI.
 *
 * Requires CM_API_BASE_URL and CM_API_TOKEN environment variables.
 * Role enforcement is handled server-side via getRequesterAuthId(req):
 *   - NanoClaw authenticates as system_agent via CM_API_TOKEN
 *   - X-On-Behalf-Of header carries the end user's auth_id so the API
 *     server can resolve their profile and enforce ownership/role rules
 *
 * Tools:
 *   search_opportunities      — natural language search via /agent/opportunities/search
 *   list_opportunities        — full list via GET /opportunities
 *   create_opportunity        — submit new opportunity via POST /opportunities
 *   update_opportunity        — partial update via PATCH /opportunities/{id}
 *   delete_opportunity        — delete via DELETE /opportunities/{id}
 *   list_opportunity_types    — get type list (for type_id lookups)
 *   create_opportunity_type   — admin: add a new type
 *   update_opportunity_type   — admin: rename/reorder a type
 *   delete_opportunity_type   — admin: remove a type
 */
import { registerHiddenTools } from './server.js';
import type { McpToolDefinition } from './types.js';

const BASE_URL = process.env.CM_API_BASE_URL?.replace(/\/$/, '');
// CM_AGENT_TOKEN is the NanoClaw shared secret — API server assigns system_agent role.
// Falls back to CM_API_TOKEN for deployments that haven't set CM_AGENT_TOKEN yet.
const API_TOKEN = process.env.CM_AGENT_TOKEN ?? process.env.CM_API_TOKEN;

const ANON_BLOCK = { content: [{ type: 'text' as const, text: 'You need a MonDAI account to use this feature. Register at mondai.io to get started.' }], isError: true };
const PENDING_BLOCK = { content: [{ type: 'text' as const, text: 'Your MonDAI membership is still pending. Complete your profile setup to unlock this feature.' }], isError: true };

function membershipBlock(userStatus: unknown) {
  if (userStatus === 'anonymous') return ANON_BLOCK;
  if (userStatus === 'pending') return PENDING_BLOCK;
  return null;
}

if (BASE_URL) {
  function authHeaders(authId?: string): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (API_TOKEN) h['Authorization'] = `Bearer ${API_TOKEN}`;
    if (process.env.CM_API_TOKEN) h['X-Api-Token'] = process.env.CM_API_TOKEN;
    if (authId) h['X-On-Behalf-Of'] = authId;
    return h;
  }

  function ok(text: string) {
    return { content: [{ type: 'text' as const, text }] };
  }

  function err(text: string) {
    return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
  }

  async function apiGet(path: string, authId?: string, params?: Record<string, string | number | undefined>): Promise<unknown> {
    const url = new URL(`${BASE_URL}${path}`);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
      }
    }
    const res = await fetch(url.toString(), { headers: authHeaders(authId) });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`${res.status} ${res.statusText}: ${body}`);
    }
    return res.json();
  }

  async function apiPost(path: string, body: Record<string, unknown>, authId?: string): Promise<unknown> {
    const res = await fetch(`${BASE_URL}${path}`, {
      method: 'POST',
      headers: authHeaders(authId),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`${res.status} ${res.statusText}: ${text}`);
    }
    return res.json();
  }

  async function apiPatch(path: string, body: Record<string, unknown>, authId?: string): Promise<unknown> {
    const res = await fetch(`${BASE_URL}${path}`, {
      method: 'PATCH',
      headers: authHeaders(authId),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`${res.status} ${res.statusText}: ${text}`);
    }
    return res.json();
  }

  async function apiDelete(path: string, authId?: string): Promise<unknown> {
    const res = await fetch(`${BASE_URL}${path}`, {
      method: 'DELETE',
      headers: authHeaders(authId),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`${res.status} ${res.statusText}: ${text}`);
    }
    return res.json();
  }

  const AUTH_ID_PARAM = {
    auth_id: { type: 'string', description: "Sender's auth_id from user_context. Always pass this for user-initiated requests so the API enforces the correct role." },
    user_status: { type: 'string', description: "Sender's status from user_context ('active', 'pending', or 'anonymous'). Always pass for write operations — tool blocks non-active users immediately." },
  };

  const tools: McpToolDefinition[] = [
    {
      tool: {
        name: 'search_opportunities',
        description: 'Search Earn opportunities using natural language. Use this to find relevant opportunities matching a user\'s interests, skills, or query.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Natural language search query' },
            ...AUTH_ID_PARAM,
          },
          required: ['query'],
          additionalProperties: false,
        },
      },
      async handler(args) {
        try {
          const { auth_id, ...rest } = args as Record<string, unknown>;
          const data = await apiPost('/agent/opportunities/search', { query: rest.query as string }, auth_id as string | undefined);
          return ok(JSON.stringify(data, null, 2));
        } catch (e) {
          return err(e instanceof Error ? e.message : String(e));
        }
      },
    },

    {
      tool: {
        name: 'list_opportunities',
        description: 'List all Earn opportunities. Returns the current full list.',
        inputSchema: {
          type: 'object',
          properties: { ...AUTH_ID_PARAM },
          additionalProperties: false,
        },
      },
      async handler(args) {
        try {
          const { auth_id } = args as Record<string, unknown>;
          const data = await apiGet('/opportunities', auth_id as string | undefined);
          return ok(JSON.stringify(data, null, 2));
        } catch (e) {
          return err(e instanceof Error ? e.message : String(e));
        }
      },
    },

    {
      tool: {
        name: 'create_opportunity',
        description: 'Submit a new Earn opportunity. Check user_context.status BEFORE asking for details — pass user_status here and the tool will block ineligible users immediately. Requires title and description. Call list_opportunity_types first to get a type_id. If location_type is "onsite" or "hybrid", location is required.',
        inputSchema: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Opportunity title' },
            description: { type: 'string', description: 'Full description of the opportunity' },
            company: { type: 'string', description: 'Company or organisation posting the opportunity' },
            type_id: { type: 'string', description: 'Opportunity type ID string (from list_opportunity_types)' },
            location: { type: 'string', description: 'Physical address or city. Required if location_type is "onsite" or "hybrid"' },
            location_type: { type: 'string', enum: ['remote', 'onsite', 'hybrid', 'none'], description: 'Work setting' },
            url: { type: 'string', description: 'Link to the full opportunity listing' },
            compensation: { type: 'string', description: 'Compensation details (e.g. "$80k–$100k", "0.5% equity")' },
            deadline: { type: 'string', description: 'Application deadline (ISO 8601 date-time)' },
            status: { type: 'string', enum: ['pending', 'approved', 'rejected'], description: 'Approval status (default: pending)' },
            ...AUTH_ID_PARAM,
          },
          required: ['title', 'description'],
          additionalProperties: false,
        },
      },
      async handler(args) {
        const { auth_id, user_status, ...fields } = args as Record<string, unknown>;
        const block = membershipBlock(user_status);
        if (block) return block;
        try {
          const data = await apiPost('/opportunities', fields, auth_id as string | undefined);
          return ok(JSON.stringify(data, null, 2));
        } catch (e) {
          return err(e instanceof Error ? e.message : String(e));
        }
      },
    },

    {
      tool: {
        name: 'update_opportunity',
        description: 'Update an existing Earn opportunity. Only provide the fields to change. Admin role required for status changes; owners may update their own submissions.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Opportunity ID to update' },
            title: { type: 'string' },
            description: { type: 'string' },
            company: { type: 'string' },
            type_id: { type: 'string', description: 'Opportunity type ID string' },
            location: { type: 'string', description: 'Physical address or city' },
            location_type: { type: 'string', enum: ['remote', 'onsite', 'hybrid', 'none'] },
            url: { type: 'string' },
            compensation: { type: 'string' },
            deadline: { type: 'string', description: 'ISO 8601 date-time' },
            status: { type: 'string', enum: ['pending', 'approved', 'rejected'], description: 'Admin only' },
            ...AUTH_ID_PARAM,
          },
          required: ['id'],
          additionalProperties: false,
        },
      },
      async handler(args) {
        const { id, auth_id, user_status, ...fields } = args as Record<string, unknown>;
        const block = membershipBlock(user_status);
        if (block) return block;
        try {
          const data = await apiPatch(`/opportunities/${id as string}`, fields, auth_id as string | undefined);
          return ok(JSON.stringify(data, null, 2));
        } catch (e) {
          return err(e instanceof Error ? e.message : String(e));
        }
      },
    },

    {
      tool: {
        name: 'delete_opportunity',
        description: 'Delete an Earn opportunity by ID. Admin role required.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Opportunity ID to delete' },
            ...AUTH_ID_PARAM,
          },
          required: ['id'],
          additionalProperties: false,
        },
      },
      async handler(args) {
        const { id, auth_id, user_status } = args as Record<string, unknown>;
        const block = membershipBlock(user_status);
        if (block) return block;
        try {
          const data = await apiDelete(`/opportunities/${id as string}`, auth_id as string | undefined);
          return ok(JSON.stringify(data, null, 2));
        } catch (e) {
          return err(e instanceof Error ? e.message : String(e));
        }
      },
    },

    {
      tool: {
        name: 'list_opportunity_types',
        description: 'Get all Earn opportunity types (e.g. Job, Grant, Bounty). Use this to resolve type_id values before creating or updating opportunities.',
        inputSchema: {
          type: 'object',
          properties: { ...AUTH_ID_PARAM },
          additionalProperties: false,
        },
      },
      async handler(args) {
        try {
          const { auth_id } = args as Record<string, unknown>;
          const data = await apiGet('/opportunities/types', auth_id as string | undefined);
          return ok(JSON.stringify(data, null, 2));
        } catch (e) {
          return err(e instanceof Error ? e.message : String(e));
        }
      },
    },

    {
      tool: {
        name: 'create_opportunity_type',
        description: 'Create a new Earn opportunity type. Admin role required.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Type name (e.g. "Grant", "Bounty", "Internship")' },
            sort_order: { type: 'number', description: 'Display sort order' },
            color: { type: 'string', description: 'Display colour (hex or CSS colour name)' },
            ...AUTH_ID_PARAM,
          },
          required: ['name'],
          additionalProperties: false,
        },
      },
      async handler(args) {
        try {
          const { auth_id, ...fields } = args as Record<string, unknown>;
          const data = await apiPost('/opportunities/types', fields, auth_id as string | undefined);
          return ok(JSON.stringify(data, null, 2));
        } catch (e) {
          return err(e instanceof Error ? e.message : String(e));
        }
      },
    },

    {
      tool: {
        name: 'update_opportunity_type',
        description: 'Update an existing Earn opportunity type. Admin role required.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Type ID to update' },
            name: { type: 'string' },
            sort_order: { type: 'number' },
            color: { type: 'string' },
            ...AUTH_ID_PARAM,
          },
          required: ['id'],
          additionalProperties: false,
        },
      },
      async handler(args) {
        try {
          const { id, auth_id, ...fields } = args as Record<string, unknown>;
          const data = await apiPatch(`/opportunities/types/${id as string}`, fields, auth_id as string | undefined);
          return ok(JSON.stringify(data, null, 2));
        } catch (e) {
          return err(e instanceof Error ? e.message : String(e));
        }
      },
    },

    {
      tool: {
        name: 'delete_opportunity_type',
        description: 'Delete an opportunity type by ID. Admin role required.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Type ID to delete' },
            ...AUTH_ID_PARAM,
          },
          required: ['id'],
          additionalProperties: false,
        },
      },
      async handler(args) {
        try {
          const { id, auth_id } = args as Record<string, unknown>;
          const data = await apiDelete(`/opportunities/types/${id as string}`, auth_id as string | undefined);
          return ok(JSON.stringify(data, null, 2));
        } catch (e) {
          return err(e instanceof Error ? e.message : String(e));
        }
      },
    },
  ];

  registerHiddenTools(tools);
}
