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
 *   onboarding_go_live              — atomic link-luma + go-live email + calendar-manager notify +
 *                                      advance-to-nagging (skillscript skill "onboarding-go-live",
 *                                      only registered when SKILLSCRIPT_RPC_URL is set — no inline
 *                                      fallback, see the registration comment at its definition)
 *   onboarding_daily_sweep           — core of flow #6: for every /stalled prospect, sends the
 *                                      matching follow-up/nag email + advances/touches the stage,
 *                                      or marks unresponsive + notifies admins once the limit is
 *                                      hit (skillscript skill "onboarding-daily-sweep", only
 *                                      registered when SKILLSCRIPT_RPC_URL is set — no inline
 *                                      fallback, same rationale as onboarding_go_live). Does not
 *                                      cover the Gmail Needs-Admin scan, daily-summary dispatch,
 *                                      or relabeling — those stay separate agent-driven tool calls.
 *   onboarding_get_settings         — environment settings incl. calendar manager's Telegram ID
 *                                      and whether processing is enabled (`active`)
 *   onboarding_notify_telegram      — message a specific Telegram user
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

  // Pipeline-record formatting for chat display. Moved here deliberately,
  // rather than left as a prose instruction for the agent to follow — three
  // separate attempts at prose formatting guidance in onboarding-procedures.md
  // (raw field dump -> "no changes, want a CSV?" deflection -> partial
  // compliance -> raw JSON with markdown-escaping artifacts) each produced a
  // different, still-wrong result, tracking which model happened to handle
  // that turn rather than the instruction wording. Formatting the text here
  // means there's nothing left for the model to get wrong — it relays this
  // verbatim instead of re-summarizing raw JSON itself.
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function formatUtc(iso: string | null | undefined): string {
    if (!iso) return 'never';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso);
    const hh = String(d.getUTCHours()).padStart(2, '0');
    const mm = String(d.getUTCMinutes()).padStart(2, '0');
    return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${hh}:${mm} UTC`;
  }

  function obRef(id: string): string {
    return `OB-${String(id).replace(/-/g, '').slice(0, 6)}`;
  }

  interface PipelineRecordLike {
    id: string;
    prospect_name: string;
    prospect_email?: string;
    city?: string;
    country?: string;
    stage: string;
    stage_notes?: string | null;
    last_contact_at?: string | null;
    chapters?: { name?: string; status?: string } | null;
  }

  function formatPipelineRecord(r: PipelineRecordLike): string {
    const chapterName = r.chapters?.name ?? '';
    const status = r.chapters?.status ?? '';
    const statusIsNotable = status !== '' && status !== 'onboarding' && !(r.stage === 'active' && status === 'active');
    const statusSuffix = statusIsNotable ? ` ⚠️ status: ${status}` : '';
    const location = [r.city, r.country].filter(Boolean).join(', ');
    const notes = r.stage_notes ? ` (${r.stage_notes})` : '';
    // prospect_email stays in the display text (not just dropped for tidiness)
    // — "find by name, then use their real email" is a documented rule above
    // that depends on the email actually being visible in onboarding_list output.
    return [
      `**${r.prospect_name}** (${r.prospect_email ?? 'no email on file'}) — ${obRef(r.id)}`,
      `Chapter: ${chapterName}${chapterName && location ? ' — ' : ''}${location}${statusSuffix}`,
      `Stage: ${r.stage}${notes}`,
      `Last contact: ${formatUtc(r.last_contact_at)}`,
    ].join('\n');
  }

  // The directive is colocated with the data itself, not just stated once in
  // the system prompt — a system-prompt-only "relay this verbatim" rule was
  // confirmed present and understood (the agent could recite it correctly
  // when asked directly) but still routinely lost to the model's own default
  // instinct to re-summarize tool output in its own words on a plain request.
  // Repeating the instruction right next to the content, at the exact point
  // the model composes its reply, is a stronger signal than a rule stated
  // once, earlier, and disconnected from this specific tool call.
  const VERBATIM_DIRECTIVE =
    '[Relay the record list below to the admin exactly as written — same line breaks, same OB- references, same chapter names, same wording. Do not paraphrase, reformat, condense to one line per record, drop any field, or offer a CSV/JSON export instead.]';

  function formatPipelineList(data: unknown): string | undefined {
    const records = (data as { success?: boolean; data?: PipelineRecordLike[] })?.data;
    if (!Array.isArray(records)) return undefined;
    if (records.length === 0) return 'No pipeline records found.';
    const body = `${records.length} record${records.length === 1 ? '' : 's'}:\n\n${records.map(formatPipelineRecord).join('\n\n')}`;
    return `${VERBATIM_DIRECTIVE}\n\n${body}`;
  }

  // Out-of-order stage transition check for onboarding_advance. Same rationale
  // as the list-formatting directive above: the prose version of this rule
  // ("check current stage, confirm before an out-of-order transition") was
  // confirmed not held live (2026-07-28 — advanced invited straight to
  // verified, skipping following_up/meeting_scheduled, with no mention to the
  // admin, despite having just fetched the current stage via onboarding_get).
  // The stage sequence is fixed and well-defined, so the check itself can be
  // deterministic even though the *decision* whether to proceed anyway stays
  // with the agent — this only guarantees the mismatch is surfaced, not that
  // the transition is blocked (skipping can be legitimate, per the existing
  // doc: "a meeting could have been missed, or steps could have happened
  // somewhere you can't see").
  const STAGE_ORDER = [
    'referred',
    'invited',
    'following_up',
    'meeting_scheduled',
    'verified',
    'live_instructions',
    'nagging',
    'active',
  ];
  const TERMINAL_SIDE_STAGES = new Set(['declined', 'unresponsive']);

  // Transitions documented as legitimate elsewhere in this file/onboarding-procedures.md,
  // beyond the plain "next stage in STAGE_ORDER" case — an allowlist, not a pure
  // sequence check, specifically because a naive sequence check would false-positive
  // on real, common, already-documented flows: flow #2 allows invited -> meeting_scheduled
  // directly (a prospect can reply before any follow-up was ever sent), and flow #6's
  // daily sweep does same-stage "touches" (following_up->following_up, nagging->nagging)
  // just to log contact, which is handled separately below, not via this set.
  const ALLOWED_EXTRA_TRANSITIONS = new Set([
    'invited->meeting_scheduled', // flow #2: reply arrives before any follow-up was sent
  ]);

  function stageTransitionWarning(fromStage: string, toStage: string): string | undefined {
    if (fromStage === toStage) return undefined; // same-stage "log contact" touch (flow #6) — always fine
    if (TERMINAL_SIDE_STAGES.has(fromStage) || TERMINAL_SIDE_STAGES.has(toStage)) return undefined;
    if (ALLOWED_EXTRA_TRANSITIONS.has(`${fromStage}->${toStage}`)) return undefined;
    const fromIdx = STAGE_ORDER.indexOf(fromStage);
    const toIdx = STAGE_ORDER.indexOf(toStage);
    if (fromIdx === -1 || toIdx === -1 || toIdx === fromIdx + 1) return undefined;
    if (toIdx < fromIdx) {
      return `[NOTICE: this moves the record backward — from "${fromStage}" to "${toStage}". No documented flow does this; confirm it was actually intended and mention it to the admin explicitly, don't report it as routine.]`;
    }
    const skipped = STAGE_ORDER.slice(fromIdx + 1, toIdx).join(', ');
    return `[NOTICE: this skips ahead from "${fromStage}" directly to "${toStage}", bypassing the normal intermediate stage(s) (${skipped}). This can be legitimate, but you must say so explicitly in your reply to the admin — don't report this as a routine transition.]`;
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

  const PROCESSING_DISABLED_MESSAGE =
    'Onboarding processing is currently disabled. To resume, re-enable it via the MonDAI admin panel → Community Manager → Onboarding config tab.';

  // Enable/disable gate for every tool that mutates pipeline state or sends
  // something (email, Telegram). Enforced here, in code, rather than left to
  // the agent to remember to check onboarding_get_settings first — a prose-only
  // check in onboarding-procedures.md was proven unreliable in live testing
  // (2026-07-25 to -27: the scheduled daily sweep and weekly digest both ran
  // normally for three days straight while active=false server-side; nothing
  // was actually sent only because the pipeline was empty and an unrelated
  // flag also happened to be off — not because the check held).
  // Fails open (treats as enabled) on a settings-check error — a transient
  // hiccup must not block legitimate work indefinitely; only an explicit
  // `active === false` blocks the call.
  async function requireActive(): Promise<string | undefined> {
    try {
      const settings = (await apiGet('/agent/onboarding/settings')) as { data?: { active?: boolean } };
      if (settings?.data?.active === false) return PROCESSING_DISABLED_MESSAGE;
      return undefined;
    } catch {
      return undefined;
    }
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
          return ok(formatPipelineList(data) ?? JSON.stringify(data, null, 2));
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
        description: 'Create a new chapter onboarding pipeline entry and a linked chapter (status "onboarding"). Check onboarding_list first to avoid creating a duplicate for the same prospect. The API checks for an existing chapter by exact `name` (not `city`) — a city can legitimately host more than one chapter, e.g. "New York City - Wall Street" and "New York City - Uptown".',
        inputSchema: {
          type: 'object',
          properties: {
            prospect_name: { type: 'string' },
            prospect_email: { type: 'string' },
            name: { type: 'string', description: 'The chapter\'s own name, if it differs from the city (e.g. "BitcoinMondays El Salvador", "Zoom (Europe)", "New York City - Wall Street"). Omit only when the chapter name genuinely is just the city — the API defaults to "{city} Chapter" if omitted, which is not always right. Confirm with the admin which one they mean before deciding.' },
            city: { type: 'string' },
            country: { type: 'string' },
          },
          required: ['prospect_name', 'prospect_email'],
          additionalProperties: false,
        },
      },
      async handler(args) {
        const blocked = await requireActive();
        if (blocked) return err(blocked);
        try {
          const data = await apiPost('/agent/onboarding/create', {
            prospect_name: args.prospect_name as string,
            prospect_email: args.prospect_email as string,
            name: args.name as string | undefined,
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
        const blocked = await requireActive();
        if (blocked) return err(blocked);
        try {
          let warning: string | undefined;
          try {
            const current = (await apiGet(`/agent/onboarding/get/${args.id as string}`)) as {
              data?: { stage?: string };
            };
            if (current?.data?.stage) warning = stageTransitionWarning(current.data.stage, args.stage as string);
          } catch {
            // Pre-check fetch failing shouldn't block the actual advance attempt.
          }
          const prefix = warning ? `${warning}\n\n` : '';
          if (SKILLSCRIPT_RPC_URL) {
            const vars = await executeSkill('onboarding-advance', {
              ID: args.id as string,
              STAGE: args.stage as string,
              NOTES: (args.notes as string | undefined) ?? '',
              BASE_URL: BASE_URL as string,
            });
            return ok(`${prefix}${JSON.stringify({ success: vars.SUCCESS === 'true', stage: vars.NEW_STAGE }, null, 2)}`);
          }
          const data = await apiPost('/agent/onboarding/advance', {
            id: args.id as string,
            stage: args.stage as string,
            notes: args.notes as string | undefined,
          });
          return ok(`${prefix}${JSON.stringify(data, null, 2)}`);
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
        const blocked = await requireActive();
        if (blocked) return err(blocked);
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
        const blocked = await requireActive();
        if (blocked) return err(blocked);
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

    // Only registered when SKILLSCRIPT_RPC_URL is configured — there is no
    // inline-TypeScript fallback, deliberately. That fallback is exactly the
    // agent-driven multi-step sequence this tool exists to replace (2026-07-28:
    // left as separate steps, flow #4 repeatedly produced a redundant advance
    // call, a silently-skipped calendar-manager notify, and records stuck at
    // live_instructions). If skillscript isn't configured, the old manual
    // sequence in onboarding-procedures.md flow #4 is the only path — that
    // documentation stays as the fallback, not a redundant restatement.
    ...(SKILLSCRIPT_RPC_URL
      ? ([
          {
            tool: {
              name: 'onboarding_go_live',
              description:
                'Atomic "save Luma link and go live" action for a verified chapter — links the Luma calendar, renders and sends the go-live email to the prospect, notifies the calendar manager via whichever of Telegram/email is actually configured (both independently, checked fresh every call), and advances the record to `nagging`. Replaces the whole flow #4 sequence (onboarding_link_luma + onboarding_render_template + mcp__gmail__send_email + onboarding_get_settings + onboarding_notify_telegram + onboarding_advance as separate calls) with one deterministic call — use this instead of doing those steps yourself.',
              inputSchema: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  calendar_url: { type: 'string' },
                },
                required: ['id', 'calendar_url'],
                additionalProperties: false,
              },
            },
            async handler(args) {
              const blocked = await requireActive();
              if (blocked) return err(blocked);
              try {
                const vars = await executeSkill('onboarding-go-live', {
                  ID: args.id as string,
                  CALENDAR_URL: args.calendar_url as string,
                  BASE_URL: BASE_URL as string,
                });
                return ok(JSON.stringify(vars, null, 2));
              } catch (e) {
                return err(e instanceof Error ? e.message : String(e));
              }
            },
          },
          {
            tool: {
              name: 'onboarding_daily_sweep',
              description:
                'Core of the daily pipeline sweep (flow #6) — for every prospect currently overdue (per /agent/onboarding/stalled), sends the matching follow-up or nag email and touches/advances the stage to log contact, or marks the prospect unresponsive and notifies every configured admin once the follow-up/nag limit is reached. Deterministic, server-side, one call covers the whole per-record loop — use this instead of fetching onboarding_stalled and looping yourself. Does NOT handle the Gmail "Needs-Admin" label scan, the daily-summary dispatch, or relabeling — do those as separate steps after this returns, same as before.',
              inputSchema: { type: 'object', properties: {}, additionalProperties: false },
            },
            async handler() {
              const blocked = await requireActive();
              if (blocked) return err(blocked);
              try {
                const vars = await executeSkill('onboarding-daily-sweep', {
                  BASE_URL: BASE_URL as string,
                });
                return ok(JSON.stringify(vars, null, 2));
              } catch (e) {
                return err(e instanceof Error ? e.message : String(e));
              }
            },
          },
        ] as McpToolDefinition[])
      : []),

    {
      tool: {
        name: 'onboarding_get_settings',
        description: 'Fetch environment-level onboarding settings, including the calendar manager\'s current Telegram ID (`cal_mgr_telegram_id`) and email (`cal_mgr_email`) — two independent notification channels, check and use each one separately, whichever is actually populated — and whether onboarding processing is enabled (`active`). The calendar manager is a role, not a fixed person — always look this up fresh rather than remembering a previously-seen ID/email, since whoever holds the role can change. Check `active` before any admin-requested mutation — see onboarding-procedures.md.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      },
      async handler() {
        try {
          const data = await apiGet('/agent/onboarding/settings');
          return ok(JSON.stringify(data, null, 2));
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
        const blocked = await requireActive();
        if (blocked) return err(blocked);
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
        const blocked = await requireActive();
        if (blocked) return err(blocked);
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
        const blocked = await requireActive();
        if (blocked) return err(blocked);
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
        const blocked = await requireActive();
        if (blocked) return err(blocked);
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
        const blocked = await requireActive();
        if (blocked) return err(blocked);
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
