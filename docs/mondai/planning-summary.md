# MonDAI Integration — Planning Summary
_Last updated: 2026-05-01_

## What is built and working

- **Webapp channel adapter** (`src/channels/webapp.ts`) — end-to-end working. NanoClaw listens on `POST /message`, delivers agent replies via callback URL.
- **API server integration** — `POST /agent/message` (sends to NanoClaw) and `POST /agent/callback` (receives reply, writes to Supabase `chat_sessions`) already implemented on the API server side.
- **`/members/search` endpoint** — done. Structured filters: `tags`, `name`, `company`, `chapter`, `country`, `roles`, `limit`. Joins `profiles` → `chapters`. Respects `is_public`, `onboarding_completed`, `status != 'pending'`. Conditionally returns socials based on `show_socials`.
- **`/kb/search` endpoint** — confirmed path. Query param: `q` (search string). Used by `search_knowledge_base` MCP tool.
- **Opportunities MCP tools** — fully implemented in `container/agent-runner/src/mcp-tools/opportunities.ts`. Tools: `search_opportunities`, `list_opportunities`, `create_opportunity`, `update_opportunity`, `delete_opportunity`, `list_opportunity_types`, `create_opportunity_type`, `update_opportunity_type`, `delete_opportunity_type`.
- **Full API consumer map** — documented at `docs/mondai/nanoclaw-api-consumers.md`. All endpoints, methods, auth headers, request shapes, and source line references.

---

## Architecture decisions made

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Agent group structure | One agent group for MonDAI | Chapters are user attributes, not isolation boundaries. Users travel between chapters. |
| Knowledge retrieval | Agent calls API server as tools (hybrid) | API server injects static user context per message; agent calls tools for on-demand search |
| Session mapping | Supabase `chat_session_id` → NanoClaw `thread_id` | Preserves per-session conversation continuity |
| Token accounting | API server gates and tracks; NanoClaw reports usage in callback | Keeps token logic in the API server where the limits live |
| Streaming | Deferred to phase 2 | Current callback model (complete messages) acceptable for day-1 |
| Personal LLM mode | Deferred | Out of scope for NanoClaw integration initially |
| Member semantic search (pgvector) | Phase 2 | Structured `/members/search` covers day-1 use cases |
| `/chapters` data source | Migrate from Google Sheets → Supabase (future) | Retire external dependency; chapters table already in Supabase |
| System actions (self-mod) | CLI-only for now | `install_packages` / `add_mcp_server` are operator actions via Claude Code. Users cannot request infrastructure changes via chat in a multi-user system. |
| Content approval flow | Fully async — no callback needed | API server returns `status` on create (`approved` or `pending`). Agent communicates outcome to user and moves on. Session may have terminated by the time admin reviews. MonDAI admin panel owns the workflow. |
| Admin notifications | Move email to API server (planned) | Email system currently lives in the frontend as a Supabase edge function. Moving to API server enables agents to send alerts via a new MCP tool. Unblocked once API endpoint exists. |
| User-initiated connections | Blocked — operator-only | Users cannot ask agents to connect new channels, credentials, or integrations. All channel adapters are host-level and system-wide; credential provisioning is operator-level via OneCLI. |

---

## Known bugs / fixes needed in NanoClaw

### 1. `role` vs `roles` mismatch (webapp.ts)
The API server forwards `roles` as an **array** (`text[]`). `webapp.ts` currently reads a single `role` string:
```ts
const { app_id, user_id, display_name, role, message, thread_id } = body;
```
Needs to change to accept `roles: string[]` and pass it through in the message content.

### 2. User context injection
The inbound payload from the API server should be extended to carry enriched user context so the agent can personalize responses without a separate lookup:
```json
{
  "app_id": "cryptomondays",
  "user_id": "...",
  "message": "...",
  "thread_id": "...",
  "roles": ["member"],
  "display_name": "...",
  "user_context": {
    "home_chapter": "London",
    "home_chapter_country": "UK",
    "expertise": ["defi", "nft"],
    "interests": ["dao", "web3"],
    "badges": ["DAIAA"],
    "token_budget_remaining": 4500
  }
}
```
The API server assembles this from the user's Supabase profile before forwarding. NanoClaw injects it as a system-prompt prefix.

---

## Agent tool set (planned)

| Tool | API endpoint | Purpose |
|------|-------------|---------|
| `search_members` | `GET /members/search` | Find community members by tags, chapter, company, name |
| `search_knowledge_base` | kbai endpoint (TBD) | Semantic search over event summaries and curated content |
| `get_events` | `GET /luma/events` or `/luma/calendar-events` | Upcoming events by chapter/date |
| `get_chapters` | `GET /chapters` | Chapter list with name, country, luma/meetup links |

All tools call the API server using an `API_TOKEN` env var in the NanoClaw container. The container needs network access to the API server.

### Tool authentication
The API server uses `checkApiToken` middleware on most endpoints. NanoClaw container needs `CM_API_TOKEN` (or equivalent) in its env, passed as `Authorization` or site-token header per the API server's existing convention.

---

## What is still undecided / needs clarification

1. ~~**kbai endpoint details**~~ — resolved: `/kb/search?q=`. Wired as `search_knowledge_base`.
2. ~~**API token mechanism**~~ — resolved: dual-header pattern. `Authorization: Bearer <CM_AGENT_TOKEN>` + `X-Api-Token: <CM_API_TOKEN>`. User-scoped operations also send `X-On-Behalf-Of: <authId>`.
3. **Tool call / citation format** — the frontend renders `ToolCall` objects with statuses (`pending`, `running`, `completed`, `error`) and `Citations`. Need to define what NanoClaw includes in the callback payload for the API server to store in `chat_messages`.
4. **`/chapters` migration** — currently from Google Sheets, should move to Supabase `chapters` table. Not blocking day-1.
5. **Conference/attendee matching** — aspirational feature, not in scope yet.
6. **Admin notification endpoint** — email system needs to move from Supabase edge function to API server. Once available, add `send_notification` MCP tool in `mondai.ts`. Enables agent-sent alerts for submission confirmations, admin notices, etc.
7. **Content approval agent behaviour** — MCP tools for `create_opportunity` etc. already receive `status` in the response. Tool descriptions / CLAUDE.md should explicitly instruct the agent to tell users "approved" vs "submitted for review" based on that field. Not yet documented.
8. **API refactor impact** — API server endpoints are being refactored. `docs/mondai/nanoclaw-api-consumers.md` is the reference for all endpoints NanoClaw calls. Review and update that doc (and bump the "As of" date) when any endpoint changes.

---

## NanoClaw v2 core updates
~~Pending upstream v2 core merge~~ — merged. v2 is the current codebase.

---

## Reference files
- `src/channels/webapp.ts` — webapp channel adapter
- `container/agent-runner/src/mcp-tools/mondai.ts` — member, KB, events, chapters tools
- `container/agent-runner/src/mcp-tools/opportunities.ts` — opportunities and types tools
- `docs/mondai/nanoclaw-api-consumers.md` — full API consumer map (endpoints, methods, auth, request shapes)
- `docs/mondai/frontend-summary.md` — Vue/Supabase frontend overview
- `docs/mondai/api_server_summary.md` — API server routes, services, integration points
- `docs/mondai/planning-summary.md` — this file
