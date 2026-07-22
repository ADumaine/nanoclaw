/**
 * Chapter Onboarding MCP tools — pipeline state for the cm-onboarding agent
 * ONLY. Unlike mondai.ts/opportunities.ts (deliberately available to every
 * MonDAI-integrated agent group), these tools are admin-only chapter-pipeline
 * actions and must not be visible to the community/member-facing agent.
 *
 * All the internal `registerTools`-based MCP modules (core, scheduling,
 * mondai, opportunities, onboarding, ...) run in one shared "nanoclaw" MCP
 * subprocess per container (see src/index.ts) — there is no per-group
 * mcpServers registration for them the way there is for spawned servers
 * like gmail-mcp, and the SDK's allowedTools only gates at the whole-server
 * level (`mcp__nanoclaw__*`), not per tool name. So gating has to happen at
 * *registration* time, inside this module, using a signal that actually
 * differs per agent group's container.
 *
 * `agentGroupId` (from container.json, unique per group) is that signal.
 * ONBOARDING_AGENT_GROUP_ID is broadcast identically to every container via
 * the same CM_-prefix-style env forwarding (see container-runner.ts) as a
 * plain "which id is the onboarding one" constant — comparing it against
 * this container's own agentGroupId is true only inside cm-onboarding's
 * own container.
 *
 * Auth mirrors mondai.ts / opportunities.ts:
 *   - CM_AGENT_TOKEN (falls back to CM_API_TOKEN) authenticates as system_agent.
 *   - This agent group's container also receives its own
 *     CM_AGENT_TOKEN_cm-onboarding value (see src/container-runner.ts
 *     per-app_id override) so cm-data-api's status-lock middleware can tell
 *     these calls apart from any other caller at the API layer too — this
 *     module's registration gate and that token are independent defenses,
 *     not substitutes for each other.
 *
 * SKILLSCRIPT_RPC_URL (optional): when set, onboarding_render_template and
 * onboarding_advance dispatch through skillscript-runtime's execute_skill
 * instead of calling cm-data-api directly, making the render/parse and
 * advance/log steps a deterministic, pre-approved sequence rather than
 * something the agent re-reasons per call. The corresponding skills
 * (onboarding-render-email, onboarding-advance) must already exist and be
 * Approved in skillscript's store; this module does not create them.
 *
 * Both skills declare a `BASE_URL` var with a dev-only hardcoded default —
 * skillscript has no environment-injection mechanism for plain (non-secret)
 * vars, so every call here passes BASE_URL explicitly from this module's own
 * BASE_URL constant (CM_API_BASE_URL), overriding the skill's default. Only
 * the auth token is a real skillscript secret (SKILLSCRIPT_SECRET_CM_AGENT_TOKEN_ONBOARDING).
 *
 * Tools:
 *   onboarding_list                 — list pipeline records, filter by stage/email
 *   onboarding_get                  — single pipeline record by id
 *   onboarding_lookup               — find record by prospect email (Gmail reply matching)
 *   onboarding_create               — create pipeline entry + planned chapter
 *   onboarding_advance              — move to next stage, log contact/notes
 *                                      (routes through skillscript's onboarding-advance
 *                                      skill when SKILLSCRIPT_RPC_URL is set — see below)
 *   onboarding_render_template      — resolve an email template (subject/html_body/recipient)
 *                                      (routes through skillscript's onboarding-render-email
 *                                      skill when SKILLSCRIPT_RPC_URL is set, unless a
 *                                      `variables` override is supplied)
 *   onboarding_link_luma            — store Luma calendar url/id
 *   onboarding_get_settings         — environment settings incl. calendar manager's Telegram ID
 *   onboarding_notify_telegram      — message a specific Telegram user
 *   onboarding_generate_invite_link — one-time Champions group invite link
 *   onboarding_set_active           — activate chapter + pipeline (transactional); also
 *                                      triggers the Champions welcome announcement internally
 *   onboarding_mark_unresponsive    — mark prospect unresponsive (transactional)
 *   onboarding_stalled              — prospects overdue per onboarding_settings thresholds
 *   onboarding_daily_summary        — aggregate + dispatch the daily admin activity summary
 *   onboarding_weekly_summary       — aggregate + dispatch the weekly Champions growth digest
 */
