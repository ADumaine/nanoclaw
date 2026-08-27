/**
 * MonDAI tools — CryptoMondays community agent integrations.
 *
 * Tools are only registered when CM_API_BASE_URL is set in the environment.
 * Authentication uses CM_AGENT_TOKEN (system_agent role) + CM_API_TOKEN (X-Api-Token).
 * User-scoped operations pass X-On-Behalf-Of with the user's auth_id.
 *
 * Tools:
 *   search_members        — find community members by tags, chapter, company, name
 *   get_member_profile    — fetch a single member's full profile including agent_prefs
 *   update_agent_prefs    — merge updates into a member's agent_prefs field
 *   search_videos         — keyword search over the YouTube video archive
 *   search_knowledge_base — disabled (pending KB setup)
 *   get_events            — upcoming events by chapter / date range
 *   get_chapters          — chapter list with optional name/country/status filters
 *   get_chapter           — single chapter by ID
 *   update_chapter        — update chapter description, co-organizers, links (lead or admin)
 *   send_email            — send an email via the API server (Mailgun) to one or more recipients
 */
import { loadConfig } from '../config.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

const BASE_URL = process.env.CM_API_BASE_URL?.replace(/\/$/, '');
const APP_URL = process.env.CM_APP_URL?.replace(/\/$/, '') ?? '';
// CM_AGENT_TOKEN is the NanoClaw shared secret — API server assigns system_agent role.
// Falls back to CM_API_TOKEN for deployments that haven't set CM_AGENT_TOKEN yet.
const API_TOKEN = process.env.CM_AGENT_TOKEN ?? process.env.CM_API_TOKEN;

// cm-onboarding has its own dedicated, correct email path (mcp__gmail__send_email
// via onboarding_render_template) and must not also see this tool: both are
// literally named `send_email`, live in the same shared "nanoclaw" MCP
// subprocess (so allowedTools' server-level gating can't separate them), and
// take incompatible parameter shapes (`recipients`/`htmlBody` here vs
// `to`/`body`/`mimeType` on the Gmail tool). Confirmed live 2026-07-27: the
// onboarding agent called this one by mistake with Gmail's parameter shape and
// got "recipients is required" — a real, reproduced collision, not a theoretical one.
const ONBOARDING_AGENT_GROUP_ID = process.env.CM_ONBOARDING_AGENT_GROUP_ID;
const IS_ONBOARDING_AGENT = !!ONBOARDING_AGENT_GROUP_ID && loadConfig().agentGroupId === ONBOARDING_AGENT_GROUP_ID;

