# NanoClaw → MonDAI API: Consumer Reference

> **As of: 2026-10-23**
> This document should be reviewed and updated whenever endpoints are added, renamed, or removed — on either side of the integration. Update the "As of" date when reviewed.

## Overview

NanoClaw agents call the MonDAI API server (`CM_API_BASE_URL`) via MCP tools exposed inside agent containers. Two source files contain all calls:

- `container/agent-runner/src/mcp-tools/mondai.ts` — members, knowledge base, events, chapters
- `container/agent-runner/src/mcp-tools/opportunities.ts` — opportunities and opportunity types

## Authentication

Every request uses a dual-header auth pattern:

```
Authorization: Bearer <CM_AGENT_TOKEN>   # system_agent role
X-Api-Token:   <CM_API_TOKEN>            # fallback / legacy
X-On-Behalf-Of: <authId>                 # user-scoped operations only (Supabase UUID)
Content-Type:   application/json
```

`X-On-Behalf-Of` is sent for operations that require server-side role enforcement on behalf of the end user. It is omitted for read-only system-level queries.

The `CM_API_BASE_URL` hostname is added to `NO_PROXY` in `src/container-runner.ts:481` so calls bypass the OneCLI credential gateway and auth headers arrive intact.

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `CM_API_BASE_URL` | API server base URL (e.g. `http://192.168.1.50:8888`) |
| `CM_AGENT_TOKEN` | Bearer token — system_agent role |
| `CM_API_TOKEN` | Fallback X-Api-Token header value |

## Endpoint Consumer Map

### Members

| Method | Endpoint | MCP Tool | `X-On-Behalf-Of` | Source |
|--------|----------|----------|-----------------|--------|
| GET | `/members/search` | `search_members` | No | `mondai.ts:92` |
| GET | `/members/{authId}` | `get_member_profile` | Yes | `mondai.ts:124` |
| PATCH | `/members/{authId}` | `update_agent_prefs` | Yes | `mondai.ts:154` |
| GET | `/members/match?topic=` | `smart_search_members` | Optional | `mondai.ts` |
| GET | `/members/match` (no topic) | `find_similar_members` | Yes (required) | `mondai.ts` |
| GET | `/agent/usage?user_id=` | `get_my_usage` | N/A — `user_id` query param carries the identity instead | `mondai.ts` |

**`/members/search` query params:** `name`, `company`, `chapter`, `country`, `tags`, `roles`, `limit`

**`PATCH /members/{authId}` body:** `{ agent_prefs: { ... } }` — partial merge; unspecified keys are preserved.

**`/members/match` query params:** `topic` (omit for "similar to me"), `min_score`, `limit`. Response fields: full profile + `match_score`, `match_reasons`, `shared_interests`, `shared_expertise`. Confirmed live on dev (2026-10-23) that this endpoint applies its own privacy masking (`show_email`/`show_socials`) regardless of the system_agent token's elevated access — unlike plain `GET /members/{id}`, which returns the raw unmasked row. Without `X-On-Behalf-Of`, "similar to me" (`find_similar_members`) degrades to generic availability-based results since there's no viewer profile to evaluate synergy against — `auth_id` is required for that tool for this reason. `smart_search_members` (topic search) still personalizes a chapter-tiebreaker boost from `auth_id` but works without it.