import { loadConfig } from '../config.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

const BASE_URL = process.env.CM_API_BASE_URL?.replace(/\/$/, '');
const API_TOKEN = process.env.CM_AGENT_TOKEN ?? process.env.CM_API_TOKEN;

// skillscript-runtime RPC endpoint. When set, onboarding_render_template and
// onboarding_advance dispatch through skillscript's deterministic
// onboarding-render-email / onboarding-advance skills (execute_skill) instead
// of calling cm-data-api directly — same tool interface, but the render/parse
// and advance/log steps become an auditable, unalterable sequence rather than
// something the agent re-reasons (and can drift on) every call. Falls back to
// direct apiPost when unset, so this is safe to leave unconfigured elsewhere.
const SKILLSCRIPT_RPC_URL = process.env.SKILLSCRIPT_RPC_URL;

// Auth for GET /agent/onboarding/settings only — every other onboarding_*
// endpoint uses the Bearer CM_AGENT_TOKEN scheme (API_TOKEN below). This one
// endpoint is authenticated with x-shared-secret instead (same secret
// src/channels/webapp.ts uses for the opposite-direction API->NanoClaw
// callback). Read as its own var rather than reusing API_TOKEN — the two
// happen to share a value today but are not guaranteed to stay in sync.
const WEBAPP_SHARED_SECRET = process.env.WEBAPP_SHARED_SECRET;

// Broadcast to every container (same value everywhere); only matches this
// container's own agentGroupId when we're actually running as cm-onboarding.
const ONBOARDING_AGENT_GROUP_ID = process.env.CM_ONBOARDING_AGENT_GROUP_ID;
const IS_ONBOARDING_AGENT = !!ONBOARDING_AGENT_GROUP_ID && loadConfig().agentGroupId === ONBOARDING_AGENT_GROUP_ID;

