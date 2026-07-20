# Chapter Onboarding: Gmail Integration — Polling, Not "Channel Mode"

> Companion to [chapter-onboarding-mcp-server.md](chapter-onboarding-mcp-server.md). Written from the NanoClaw side to correct an assumption in the original plan and give the frontend/API side a concrete mechanism to design against.

## What changed

The original plan assumed **"Gmail Channel Mode"** — incoming email to `onboarding@cryptomondays.io` (now `mondai@cryptomondays.io`) waking the `cm-onboarding` agent directly, the same way a Telegram message or webapp message does.

That mechanism doesn't exist in NanoClaw v2. `/add-gmail-tool` wires Gmail in as an **MCP tool** only (`search_emails`, `read_email`, `send_email`, `modify_email`, labels, filters, etc.) — the agent can act on the inbox when it's awake, but nothing wakes it when new mail arrives. A real inbound-email channel (`src/channels/gmail.ts`, push or poll, routed through the normal messaging-group/session flow) was never ported from v1 to v2's channel architecture.

**Decision: use scheduled polling for Phase 1.** No new NanoClaw engineering required — this uses two primitives that already exist and work in plain API-key mode (no claude.ai login needed):

- `schedule_task` MCP tool — lets the agent register a cron-style recurring wake (e.g. `"*/10 * * * *"` for every 10 minutes).
- `search_emails` / `read_email` / `modify_email` (Gmail MCP tools) — called on each wake to check for new relevant mail.

## Mechanism

Each wake cycle: agent calls `search_emails` with a query scoped to what it's looking for, processes any matches, then labels each processed message so it isn't picked up again.

This naturally supports **multiple independent pollers with different intervals and different content filters** running against the same inbox — which is the shape you asked about:

| Poller | Interval | Search query (example) | Action |
|---|---|---|---|
| Prospect reply handling | every 5–10 min | `to:mondai@cryptomondays.io -label:onboarding-handled -from:noreply` | Look up sender via `POST /agent/onboarding/lookup`, advance stage, reply |
| Luma registration forwards | every 15–30 min | `subject:"registered" from:notifications@lu.ma -label:luma-handled` | Parse/forward registration data (future workflow) |
| Daily digest / stalled sweep | once daily, 9am | n/a (uses `onboarding_stalled`, not Gmail) | Already covered by the existing sweep task |

Each poller is just a separate `schedule_task` registration with its own recurrence and a distinct Gmail search query/label pair — they don't need to know about each other. Non-overlapping queries are naturally safe; if two pollers' queries *could* match the same message, apply per-poller labels (`onboarding-handled`, `luma-handled`, etc.) so each poller only ever processes a message once, and a message matched by both pollers gets handled by each independently without double-processing by either.

**No new API endpoint needed for this.** The `lookup` endpoint from the original plan is unchanged and still does the work of resolving a sender to a pipeline record; polling only changes *what wakes the agent*, not what it calls once awake.

## Why not build the real channel (for now)

A proper Gmail channel adapter (Gmail API `watch` + Google Cloud Pub/Sub push, or even just a polling channel wired into `src/channels/`) would give near-real-time wake instead of poll-interval latency. That's legitimate future work, but:

- It's real NanoClaw engineering (a new channel adapter), not a config step.
- **If a push/webhook model is ever built, it needs a single ingestion point with routing/dedup ("flight control") in front of it** — a webhook delivers one event; if multiple pollers/workflows care about the same inbox, something has to fan that single push out to the right handler(s) rather than each handler registering its own webhook against the same mailbox. The current polling model sidesteps this entirely because each poller independently decides what it cares about via its own search query — there's no shared entry point to coordinate.
- Poll-interval latency (5–15 min) is acceptable for a human-paced workflow like chapter onboarding — nobody expects an instant auto-reply to an onboarding email.

Revisit the real channel only if/when sub-minute responsiveness becomes an actual requirement, or when more than one email-triggered workflow across NanoClaw would benefit from sharing one ingestion point.

## Setup checklist (NanoClaw side)

1. Connect `mondai@cryptomondays.io` in OneCLI (`onecli apps get --provider gmail`, connect via web UI, scopes `gmail.readonly` + `gmail.modify` + `gmail.send`).
2. Register the `gmail` MCP server on the `cm-onboarding` agent group only (`ncl groups config add-mcp-server`) — scopes the tool to just this agent, not the whole install.
3. Set up Gmail filters/labels ahead of time (`create_filter`, `create_label`) so incoming mail is pre-sorted where possible, reducing what each poller's search query has to do.
4. Register one `schedule_task` per polling workflow (prospect replies, Luma forwards, etc.), each with its own recurrence and search scope.
5. Repeat OneCLI connection + MCP registration separately for the prod NanoClaw instance (separate vault, separate container).

## Nothing changes on the API side

`cm-data-api`'s `/agent/onboarding/*` endpoints are unaffected by this — `lookup`, `advance`, `render-template`, etc. all work identically regardless of what triggered the agent to call them. This doc only replaces the "Gmail Channel Mode" trigger description in the original plan's Task Flow #3 and Agent Identity sections with the polling mechanism above.
