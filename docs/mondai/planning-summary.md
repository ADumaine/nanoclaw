# MonDAI Integration — Planning Summary
_Last updated: 2026-04-23_

## What is built and working

- **Webapp channel adapter** (`src/channels/webapp.ts`) — end-to-end working. NanoClaw listens on `POST /message`, delivers agent replies via callback URL.
- **API server integration** — `POST /agent/message` (sends to NanoClaw) and `POST /agent/callback` (receives reply, writes to Supabase `chat_sessions`) already implemented on the API server side.
- **`/members/search` endpoint** — new, done. Structured filters: `tags`, `name`, `company`, `chapter`, `country`, `roles`, `limit`. Joins `profiles` → `chapters`. Respects `is_public`, `onboarding_completed`, `status != 'pending'`. Conditionally returns socials based on `show_socials`.
- **kbai endpoints** — new (details TBD — need to confirm exact paths and parameters before wiring agent tools).

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

1. **kbai endpoint details** — exact paths, request params, response shape. Need before wiring the `search_knowledge_base` tool.
2. **Tool call / citation format** — the frontend renders `ToolCall` objects with statuses (`pending`, `running`, `completed`, `error`) and `Citations`. Need to define what NanoClaw includes in the callback payload for the API server to store in `chat_messages`.
3. **API token mechanism** — confirm how NanoClaw container authenticates to the API server (header name, env var name).
4. **`/chapters` migration** — currently from Google Sheets, should move to Supabase `chapters` table. Not blocking day-1.
5. **Conference/attendee matching** — aspirational feature, not in scope yet.

---

## NanoClaw v2 core updates
Pending upstream v2 core merge — apply before building agent tools. Once done, continue from this document.

---

## Reference files
- `src/channels/webapp.ts` — webapp channel adapter
- `docs/mondai/frontend-summary.md` — Vue/Supabase frontend overview
- `docs/mondai/api_server_summary.md` — API server routes, services, integration points
- `docs/mondai/planning-summary.md` — this file