if (!BASE_URL || !IS_ONBOARDING_AGENT) {
  // Skip registration silently — not a MonDAI deployment, or not the
  // cm-onboarding agent group. Do NOT weaken this to "BASE_URL only": these
  // are admin-only chapter-pipeline mutations and must stay invisible to
  // the community/member-facing agent.
} else {
  function authHeaders(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (API_TOKEN) h['Authorization'] = `Bearer ${API_TOKEN}`;
    if (process.env.CM_API_TOKEN) h['X-Api-Token'] = process.env.CM_API_TOKEN;
    return h;
  }

  function ok(text: string) {
    return { content: [{ type: 'text' as const, text }] };
  }

  function err(text: string) {
    return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
  }

  async function apiGet(path: string, params?: Record<string, string | number | undefined>): Promise<unknown> {
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

  async function apiPost(path: string, body: Record<string, unknown>): Promise<unknown> {
    const res = await fetch(`${BASE_URL}${path}`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      const message = (json as Record<string, unknown>)?.message ?? JSON.stringify(json) ?? res.statusText;
      throw new Error(`${res.status}: ${String(message)}`);
    }
    return json;
  }

  // Calls skillscript-runtime's execute_skill over its RPC endpoint and
  // returns the skill's final_vars. Throws on transport errors, JSON-RPC
  // errors, or a non-empty `errors` array in the skill's own result envelope.
  async function executeSkill(skillName: string, inputs: Record<string, string>): Promise<Record<string, string>> {
    const res = await fetch(SKILLSCRIPT_RPC_URL as string, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: Date.now(),
        method: 'tools/call',
        params: { name: 'execute_skill', arguments: { name: skillName, inputs } },
      }),
    });
    const rpc = (await res.json()) as {
      error?: { message: string };
      result?: { content?: { type: string; text?: string }[] };
    };
    if (rpc.error) throw new Error(`skillscript RPC error: ${rpc.error.message}`);
    const text = rpc.result?.content?.[0]?.text;
    if (!text) throw new Error('skillscript: empty response');
    const parsed = JSON.parse(text) as {
      final_vars?: Record<string, string>;
      errors?: { message: string }[];
    };
    if (parsed.errors && parsed.errors.length > 0) {
      throw new Error(`skillscript skill "${skillName}" failed: ${parsed.errors.map((e) => e.message).join('; ')}`);
    }
    return parsed.final_vars ?? {};
  }

  const tools: McpToolDefinition[] = [
    {
      tool: {
        name: 'onboarding_list',
        description: 'List chapter onboarding pipeline records. Optionally filter by stage and/or prospect email. If you only have a name, not a confirmed exact email, call this with NO filters (empty object) and search the returned list by name yourself — a guessed email in the email filter will silently return zero results, indistinguishable from "not in the pipeline", so a wrong guess looks exactly like a real miss.',
        inputSchema: {
          type: 'object',
          properties: {
            stage: { type: 'string', description: 'Filter by pipeline stage (e.g. "invited", "nagging").' },
            email: { type: 'string', description: 'Filter by prospect email. Must be the exact address on file — do not guess or construct one from a name.' },
          },
          additionalProperties: false,
        },
      },
      async handler(args) {
        try {
          const data = await apiGet('/agent/onboarding/list', {
            stage: args.stage as string | undefined,
            email: args.email as string | undefined,
          });
          return ok(JSON.stringify(data, null, 2));
        } catch (e) {
          return err(e instanceof Error ? e.message : String(e));
        }
      },
    },

    {
      tool: {
        name: 'onboarding_get',
        description: 'Get a single chapter onboarding pipeline record by its UUID.',
        inputSchema: {
          type: 'object',
          properties: { id: { type: 'string', description: 'Pipeline record UUID.' } },
          required: ['id'],
          additionalProperties: false,
        },
      },
      async handler(args) {
        try {
          const data = await apiGet(`/agent/onboarding/get/${args.id as string}`);
          return ok(JSON.stringify(data, null, 2));
        } catch (e) {
          return err(e instanceof Error ? e.message : String(e));
        }
      },
    },

    {
      tool: {
        name: 'onboarding_lookup',
        description: 'Find a pipeline record by exact prospect email address. Use this to resolve an inbound email reply to its pipeline record before deciding how to respond. Do NOT guess or construct an email from a name (e.g. "jane@test.com" for someone named Jane) — a wrong guess returns an empty result identical to a real not-found, not an error. If you only have a name, use onboarding_list with no filters instead and match by name.',
        inputSchema: {
          type: 'object',
          properties: { email: { type: 'string', description: 'Sender email address to look up. Must be the exact address on file.' } },
          required: ['email'],
          additionalProperties: false,
        },
      },
      async handler(args) {
        try {
          const data = await apiPost('/agent/onboarding/lookup', { email: args.email as string });
          return ok(JSON.stringify(data, null, 2));
        } catch (e) {
          return err(e instanceof Error ? e.message : String(e));
        }
      },
    },

    {
      tool: {
        name: 'onboarding_create',
        description: 'Create a new chapter onboarding pipeline entry and a linked "planned" chapter. Check onboarding_list first to avoid creating a duplicate for the same prospect.',
        inputSchema: {
          type: 'object',
          properties: {
            prospect_name: { type: 'string' },
            prospect_email: { type: 'string' },
            city: { type: 'string' },
            country: { type: 'string' },
          },
          required: ['prospect_name', 'prospect_email'],
          additionalProperties: false,
        },
      },
      async handler(args) {
        try {
          const data = await apiPost('/agent/onboarding/create', {
            prospect_name: args.prospect_name as string,
            prospect_email: args.prospect_email as string,
            city: args.city as string | undefined,
            country: args.country as string | undefined,
          });
          return ok(JSON.stringify(data, null, 2));
        } catch (e) {
          return err(e instanceof Error ? e.message : String(e));
        }
      },
    },

    {
      tool: {
        name: 'onboarding_advance',
        description: 'Advance a pipeline record to a new stage and log contact/notes. This is a conditional update — it fails if the record is not currently in the expected prior stage (race protection), so check the error before retrying.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            stage: { type: 'string', description: 'New stage to transition to.' },
            notes: { type: 'string', description: 'Note to log against this transition.' },
          },
          required: ['id', 'stage'],
          additionalProperties: false,
        },
      },
      async handler(args) {
        try {
          if (SKILLSCRIPT_RPC_URL) {
            const vars = await executeSkill('onboarding-advance', {
              ID: args.id as string,
              STAGE: args.stage as string,
              NOTES: (args.notes as string | undefined) ?? '',
              BASE_URL: BASE_URL as string,
            });
            return ok(JSON.stringify({ success: vars.SUCCESS === 'true', stage: vars.NEW_STAGE }, null, 2));
          }
          const data = await apiPost('/agent/onboarding/advance', {
            id: args.id as string,
            stage: args.stage as string,
            notes: args.notes as string | undefined,
          });
          return ok(JSON.stringify(data, null, 2));
        } catch (e) {
          return err(e instanceof Error ? e.message : String(e));
        }
      },
    },

    {
      tool: {
        name: 'onboarding_render_template',
        description: 'Resolve an onboarding email template (subject + HTML body + recipient) for a prospect by email. The API resolves all chapter/prospect fields, the app URL, and the meeting link automatically from its own database — you do not need to (and should not) supply substitution variables. In non-production environments the recipient may be redirected to a test address — always send to the returned recipient, not the prospect email directly.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Exact template database name — see the template reference table for the current list. Must match exactly, including punctuation.' },
            email: { type: 'string', description: "The prospect's real email address (from the pipeline record) — identifies which record to resolve fields from, and is used server-side for the dev-environment redirect check." },
            variables: {
              type: 'object',
              description: 'Optional. Only for deliberately overriding a specific field — omit entirely for a normal send, the API fills everything in on its own.',
              additionalProperties: true,
            },
          },
          required: ['name', 'email'],
          additionalProperties: false,
        },
      },
      async handler(args) {
        try {
          // The skillscript path only covers the normal (no override) case —
          // a deliberate `variables` override still goes straight to the API.
          if (SKILLSCRIPT_RPC_URL && args.variables === undefined) {
            const vars = await executeSkill('onboarding-render-email', {
              TEMPLATE: args.name as string,
              EMAIL: args.email as string,
              BASE_URL: BASE_URL as string,
            });
            return ok(JSON.stringify({ subject: vars.SUBJECT, htmlBody: vars.HTML_BODY, recipient: vars.RECIPIENT }, null, 2));
          }
          const body: Record<string, unknown> = { name: args.name as string, email: args.email as string };
          if (args.variables !== undefined) body.variables = args.variables;
          const data = await apiPost('/agent/onboarding/render-template', body);
          return ok(JSON.stringify(data, null, 2));
        } catch (e) {
          return err(e instanceof Error ? e.message : String(e));
        }
      },
    },

    {
      tool: {
        name: 'onboarding_link_luma',
        description: 'Store a chapter\'s Luma calendar URL and calendar ID once the admin has completed the manual Luma setup checklist. Validate the URL looks like a lu.ma link before calling this. Transactional on the API side: also advances the pipeline stage to `live_instructions` and logs the activity note — do not call onboarding_advance separately for that transition, it is already handled.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            calendar_url: { type: 'string' },
            calendar_id: { type: 'string' },
          },
          required: ['id', 'calendar_url'],
          additionalProperties: false,
        },
      },
      async handler(args) {
        try {
          const data = await apiPost('/agent/onboarding/link-luma', {
            id: args.id as string,
            calendar_url: args.calendar_url as string,
            calendar_id: args.calendar_id as string | undefined,
          });
          return ok(JSON.stringify(data, null, 2));
        } catch (e) {
          return err(e instanceof Error ? e.message : String(e));
        }
      },
    },

    {
      tool: {
        name: 'onboarding_get_settings',
        description: 'Fetch environment-level onboarding settings, including the calendar manager\'s current Telegram ID (`cal_mgr_telegram_id`). The calendar manager is a role, not a fixed person — always look this up fresh rather than remembering a previously-seen ID, since whoever holds the role can change.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      },
      async handler() {
        try {
          if (!WEBAPP_SHARED_SECRET) return err('WEBAPP_SHARED_SECRET not configured for this container');
          const res = await fetch(`${BASE_URL}/agent/onboarding/settings`, {
            headers: { 'x-shared-secret': WEBAPP_SHARED_SECRET },
          });
          const json = await res.json().catch(() => null);
          if (!res.ok) {
            const message = (json as Record<string, unknown>)?.message ?? JSON.stringify(json) ?? res.statusText;
            throw new Error(`${res.status}: ${String(message)}`);
          }
          return ok(JSON.stringify(json, null, 2));
        } catch (e) {
          return err(e instanceof Error ? e.message : String(e));
        }
      },
    },

    {
      tool: {
        name: 'onboarding_notify_telegram',
        description: 'Send a Telegram message to a specific internal recipient (calendar manager, admin, etc.) about a pipeline event.',
        inputSchema: {
          type: 'object',
          properties: {
            telegram_id: { type: 'string' },
            text: { type: 'string' },
          },
          required: ['telegram_id', 'text'],
          additionalProperties: false,
        },
      },
      async handler(args) {
        try {
          const data = await apiPost('/agent/onboarding/notify-telegram', {
            telegram_id: args.telegram_id as string,
            text: args.text as string,
          });
          return ok(JSON.stringify(data, null, 2));
        } catch (e) {
          return err(e instanceof Error ? e.message : String(e));
        }
      },
    },

    {
      tool: {
        name: 'onboarding_generate_invite_link',
        description: 'Generate a one-time, 24-hour Telegram invite link to the Chapter Champions group for a verified prospect. Returns the existing cached link if one was already generated for this record.',
        inputSchema: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
          additionalProperties: false,
        },
      },
      async handler(args) {
        try {
          const data = await apiPost('/agent/onboarding/generate-invite-link', { id: args.id as string });
          return ok(JSON.stringify(data, null, 2));
        } catch (e) {
          return err(e instanceof Error ? e.message : String(e));
        }
      },
    },

    {
      tool: {
        name: 'onboarding_set_active',
        description: 'Mark a chapter as active (first event published) and advance its pipeline record to the terminal "active" stage. Applied transactionally on the API side. Also handles the Chapter Champions welcome announcement internally (gated on "champions_announce_new_chapter") — no separate call needed for that.',
        inputSchema: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
          additionalProperties: false,
        },
      },
      async handler(args) {
        try {
          const data = await apiPost('/agent/onboarding/set-active', { id: args.id as string });
          return ok(JSON.stringify(data, null, 2));
        } catch (e) {
          return err(e instanceof Error ? e.message : String(e));
        }
      },
    },

    {
      tool: {
        name: 'onboarding_mark_unresponsive',
        description: 'Mark a prospect unresponsive after exhausting follow-up/nag attempts. Applied transactionally on the API side.',
        inputSchema: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
          additionalProperties: false,
        },
      },
      async handler(args) {
        try {
          const data = await apiPost('/agent/onboarding/mark-unresponsive', { id: args.id as string });
          return ok(JSON.stringify(data, null, 2));
        } catch (e) {
          return err(e instanceof Error ? e.message : String(e));
        }
      },
    },

    {
      tool: {
        name: 'onboarding_stalled',
        description: 'List prospects currently overdue for follow-up or nagging, per the configured cadence thresholds. Use this at the start of the daily sweep.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      },
      async handler() {
        try {
          const data = await apiGet('/agent/onboarding/stalled');
          return ok(JSON.stringify(data, null, 2));
        } catch (e) {
          return err(e instanceof Error ? e.message : String(e));
        }
      },
    },

    {
      tool: {
        name: 'onboarding_daily_summary',
        description: 'Compile and dispatch the daily onboarding activity summary email to the configured admin recipients. Call once per day at the end of the sweep.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      },
      async handler() {
        try {
          const data = await apiGet('/agent/onboarding/daily-summary');
          return ok(JSON.stringify(data, null, 2));
        } catch (e) {
          return err(e instanceof Error ? e.message : String(e));
        }
      },
    },

    {
      tool: {
        name: 'onboarding_weekly_summary',
        description: 'Compile and dispatch the weekly celebratory network-growth digest (new chapters launched in the last 7 days, overall active chapter totals) to the Chapter Champions group. Call once a week on its own schedule — separate from the daily admin digest, different audience and content. Gated server-side on the "champions_weekly_summary_enabled" setting — safe to call unconditionally, it no-ops if disabled.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      },
      async handler() {
        try {
          const data = await apiGet('/agent/onboarding/weekly-summary');
          return ok(JSON.stringify(data, null, 2));
        } catch (e) {
          return err(e instanceof Error ? e.message : String(e));
        }
      },
    },
  ];

  registerTools(tools);
}