**`/agent/usage`:** accepts GET (`?user_id=`) or POST (`{ "user_id": ... }`) interchangeably; standard `Authorization: Bearer <CM_AGENT_TOKEN>` auth (confirmed — `checkAPIToken.js`'s `extractProvidedSecret` accepts Bearer, `x-api-token`, or `x-shared-secret` interchangeably for this route, so no second credential type is needed here). `user_id` accepts either a Supabase `auth_id` UUID (linked member) or a raw platform id, e.g. a numeric Telegram id (unlinked/anonymous sender) — pass whatever `auth_id` resolves to in `user_context` either way.

**Bug found and fixed 2026-10-24 — the model had no real `auth_id` value to pass.** `user_context`/`roles` are present in the raw inbound content JSON (used internally for routing/sender-id extraction) but `formatSingleChat()` in `container/agent-runner/src/formatter.ts` — the function that renders a message into the text the model actually reads — never surfaced them. The model had nothing to copy from except the literal field-path text in tool descriptions ("the sender's auth_id from user_context"), so it echoed the placeholder string `"<user_context.auth_id>"` back as the argument value. `GET /agent/usage` has no profile matching that string, so it silently returned its generic unlinked-anonymous default (`daily_token_limit: 10000, tokens_used_today: 0`) — a plausible-looking but wrong answer, which is what produced the original "0 of 10,000" symptom. This affected every mondai.ts tool that takes an `auth_id` argument (`get_member_profile`, `update_agent_prefs`, `smart_search_members`, `find_similar_members`, `update_chapter`), not just this one, since none of them ever had a real value either.

**Fix:** `formatSingleChat()` now renders `auth_id`, `status`, and `roles` as attributes directly on the `<message>` tag (e.g. `<message sender="Allan" auth_id="6e673443-..." status="active" roles="admin,member">`), and `container/CLAUDE.md`'s "Membership status" section points at this concretely. `get_my_usage`'s handler also now hard-rejects any `auth_id` containing `<`/`>` as a defense-in-depth guard against a repeat of the placeholder bug.

**Fixed by the API team, 2026-10-24 — `/agent/usage` now reports real anonymous usage.** Originally, the anonymous fallback in `handleUsageRequest` only checked an in-memory `Map` (`getAnonymousUsage`) and always returned `recent_usage: []` rather than querying the database — confirmed live via `curl` (a fresh, never-seen numeric id and the literal placeholder bug both returned the identical static `{"is_linked":false,"daily_token_limit":10000,"tokens_used_today":0,"recent_usage":[]}`). Fixed server-side (`server/routes/agent.routes.js#L975-L1015`): for an unresolved `user_id`, the handler now queries `token_usage` in Postgres directly — `eq('user_id', SYSTEM_ANONYMOUS_ID).eq('external_user_id', String(rawIdentifier)).gte('created_at', startOfDay)` — and returns the 10 most recent real rows in `recent_usage`, same as a linked member gets. **Cap reconciled:** 10,000 is in fact authoritative for anonymous senders (`TELEGRAM_ANONYMOUS_DAILY_LIMIT` in the API server's `.env`) — the "5,000" figure in `docs/mondai/community-bot-mention-filter-and-attribution.md`'s Part 2 confirmation #2 was superseded by this; that doc should be read with 10,000 as the real number. Re-tested 2026-10-24 after the fix: numeric→UUID resolution for a linked sender (Allan's raw Telegram id) still correctly returns his full linked profile/limit; a fresh never-used numeric id correctly returns the zero/empty result (expected, since it genuinely has no usage yet — there's currently no real anonymous sender with actual history in this environment to confirm the populated-history path against, since every session on this agent group so far has come from a single linked member).

**Known gap — single member lookup:** The CM API's own MCP server (member-authenticated, separate from this integration) exposes a `get_member` tool via a masked path (`getMemberSafe()`/`mcp_get_member` RPC). No REST equivalent of that masked lookup is wired in here — `GET /members/{authId}` (`get_member_profile` above) returns the full unmasked row under the system_agent token, which is only safe for self-lookup (sender fetching their own profile). Do not add a "look up another member by ID" tool pointing at this endpoint without first getting a masked REST route from the API side.

---

### Videos

| Method | Endpoint | MCP Tool | `X-On-Behalf-Of` | Source |
|--------|----------|----------|-----------------|--------|
| POST | `/agent/videos/search` | `search_videos` | No | `mondai.ts` |
| GET | `/transcriptions/video/summary?id=` | `get_video_summary` | No | `mondai.ts` |
| GET | `/transcriptions/video/transcript?id=` | `get_video_transcript` | No | `mondai.ts` |

**`POST /agent/videos/search` body:** `{ query: "string", list?: "playlist name", limit?: number, year?: number }`

- `list` defaults server-side to `"Daily Calls Video"`; pass `""` to search all playlists
- Response fields: `id`, `youtube_id`, `speakr_id`, `has_summary`, `title`, `description`, `list`, `recorded_at`, `published_at`, `privacy_status`, `youtube_url` (null for non-public). Also includes `total`, `cache_age_ms`, and effective `list` filter.

**`GET /transcriptions/video/summary` / `GET /transcriptions/video/transcript`:** take `id` (the video's primary DB id — the same `id` field `/agent/videos/search` returns, exposed by `search_videos` as `video_id`) with `isSpeakrId` **genuinely omitted** from the query string — the server resolves the real `speakr_id` from the primary id itself (`db.getSpeakrIds(id)`) when `isSpeakrId` is absent. Do not pass `isSpeakrId=0` instead of omitting it — confirmed live that the string `"0"` is still truthy to the handler's `if (!isSpeakrId)` check and takes the same path as `isSpeakrId=1` (treats `id` as an already-resolved `speakr_id`), not the primary-id lookup path. See `docs/mondai/video-summary-transcript-findings.md` for the full investigation, including a confirmed `id`/`speakr_id` collision case. Response shapes: `{ has_summary: boolean, summary: "<markdown>" }` and `{ text: "<speaker-labeled, timestamped transcript>" }` respectively.

**`read_content` parameter on both tools:** by default (omitted/false) the requested chunk is written straight to `messages_out` (via `resolveRouting`/`writeMessageOut`, exported from `core.ts` for this purpose) instead of being returned to the agent — the model only sees a short confirmation, not the chunk content. Pass `read_content: true` only when the agent actually needs to read the content itself to answer a question about it; that returns the real `{ total_chunks, chunks }`/`{ total_chunks, chunk_number, chunk }` shape instead. (An earlier version of this split direct-delivery into separate `send_video_summary_chunk`/`send_video_transcript_chunk` tools — abandoned 2026-10-24 after confirming live that the model never chose them over the identically-scoped but more-obviously-named `get_video_*` tools; a flag with a safe default removes that choice rather than relying on wording to steer it. See `docs/mondai/video-summary-transcript-findings.md`.) Results are cached per `kind:video_id` for 15 minutes inside the container process, so repeated chunk requests for the same video don't re-fetch the full source text each time.

---

### Knowledge Base

| Method | Endpoint | MCP Tool | `X-On-Behalf-Of` | Source |
|--------|----------|----------|-----------------|--------|
| GET | `/kb/search?q=` | `search_knowledge_base` | No | `mondai.ts:177` |

---

### Events & Chapters

| Method | Endpoint | MCP Tool | `X-On-Behalf-Of` | Source |
|--------|----------|----------|-----------------|--------|
| GET | `/luma/calendar-events` | `get_events` | No | `mondai.ts:200` |
| GET | `/chapters` | `get_chapters` | No | `mondai.ts:263` |
| GET | `/chapters/{id}` | `get_chapter` | No | `mondai.ts` |
| PATCH | `/chapters/{id}` | `update_chapter` | Yes (required) | `mondai.ts` |

**`/luma/calendar-events` query params:** `chapter`, `limit`

**`/chapters` query params:** `name` (partial match), `country`, `status` (`active`\|`inactive`\|`pending`)

**`PATCH /chapters/{id}` body:** `description`, `co_organizers[]`, `luma_link`, `meetup_link`, `image_url` — all optional. Chapter leads may update their own chapter; admins can update any.

Response fields consumed: `events[]` (or root array) — per item: `name`, `url`, `meeting_url`, `start_at`, `timezone`, `city`.

---

### Opportunities

| Method | Endpoint | MCP Tool | `X-On-Behalf-Of` | Source |
|--------|----------|----------|-----------------|--------|
| POST | `/agent/opportunities/search` | `search_opportunities` | Yes (required) | `opportunities.ts:121` |
| GET | `/opportunities` | `list_opportunities` | Optional | `opportunities.ts:142` |
| POST | `/opportunities` | `create_opportunity` | Yes (required) | `opportunities.ts:176` |
| PATCH | `/opportunities/{id}` | `update_opportunity` | Yes (required) | `opportunities.ts:211` |
| DELETE | `/opportunities/{id}` | `delete_opportunity` | Yes (required) | `opportunities.ts:236` |

**`POST /agent/opportunities/search` body:** `{ query: "natural language string" }`

**`POST /opportunities` body:**
```json
{
  "title": "string",
  "description": "string",
  "company": "string (optional)",
  "type_id": "string (optional)",
  "location": "string (required if location_type is onsite/hybrid)",
  "location_type": "remote|onsite|hybrid|none",
  "url": "string (optional)",
  "compensation": "string (optional)",
  "deadline": "ISO 8601 (optional)",
  "status": "pending|approved|rejected (optional, default: pending)"
}
```

**`PATCH /opportunities/{id}` body:** Same fields as POST, all optional — partial update.

**Access notes:** `status` changes require admin role. `delete_opportunity` requires admin role.

---

### Opportunity Types

| Method | Endpoint | MCP Tool | `X-On-Behalf-Of` | Source |
|--------|----------|----------|-----------------|--------|
| GET | `/opportunities/types` | `list_opportunity_types` | Optional | `opportunities.ts:257` |
| POST | `/opportunities/types` | `create_opportunity_type` | Yes (required) | `opportunities.ts:284` |
| PATCH | `/opportunities/types/{id}` | `update_opportunity_type` | Yes (required) | `opportunities.ts:312` |
| DELETE | `/opportunities/types/{id}` | `delete_opportunity_type` | Yes (required) | `opportunities.ts:337` |

**`POST /opportunities/types` body:** `{ name: "string", sort_order?: number, color?: "hex or CSS colour" }`

**Access notes:** All write operations require admin role.

### Email

| Method | Endpoint | MCP Tool | `X-On-Behalf-Of` | Source |
|--------|----------|----------|-----------------|--------|
| POST | `/email/send` | `send_email` | No | `mondai.ts` |

**`POST /email/send` body:** `{ recipients: string | string[], subject: string, htmlBody: string }`

**Access notes:** Admin or sysadmin role required. Agent asks for confirmation before sending to more than 5 recipients.

---

## Error Handling

All MCP tools follow the same pattern:
1. Check `res.ok` — if false, read body as text and throw `"${status} ${statusText}: ${body}"`
2. Catch and return the error string to the agent as tool output
3. Agent surfaces the error to the user

## Webapp Channel (Separate Integration)

The webapp channel adapter (`src/channels/webapp.ts`) has its own separate callback to `WEBAPP_CALLBACK_URL` — this is not a MonDAI API call. See `docs/mondai/planning-summary.md` for the two-secret architecture.

**Callback payload (message):** `{ app_id, thread_id, content, type: 'agent', source: 'agent', timestamp, tokens_used?, model?, user_id? }`

- `tokens_used` — total input + output tokens for the turn (integer)
- `model` — model ID used (e.g. `claude-sonnet-4-6`), extracted from the SDK message stream
- `user_id` — echoed back exactly as received in the inbound `user_id` (bare `auth_id` UUID or bare platform id, never namespaced). Added 2026-10-23 to let group-thread token usage attribute to the actual sender rather than the shared thread — see `docs/mondai/community-bot-mention-filter-and-attribution.md`. Present only when the inbound message that triggered this turn carried one.
