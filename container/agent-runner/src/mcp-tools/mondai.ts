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
 *   get_my_usage          — sender's token/usage stats via /agent/usage
 *   smart_search_members  — AI-ranked expert/topic search via /members/match
 *   find_similar_members  — "similar to me" peer matching via /members/match
 *   search_videos         — keyword search over the YouTube video archive
 *   get_video_summary     — video summary via /transcriptions/video/summary. Delivers directly by
 *                           default (read_content omitted/false); read_content:true returns the
 *                           text into context instead, for when the agent needs to read it.
 *   get_video_transcript  — same pattern, via /transcriptions/video/transcript
 *   search_knowledge_base — disabled (pending KB setup)
 *   get_events            — upcoming events by chapter / date range
 *   get_chapters          — chapter list with optional name/country/status filters
 *   get_chapter           — single chapter by ID
 *   update_chapter        — update chapter description, co-organizers, links (lead or admin)
 *   send_email            — send an email via the API server (Mailgun) to one or more recipients
 */
import { loadConfig } from '../config.js';
import { getCurrentInReplyTo } from '../current-batch.js';
import { writeMessageOut } from '../db/messages-out.js';
import { resolveRouting } from './core.js';
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

  function generateId(): string {
    return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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

  // Member-facing id checks. The API confirmed (2026-10-26) that a non-UUID
  // (e.g. numeric Telegram) id in a member path/query crashes with a Postgres
  // UUID syntax error, and that unlinked senders must be told to /link instead.
  // Enforced here, not left to prompt text, so a small model can't skip it.
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const NOT_LINKED_MSG =
    'The sender has no linked CryptoMondays account. Tell them exactly: "You haven\'t connected your CryptoMondays account yet. Please send `/link` to connect your profile."' +
    (APP_URL ? ` Then add: "New here? Sign up or log in at ${APP_URL}".` : '');

  // Adds an absolute profile_url to each member object (Telegram can't follow
  // relative links). `id` is profiles.id per the API team; CM_APP_URL differs
  // per environment so the link is built here rather than hard-coded in prompts.
  function withProfileUrls(data: unknown): unknown {
    if (!APP_URL) return data;
    const addTo = (item: unknown): unknown => {
      const o = item as Record<string, unknown> | null;
      if (o && typeof o === 'object' && typeof o.id === 'string' && UUID_RE.test(o.id)) {
        return { ...o, profile_url: `${APP_URL}/profile/${o.id}` };
      }
      return item;
    };
    if (Array.isArray(data)) return data.map(addTo);
    const obj = data as Record<string, unknown> | null;
    if (obj && typeof obj === 'object') {
      const out: Record<string, unknown> = { ...obj };
      for (const k of ['members', 'results', 'data', 'items']) {
        if (Array.isArray(out[k])) out[k] = (out[k] as unknown[]).map(addTo);
      }
      return out;
    }
    return data;
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

  // Conservative margin under Telegram's 4096-UTF-16-unit hard cap on a
  // single sendMessage — confirmed live 2026-10-24: the agent computing its
  // own chunk boundaries by eye ("Chunk 1 of 4") produced a first chunk that
  // still exceeded the limit and failed to send, even on the plain-text
  // fallback retry (so it was genuinely a length problem, not a markdown-
  // parsing one). Splitting deterministically in code, not leaving the
  // model to self-police a hard numeric limit turn to turn, is the same
  // fix this codebase applies elsewhere (see onboarding.ts's
  // VERBATIM_DIRECTIVE / stageTransitionWarning and the project's own
  // "deterministic vs prose instructions" lesson).
  const TELEGRAM_SAFE_CHUNK_LEN = 3500;

  // Splits text into pieces no longer than maxLen, preferring to break at a
  // paragraph boundary, then a line break, then a space — only falling back
  // to a hard mid-word cut if none of those exist within range. Single
  // short texts (the common case) come back as a one-element array.
  function chunkText(text: string, maxLen: number): string[] {
    if (text.length <= maxLen) return [text];
    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > maxLen) {
      let splitAt = remaining.lastIndexOf('\n\n', maxLen);
      if (splitAt <= 0) splitAt = remaining.lastIndexOf('\n', maxLen);
      if (splitAt <= 0) splitAt = remaining.lastIndexOf(' ', maxLen);
      if (splitAt <= 0) splitAt = maxLen;
      chunks.push(remaining.slice(0, splitAt).trimEnd());
      remaining = remaining.slice(splitAt).trimStart();
    }
    if (remaining) chunks.push(remaining);
    return chunks;
  }

  // Neutralizes markdown constructs that routinely break Telegram's legacy
  // `Markdown` parse_mode, which this content goes through downstream
  // (webapp.ts sends format: 'markdown'; the API server's Telegram sender
  // uses parse_mode=Markdown, with no escape syntax available in that mode
  // at all — unlike MarkdownV2, an unbalanced or unexpected entity just
  // fails the whole message). Confirmed live 2026-10-24: a video summary
  // with `#`/`##` headers and `*   ` bullet lists (both using the same `*`
  // character bold/italic also uses) produced "can't parse entities" from
  // Telegram, even on the plain-text fallback retry's parse_mode=none
  // attempt failing too the first time around (the raw markdown characters
  // were still visible once it did fall back, which is the "plain text
  // with markdown characters" symptom).
  //
  // This content comes from an external API with its own markdown
  // conventions we don't control and can't assume stay well-formed, so
  // sanitizing before it ever reaches a channel — rather than trusting the
  // LLM to reformat it reliably on relay, which this project has
  // repeatedly found isn't a safe assumption for an exact invariant — is
  // the same "deterministic code, not prose policing" fix applied
  // elsewhere in this investigation.
  function sanitizeMarkdownForTelegram(text: string): string {
    let out = text
      // Headers: drop the leading #'s, keep the text plain.
      .replace(/^#{1,6}\s+/gm, '')
      // Bullet lists using `*` or `-` as the marker: normalize to a plain
      // bullet character so they can't be mistaken for bold/italic markers.
      .replace(/^(\s*)[*-](\s+)/gm, '$1•$2');
    // Backstop: Markdown (legacy) requires every `*`/`_` to pair up across
    // the WHOLE message, not just locally — one stray marker anywhere
    // breaks parsing of the entire message. If the count is odd after the
    // structural fixes above, something is still unbalanced; strip the
    // marker entirely rather than risk another parse failure. Loses bold/
    // italic emphasis in that case, but a readable plain message beats a
    // Telegram API 400.
    for (const marker of ['*', '_', '`']) {
      const count = out.split(marker).length - 1;
      if (count % 2 !== 0) out = out.split(marker).join('');
    }
    return out;
  }

  // In-memory, per-container cache — a "next"/specific-chunk request within
  // the same session shouldn't re-fetch and re-process the entire ~50KB
  // source text from the API just to pull out one more slice. Scoped
  // naturally: this module (and this Map) lives for the lifetime of one
  // container process, which is already one session/one user (confirmed
  // architecture: one session = one container, docs/architecture.md:730),
  // so there's no cross-user sharing risk — it dies with the container,
  // same as everything else here. TTL bounds how long a stale entry can
  // live rather than growing unbounded across a long session that touches
  // many different videos; 15 minutes comfortably covers "stepping through
  // one transcript" without holding content indefinitely.
  const VIDEO_TEXT_CACHE_TTL_MS = 15 * 60 * 1000;
  const videoTextCache = new Map<string, { text: string; fetchedAt: number }>();

  // Shared by all video-content tools: checks the cache, then fetches +
  // extracts + sanitizes if needed. Both the read-into-context path and
  // the direct-delivery path go through this, so they can never diverge
  // on sanitization or caching.
  async function fetchVideoText(kind: 'summary' | 'transcript', videoId: string): Promise<string | undefined> {
    const cacheKey = `${kind}:${videoId}`;
    const cached = videoTextCache.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < VIDEO_TEXT_CACHE_TTL_MS) {
      return cached.text;
    }
    const path = kind === 'summary' ? '/transcriptions/video/summary' : '/transcriptions/video/transcript';
    const field = kind === 'summary' ? 'summary' : 'text';
    // Deliberately omit isSpeakrId — passing the primary DB id (what
    // search_videos exposes as video_id) with isSpeakrId left out makes
    // the server resolve it to the real speakr_id itself
    // (db.getSpeakrIds(id)), confirmed against dev 2026-10-23/24. Do NOT
    // pass isSpeakrId=0 instead of omitting it — confirmed live that the
    // query string "0" does not take the same code path as actually
    // omitting the param (see docs/mondai/video-summary-transcript-
    // findings.md), so this is the one safe form.
    const data = (await apiFetch(path, { id: videoId })) as Record<string, unknown>;
    const raw = data[field] as string | undefined;
    if (!raw) return undefined;
    const sanitized = sanitizeMarkdownForTelegram(raw);
    videoTextCache.set(cacheKey, { text: sanitized, fetchedAt: Date.now() });
    return sanitized;
  }

  // Shared by get_video_summary/get_video_transcript.
  //
  // Returns the full { total_chunks, chunks } array when no chunkNumber is
  // given — fine for an immediate first look and near-term "next" follow-
  // ups, where the array is still fresh in the agent's own context.
  //
  // When chunkNumber IS given, re-chunks and returns just that one chunk
  // as { total_chunks, chunk_number, chunk }. This exists because the full
  // array from an earlier call can't be relied on to still be in context
  // by the time a later request names a specific chunk — confirmed live
  // 2026-10-24: asked for chunk 10 of 18 several turns after the original
  // call, the agent reported it only had "a saved preview" of that old
  // result, not the full thing (large tool outputs from earlier turns get
  // summarized/truncated to manage context size — normal SDK behavior, not
  // a bug). Re-deriving the one requested chunk fresh from a cheap re-fetch
  // + deterministic re-chunking sidesteps that entirely rather than hoping
  // old context survived — chunking is pure/stable given the same source
  // text, so chunk N means the same thing on every call.
  function chunkedResult(text: string, chunkNumber?: number): string {
    const rawChunks = chunkText(text, TELEGRAM_SAFE_CHUNK_LEN);
    const total = rawChunks.length;
    if (chunkNumber !== undefined) {
      const idx = chunkNumber - 1;
      if (idx < 0 || idx >= total) {
        return JSON.stringify({ error: `chunk ${chunkNumber} does not exist — total_chunks is ${total}`, total_chunks: total });
      }
      const body = rawChunks[idx];
      return JSON.stringify({ total_chunks: total, chunk_number: chunkNumber, chunk: total > 1 ? `(${chunkNumber}/${total})\n\n${body}` : body }, null, 2);
    }
    const chunks = rawChunks.map((c, i) => (total > 1 ? `(${i + 1}/${total})\n\n${c}` : c));
    return JSON.stringify({ total_chunks: total, chunks }, null, 2);
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
          return ok(JSON.stringify(withProfileUrls(data), null, 2));
        } catch (e) {
          return err(e instanceof Error ? e.message : String(e));
        }
      },
    },

    {
      tool: {
        name: 'get_member_profile',
        description: 'Fetch a community member\'s profile. Private fields (email, socials, wallet, agent_prefs) are only returned when viewer_auth_id is the same member; for anyone else they come back hidden. Always pass the sender\'s own auth_id (from the message attribute) as viewer_auth_id when the sender is linked; omit it for unlinked senders. To look up the sender themselves, pass their auth_id as both auth_id and viewer_auth_id.',
        inputSchema: {
          type: 'object',
          properties: {
            auth_id: { type: 'string', description: 'The id of the member to fetch: a UUID — the `id` from a search result, the uuid in a profile:<uuid> card callback, or the sender\'s own auth_id for a self-lookup.' },
            viewer_auth_id: { type: 'string', description: 'The id of the person asking (the sender\'s auth_id attribute on the message). Omit if the sender is unlinked (numeric id). Never pass the id of the member being fetched here unless the sender is that member.' },
          },
          required: ['auth_id'],
          additionalProperties: false,
        },
      },
      async handler(args) {
        try {
          const targetId = args.auth_id as string;
          if (!UUID_RE.test(targetId ?? '')) return err(NOT_LINKED_MSG);
          // X-On-Behalf-Of identifies the VIEWER. The API treats viewer === profile
          // owner as a self-lookup and returns private fields, so it must never be
          // set to the target by default. No header => masked (API confirmed 2026-10-26).
          const viewer = typeof args.viewer_auth_id === 'string' && UUID_RE.test(args.viewer_auth_id) ? args.viewer_auth_id : undefined;
          const data = await apiFetch(`/members/${targetId}`, undefined, viewer);
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
            auth_id: { type: 'string', description: 'The member\'s auth_id. Use the sender\'s auth_id attribute on the message' },
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
          if (!UUID_RE.test(authId ?? '')) return err(NOT_LINKED_MSG);
          const data = await apiPatch(`/members/${authId}`, { agent_prefs: prefs }, authId);
          return ok(JSON.stringify(data, null, 2));
        } catch (e) {
          return err(e instanceof Error ? e.message : String(e));
        }
      },
    },

    {
      tool: {
        name: 'get_my_usage',
        description: 'Get the sender\'s recent token / assistant usage statistics (e.g. "how many tokens have I used today"). Works for both linked members (pass their Supabase auth_id, a UUID) and unlinked/anonymous senders (pass their raw platform id, e.g. a numeric Telegram id) — pass whatever the sender\'s auth_id attribute on the message resolves to either way. Pass the ACTUAL id value copied out of this turn\'s message auth_id attribute, e.g. "6e673443-f55b-4a80-8fef-741f42680b9e" — never the literal placeholder text "<user_context.auth_id>" or any other bracketed template string. A call with a value that doesn\'t match a real profile returns a generic unlinked-anonymous default (0 used, 10,000 limit) that looks valid but isn\'t — treat that shape of response as a sign the id passed was wrong, not as the sender\'s real usage.',
        inputSchema: {
          type: 'object',
          properties: {
            auth_id: { type: 'string', description: 'The literal id string from this turn\'s message auth_id attribute (UUID if linked, raw platform id if anonymous) — substitute the real value, do not pass placeholder/template text.' },
          },
          required: ['auth_id'],
          additionalProperties: false,
        },
      },
      async handler(args) {
        try {
          const authId = args.auth_id as string;
          if (!authId || /[<>]/.test(authId)) {
            return err(`auth_id must be the real id value from the message auth_id attribute, not a placeholder (got: ${JSON.stringify(authId)})`);
          }
          const data = await apiFetch('/agent/usage', { user_id: authId });
          return ok(JSON.stringify(data, null, 2));
        } catch (e) {
          return err(e instanceof Error ? e.message : String(e));
        }
      },
    },

    {
      tool: {
        name: 'smart_search_members',
        description: 'AI-ranked search for community experts, builders, and practitioners in a specific domain or skill (e.g. "RWA", "DeFi", "Smart Contracts"). Scores on listed expertise, bio/company context, profile completeness, and Web3 domain synonyms (e.g. RWA ↔ Tokenization), with shared chapter as a tiebreaker. Returns members ranked descending by match_score with conversational match_reasons. Pass the sender\'s auth_id when known — it feeds the chapter-tiebreaker score.',
        inputSchema: {
          type: 'object',
          properties: {
            topic: { type: 'string', description: 'Topic, skill, or domain to search for (e.g. "RWA", "DeFi", "Tokenomics", "Smart Contracts")' },
            min_score: { type: 'number', description: 'Minimum match score to include (optional)' },
            limit: { type: 'number', description: 'Max results to return (default 10, max 50)' },
            auth_id: { type: 'string', description: 'Sender\'s auth_id attribute on the message, if known. Improves chapter-tiebreaker scoring. Omit for anonymous users.' },
          },
          required: ['topic'],
          additionalProperties: false,
        },
      },
      async handler(args) {
        try {
          const { auth_id, ...rest } = args as Record<string, unknown>;
          // A non-UUID id (unlinked sender) crashes the server query — drop it; the
          // search still works, just without the chapter tiebreaker.
          const callerId = typeof auth_id === 'string' && UUID_RE.test(auth_id) ? auth_id : undefined;
          const data = await apiFetch('/members/match', {
            topic: rest.topic as string,
            min_score: rest.min_score as number | undefined,
            limit: rest.limit as number | undefined,
          }, callerId);
          return ok(JSON.stringify(withProfileUrls(data), null, 2));
        } catch (e) {
          return err(e instanceof Error ? e.message : String(e));
        }
      },
    },

    {
      tool: {
        name: 'find_similar_members',
        description: '"Similar to Me": find peers, collaborators, and co-founders based on mutual profile synergy with the sender — complementary skills, shared interests, shared domain background, and same home chapter. Requires the sender\'s auth_id to evaluate synergy against; without it, results fall back to generic availability rather than real personalization. Returns members ranked descending by match_score with conversational match_reasons.',
        inputSchema: {
          type: 'object',
          properties: {
            auth_id: { type: 'string', description: 'Sender\'s auth_id attribute on the message. Required — "similar to me" is evaluated against this member\'s profile.' },
            min_score: { type: 'number', description: 'Minimum match score to include (optional)' },
            limit: { type: 'number', description: 'Max results to return (default 10, max 50)' },
          },
          required: ['auth_id'],
          additionalProperties: false,
        },
      },
      async handler(args) {
        try {
          const { auth_id, ...rest } = args as Record<string, unknown>;
          if (typeof auth_id !== 'string' || !UUID_RE.test(auth_id)) return err(NOT_LINKED_MSG);
          const data = await apiFetch('/members/match', {
            min_score: rest.min_score as number | undefined,
            limit: rest.limit as number | undefined,
          }, auth_id);
          return ok(JSON.stringify(withProfileUrls(data), null, 2));
        } catch (e) {
          return err(e instanceof Error ? e.message : String(e));
        }
      },
    },

    {
      tool: {
        name: 'explain_match_scoring',
        description: 'Fetch the live, plain-language rules for how member match scores are calculated. Call it only when the user asks what a match score means, why a member scored as they did, or how to rank higher. mode "similar" explains "Similar to Me"; mode "topic" explains topic / smart search; omit mode to get both. Explain using only what this returns — do not state point values or rules from memory.',
        inputSchema: {
          type: 'object',
          properties: {
            mode: { type: 'string', enum: ['similar', 'topic'], description: '"similar" for find_similar_members results, "topic" for smart_search_members results. Omit for both.' },
          },
          additionalProperties: false,
        },
      },
      async handler(args) {
        try {
          const data = await apiFetch('/members/match/scoring', { mode: args.mode as string | undefined });
          return ok(JSON.stringify(data, null, 2));
        } catch (e) {
          return err(e instanceof Error ? e.message : String(e));
        }
      },
    },

    {
      tool: {
        name: 'get_app_links',
        description: 'Get the CryptoMondays web app links for this environment: the sign-up/log-in page and the onboarding page. Call it when you need to send a user to sign up, log in, or finish onboarding. Never type these URLs from memory.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      },
      async handler() {
        if (!APP_URL) return err('App URL is not configured for this environment');
        return ok(JSON.stringify({ home_url: APP_URL, onboarding_url: `${APP_URL}/onboarding` }, null, 2));
      },
    },

    {
      tool: {
        name: 'search_videos',
        description: 'Search the CryptoMondays video archive by keyword. Matches against video titles and descriptions. Use when the user asks about past talks, calls, events, or presentations. Results with has_summary=true include a [View Summary] link — include it in your response so users can open the summary. Each result also carries a trailing "(video_id: N)" — this is for your own use with get_video_summary/get_video_transcript if the user asks for the actual summary or transcript content; strip it out of what you actually show the user, it is not meaningful to them.',
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
            return `${titlePart}${meta.length ? ' — ' + meta.join(' · ') : ''}${summaryLink} (video_id: ${v.id})`;
          });

          const header = total > results.length ? `Showing ${results.length} of ${total} results:` : `${results.length} result${results.length === 1 ? '' : 's'}:`;
          return ok(`${header}\n\n${lines.join('\n\n')}`);
        } catch (e) {
          return err(e instanceof Error ? e.message : String(e));
        }
      },
    },

    // get_video_summary/get_video_transcript: a single tool per content
    // type rather than a separate "send_*" tool, after confirming live
    // 2026-10-24 that having two differently-named tools for the same
    // video_id did NOT work the way the earlier design intended — every
    // observed call used get_video_summary/get_video_transcript (the
    // read-into-context path) even for plain "show me chunk N" requests,
    // never the separate send_video_*_chunk tools, despite their
    // descriptions explicitly saying to prefer those for plain relay. Tool
    // NAME matching ("give me the summary" → a tool literally named
    // get_video_summary) beat the fine print every time — the same lesson
    // this whole investigation keeps re-learning: don't rely on wording to
    // steer a judgment call when you can remove the judgment call instead.
    //
    // Fix: one tool, `read_content` defaults to false/absent — the common,
    // cheap case (deliver the chunk directly, model never sees the text)
    // is now what happens when the model doesn't think hard about which
    // flag to pass, rather than needing it to correctly choose between two
    // tool names. Only an explicit `read_content: true` (because the model
    // actually needs to answer a question about the content) gets the
    // text back into context.
    ...(['summary', 'transcript'] as const).map(
      (kind): McpToolDefinition => ({
        tool: {
          name: `get_video_${kind}`,
          description: `Get the ${kind} of a CryptoMondays call/video. By default (no read_content, or read_content: false) delivers the requested chunk DIRECTLY to the user — use this for a plain "show me the ${kind}"/"show me chunk N"/"next" request; you get back only a short confirmation, not the text, which costs you far fewer tokens. Pass read_content: true ONLY when you actually need to read the content yourself to answer a question about it — that returns the real text (chunked, since ${kind === 'transcript' ? 'transcripts are long, routinely 10+ chunks' : 'a summary can still be multiple chunks'}) instead of delivering it. Call search_videos first to find the video_id. Chunking is always deterministic and cached per video for this conversation — passing a specific chunk number is always a fresh, correct fetch regardless of how long ago you last called this, even for a chunk you already saw earlier.`,
          inputSchema: {
            type: 'object',
            properties: {
              video_id: { type: 'string', description: 'The video_id from a search_videos result.' },
              chunk: { type: 'number', description: '1-indexed chunk number. Defaults to 1 (the start) when delivering directly; required when read_content is true and the user named a specific part.' },
              read_content: { type: 'boolean', description: 'Set true only when you need to read this chunk\'s text yourself to answer a question about it. Omit/false for a plain display request — delivers directly instead.' },
              to: { type: 'string', description: 'Destination name, only relevant when delivering directly (read_content false/omitted). Optional — defaults to the current conversation.' },
            },
            required: ['video_id'],
            additionalProperties: false,
          },
        },
        async handler(args) {
          try {
            const sourceText = await fetchVideoText(kind, args.video_id as string);
            if (!sourceText) return err(`No ${kind} available for this video.`);

            if (args.read_content === true) {
              return ok(chunkedResult(sourceText, args.chunk as number | undefined));
            }

            const rawChunks = chunkText(sourceText, TELEGRAM_SAFE_CHUNK_LEN);
            const total = rawChunks.length;
            const chunkNumber = (args.chunk as number | undefined) ?? 1;
            const idx = chunkNumber - 1;
            if (idx < 0 || idx >= total) {
              return err(`chunk ${chunkNumber} does not exist — total_chunks is ${total}`);
            }
            const body = total > 1 ? `(${chunkNumber}/${total})\n\n${rawChunks[idx]}` : rawChunks[idx];

            const routing = resolveRouting(args.to as string | undefined);
            if ('error' in routing) return err(routing.error);

            const seq = writeMessageOut({
              id: generateId(),
              in_reply_to: getCurrentInReplyTo(),
              kind: 'chat',
              platform_id: routing.platform_id,
              channel_type: routing.channel_type,
              thread_id: routing.thread_id,
              content: JSON.stringify({ text: body }),
            });

            return ok(`Sent chunk ${chunkNumber} of ${total} directly to ${routing.resolvedName} (id: ${seq}). Don't repeat this chunk's text in your own reply THIS turn — it's already been delivered once. This tool can be called again anytime for any chunk, including this same one, if asked again later (e.g. "show me chunk ${chunkNumber} again") — there is no limit on re-delivering a chunk.`);
          } catch (e) {
            return err(e instanceof Error ? e.message : String(e));
          }
        },
      }),
    ),

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
