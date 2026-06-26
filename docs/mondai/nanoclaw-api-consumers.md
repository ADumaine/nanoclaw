# NanoClaw → MonDAI API: Consumer Reference

> **As of: 2026-05-02**
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

**`/members/search` query params:** `name`, `company`, `chapter`, `country`, `tags`, `roles`, `limit`

**`PATCH /members/{authId}` body:** `{ agent_prefs: { ... } }` — partial merge; unspecified keys are preserved.

---

### Videos

| Method | Endpoint | MCP Tool | `X-On-Behalf-Of` | Source |
|--------|----------|----------|-----------------|--------|
| POST | `/agent/videos/search` | `search_videos` | No | `mondai.ts` |

**`POST /agent/videos/search` body:** `{ query: "string", list?: "playlist name", limit?: number, year?: number }`

- `list` defaults server-side to `"Daily Calls Video"`; pass `""` to search all playlists
- Response fields: `id`, `youtube_id`, `speakr_id`, `has_summary`, `title`, `description`, `list`, `recorded_at`, `published_at`, `privacy_status`, `youtube_url` (null for non-public). Also includes `total`, `cache_age_ms`, and effective `list` filter.

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

**Callback payload (message):** `{ app_id, thread_id, content, type: 'agent', source: 'agent', timestamp, tokens_used?, model? }`

- `tokens_used` — total input + output tokens for the turn (integer)
- `model` — model ID used (e.g. `claude-sonnet-4-6`), extracted from the SDK message stream
