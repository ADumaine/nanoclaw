# 07 — MonDAI MCP Tools

## Intent

Two new MCP tool files registered in the agent-runner when `CM_API_BASE_URL` is set. These give the community agent access to the MonDAI API (members, events, chapters, opportunities). Tools are only registered at container startup — if the env var is absent, they silently skip registration.

## Files

- `container/agent-runner/src/mcp-tools/mondai.ts` — **copy verbatim** from main tree (449 lines)
- `container/agent-runner/src/mcp-tools/opportunities.ts` — **copy verbatim** from main tree (364 lines)

## Registration in index.ts

**File:** `container/agent-runner/src/mcp-tools/index.ts`

Add these two imports (they self-register when imported, guarded by `if (BASE_URL)`):

```typescript
import './mondai.js';
import './opportunities.js';
```

## mondai.ts — Tool summary

Registered only when `CM_API_BASE_URL` is set. Auth uses dual-header pattern: `Authorization: Bearer <CM_AGENT_TOKEN>` + `X-Api-Token: <CM_API_TOKEN>` + optional `X-On-Behalf-Of: <auth_id>` for user-scoped operations.

Tools:
- `search_members` — search by name, company, chapter, country, tags, roles
- `get_member_profile` — fetch full profile including `agent_prefs`
- `update_agent_prefs` — merge-patch into `agent_prefs` field
- `search_videos` — keyword search YouTube archive; results with `has_summary=true` include `[View Summary](${CM_APP_URL}/video/summary?id=...)` link
- `get_events` — upcoming events from Luma, optional chapter filter
- `get_chapters` — chapter list with optional name/country/status filters
- `get_chapter` — single chapter by UUID
- `update_chapter` — update description, co-organizers, links (chapter lead or admin)
- `send_email` — send via Mailgun (admin/sysadmin only; confirm if >5 recipients)
- `search_knowledge_base` — **disabled** (commented out, pending KB setup)

**Env vars required:**
- `CM_API_BASE_URL` — MonDAI API server base URL
- `CM_AGENT_TOKEN` — NanoClaw shared secret (system_agent role); falls back to `CM_API_TOKEN`
- `CM_API_TOKEN` — X-Api-Token header value
- `CM_APP_URL` — public webapp URL for absolute summary links

## opportunities.ts — Tool summary

Registered only when `CM_API_BASE_URL` is set. Same dual-header auth pattern.

**Membership gate:** Tools that write data (`create_opportunity`, `update_opportunity`, `delete_opportunity`) block `anonymous` and `pending` users with a friendly error message directing them to register.

Tools:
- `search_opportunities` — natural language search via `/agent/opportunities/search`
- `list_opportunities` — full list via `GET /opportunities`
- `create_opportunity` — `POST /opportunities` (active members only)
- `update_opportunity` — `PATCH /opportunities/{id}` (active members only)
- `delete_opportunity` — `DELETE /opportunities/{id}` (active members only)
- `list_opportunity_types` — get type list for `type_id` lookups
- `create_opportunity_type` — admin: add type
- `update_opportunity_type` — admin: rename/reorder type
- `delete_opportunity_type` — admin: remove type

All write tools accept `auth_id` and `user_status` parameters (from `user_context` in the message). The `user_status` check happens in the tool handler before any API call.