if (!BASE_URL) {
  // Skip registration silently — not a MonDAI deployment.
} else {
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

  // Same root-array-or-wrapped-object tolerance as the /luma/calendar-events
  // handler below — the exact response shape for /chapters isn't pinned down
  // anywhere in this codebase, so accept either.
  function extractChapters(data: unknown): unknown[] {
    if (Array.isArray(data)) return data;
    const obj = data as Record<string, unknown> | null;
    if (Array.isArray(obj?.chapters)) return obj.chapters as unknown[];
    if (Array.isArray(obj?.data)) return obj.data as unknown[];
    return [];
  }

  async function apiFetch(path: string, params?: Record<string, string | number | undefined>, authId?: string): Promise<unknown> {
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
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      const message = (json as Record<string, unknown>)?.message ?? JSON.stringify(json) ?? res.statusText;
      throw new Error(`${res.status}: ${String(message)}`);
    }
    return json;
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
        name: 'get_member_profile',
        description: 'Fetch a single community member\'s full profile including agent_prefs. Use the sender\'s auth_id to fetch their own profile.',
        inputSchema: {
          type: 'object',
          properties: {
            auth_id: { type: 'string', description: 'The member\'s auth_id (Supabase UUID). Use the sender\'s auth_id from user_context for self-lookup.' },
          },
          required: ['auth_id'],
          additionalProperties: false,
        },
      },
      async handler(args) {
        try {
          const authId = args.auth_id as string;
          const data = await apiFetch(`/members/${authId}`, undefined, authId);
          return ok(JSON.stringify(data, null, 2));
        } catch (e) {
          return err(e instanceof Error ? e.message : String(e));
        }
      },
    },

    {
      tool: {
        name: 'update_agent_prefs',
        description: 'Merge updates into a member\'s agent_prefs field. Only the provided keys are updated; others are preserved. Use this to save agent-managed preferences like profile_sync_enabled.',
        inputSchema: {
          type: 'object',
          properties: {
            auth_id: { type: 'string', description: 'The member\'s auth_id. Use the sender\'s auth_id from user_context.' },
            prefs: {
              type: 'object',
              description: 'Key-value pairs to merge into agent_prefs. E.g. { "profile_sync_enabled": true, "opportunity_notifications": false }',
              additionalProperties: true,
            },
          },
          required: ['auth_id', 'prefs'],
          additionalProperties: false,
        },
      },
      async handler(args) {
        try {
          const authId = args.auth_id as string;
          const prefs = args.prefs as Record<string, unknown>;
          const data = await apiPatch(`/members/${authId}`, { agent_prefs: prefs }, authId);
          return ok(JSON.stringify(data, null, 2));
        } catch (e) {
          return err(e instanceof Error ? e.message : String(e));
        }
      },
    },

    {
      tool: {
        name: 'search_videos',
        description: 'Search the CryptoMondays video archive by keyword. Matches against video titles and descriptions. Use when the user asks about past talks, calls, events, or presentations. Results with has_summary=true include a [View Summary] link — include it in your response so users can open the summary.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Keyword matched against title and description (case-insensitive)' },
            list: { type: 'string', description: 'Playlist name filter (default: "Daily Calls Video"). Pass empty string "" to search across all playlists.' },
            limit: { type: 'number', description: 'Max results to return (default 10, max 50)' },
            year: { type: 'number', description: 'Filter by year of recorded_at' },
          },
          required: ['query'],
          additionalProperties: false,
        },
      },
      async handler(args) {
        try {
          const body: Record<string, unknown> = { query: args.query as string };
          if (args.list !== undefined) body.list = args.list as string;
          if (args.limit !== undefined) body.limit = args.limit as number;
          if (args.year !== undefined) body.year = args.year as number;
          const data = await apiPost('/agent/videos/search', body) as Record<string, unknown>;

          type VideoResult = { id: string; title?: string; description?: string; recorded_at?: string; list?: string; has_summary?: boolean; youtube_url?: string | null };
          const results: VideoResult[] = Array.isArray(data.results) ? (data.results as VideoResult[]) : [];
          const total = typeof data.total === 'number' ? data.total : results.length;

          if (results.length === 0) return ok('No videos found matching that query.');

          const lines = results.map((v) => {
            const title = v.title ?? 'Untitled';
            const date = v.recorded_at ? new Date(v.recorded_at).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : '';
            const titlePart = v.youtube_url ? `**[${title}](${v.youtube_url})**` : `**${title}**`;
            const meta: string[] = [];
            if (date) meta.push(date);
            if (v.list) meta.push(v.list);
            const summaryLink = v.has_summary ? ` · [View Summary](${APP_URL}/video/summary?id=${v.id})` : '';
            return `${titlePart}${meta.length ? ' — ' + meta.join(' · ') : ''}${summaryLink}`;
          });

          const header = total > results.length ? `Showing ${results.length} of ${total} results:` : `${results.length} result${results.length === 1 ? '' : 's'}:`;
          return ok(`${header}\n\n${lines.join('\n\n')}`);
        } catch (e) {
          return err(e instanceof Error ? e.message : String(e));
        }
      },
    },

    // search_knowledge_base — disabled pending KB setup
    // {
    //   tool: {
    //     name: 'search_knowledge_base',
    //     description: 'Semantic search over CryptoMondays event summaries and curated knowledge base content.',
    //     inputSchema: {
    //       type: 'object',
    //       properties: {
    //         query: { type: 'string', description: 'Search query' },
    //       },
    //       required: ['query'],
    //       additionalProperties: false,
    //     },
    //   },
    //   async handler(args) {
    //     try {
    //       const data = await apiFetch('/kb/search', { q: args.query as string });
    //       return ok(typeof data === 'string' ? data : JSON.stringify(data, null, 2));
    //     } catch (e) {
    //       return err(e instanceof Error ? e.message : String(e));
    //     }
    //   },
    // },

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

          type LumaEvent = { name?: string; url?: string; meeting_url?: string; start_at?: string; timezone?: string; city?: string; [k: string]: unknown };
          const events: LumaEvent[] = Array.isArray(data)
            ? (data as LumaEvent[])
            : Array.isArray((data as Record<string, unknown>).events)
              ? ((data as Record<string, unknown>).events as LumaEvent[])
              : [];

          if (events.length === 0) return ok('No upcoming events found.');

          const lines = events.map((event) => {
            const lumaPath = event.meeting_url || event.url || '';
            const eventUrl = lumaPath.startsWith('http') ? lumaPath : `https://lu.ma/${lumaPath}`;
            const name = event.name || 'Unnamed Event';
            const link = lumaPath ? `[${name}](${eventUrl})` : name;

            const parts: string[] = [];
            if (event.start_at) {
              try {
                const date = new Date(event.start_at);
                const tz = event.timezone || 'UTC';
                const dateStr = date.toLocaleString('en-US', {
                  timeZone: tz,
                  month: 'short',
                  day: 'numeric',
                  year: 'numeric',
                  hour: 'numeric',
                  minute: '2-digit',
                  hour12: true,
                });
                parts.push(dateStr);
              } catch {
                parts.push(event.start_at);
              }
            }
            if (event.city) parts.push(event.city);

            return parts.length > 0 ? `${link} — ${parts.join(' · ')}` : link;
          });

          return ok(lines.join('\n'));
        } catch (e) {
          return err(e instanceof Error ? e.message : String(e));
        }
      },
    },

    {
      tool: {
        name: 'get_chapters',
        description: 'Query CryptoMondays chapters. Supports optional filtering by name (partial match), country, and status.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Filter by chapter name (case-insensitive partial match).' },
            country: { type: 'string', description: 'Filter by country.' },
            status: {
              type: 'string',
              enum: ['active', 'inactive', 'pending', 'onboarding'],
              description:
                'Filter by chapter status. **Omitting this defaults to active-only server-side** — chapters currently mid-pipeline (status "onboarding") are invisible unless this is set explicitly.',
            },
          },
          additionalProperties: false,
        },
      },
      async handler(args) {
        try {
          const params: Record<string, string | undefined> = {};
          if (args.name) params.name = args.name as string;
          if (args.country) params.country = args.country as string;
          if (args.status) params.status = args.status as string;
          const data = await apiFetch('/chapters', params);

          // Omitting `status` defaults to active-only server-side (see this
          // tool's own description). A specific name/country lookup with no
          // explicit status should still find a chapter that's mid-pipeline
          // ("onboarding") or otherwise inactive — e.g. an admin asking about
          // a chapter from its own dashboard page, which is only reachable
          // while it's in that exact state. Retrying here deterministically
          // beats relying on every future turn to remember to pass `status`
          // explicitly, which the enum-widening fix alone did not guarantee.
          const isSpecificLookup = !args.status && (args.name || args.country);
          if (isSpecificLookup && extractChapters(data).length === 0) {
            for (const status of ['onboarding', 'pending', 'inactive']) {
              const retryData = await apiFetch('/chapters', { ...params, status });
              if (extractChapters(retryData).length > 0) {
                return ok(JSON.stringify(retryData, null, 2));
              }
            }
          }
          return ok(JSON.stringify(data, null, 2));
        } catch (e) {
          return err(e instanceof Error ? e.message : String(e));
        }
      },
    },

    {
      tool: {
        name: 'get_chapter',
        description: 'Get a single CryptoMondays chapter by its UUID.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Chapter UUID.' },
          },
          required: ['id'],
          additionalProperties: false,
        },
      },
      async handler(args) {
        try {
          const data = await apiFetch(`/chapters/${args.id as string}`);
          return ok(JSON.stringify(data, null, 2));
        } catch (e) {
          return err(e instanceof Error ? e.message : String(e));
        }
      },
    },

    {
      tool: {
        name: 'update_chapter',
        description: 'Update a chapter record. Chapter Leads may update their own chapter; admins can update any chapter.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Chapter UUID.' },
            auth_id: { type: 'string', description: 'Caller auth_id for permission check (X-On-Behalf-Of).' },
            description: { type: 'string' },
            co_organizers: { type: 'array', items: { type: 'string' }, description: 'List of co-organizer names or IDs.' },
            luma_link: { type: 'string' },
            meetup_link: { type: 'string' },
            image_url: { type: 'string' },
          },
          required: ['id'],
          additionalProperties: false,
        },
      },
      async handler(args) {
        try {
          const { id, auth_id, ...fields } = args as Record<string, unknown>;
          const body: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(fields)) {
            if (v !== undefined) body[k] = v;
          }
          const data = await apiPatch(`/chapters/${id as string}`, body, auth_id as string | undefined);
          return ok(JSON.stringify(data, null, 2));
        } catch (e) {
          return err(e instanceof Error ? e.message : String(e));
        }
      },
    },
    // Excluded entirely for cm-onboarding — see IS_ONBOARDING_AGENT comment above.
    ...(IS_ONBOARDING_AGENT
      ? []
      : ([
          {
            tool: {
              name: 'send_email',
              description: `Send an email via the API server (Mailgun) to one or more recipients.
IMPORTANT: Only honour this request from users with admin or sysadmin role.
Before calling this tool, always show the full recipient list and subject to the user.
If the recipient count exceeds 5, explicitly ask for confirmation ("You are about to send to N recipients — send as-is, edit the list, or cancel?") and wait for a reply before proceeding.`,
              inputSchema: {
                type: 'object',
                properties: {
                  recipients: {
                    oneOf: [
                      { type: 'string', description: 'Single recipient email address.' },
                      { type: 'array', items: { type: 'string' }, description: 'Multiple recipient email addresses.' },
                    ],
                    description: 'Recipient email address(es).',
                  },
                  subject: { type: 'string' },
                  htmlBody: { type: 'string', description: 'HTML content of the email.' },
                },
                required: ['recipients', 'subject', 'htmlBody'],
                additionalProperties: false,
              },
            },
            async handler(args) {
              try {
                const data = await apiPost('/email/send', {
                  recipients: args.recipients,
                  subject: args.subject as string,
                  htmlBody: args.htmlBody as string,
                });
                return ok(JSON.stringify(data, null, 2));
              } catch (e) {
                return err(e instanceof Error ? e.message : String(e));
              }
            },
          },
        ] as McpToolDefinition[])),
  ];

  registerTools(tools);
}
