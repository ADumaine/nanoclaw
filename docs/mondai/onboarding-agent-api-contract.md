# Chapter Onboarding — Agent/API Contract

**Status: CONFIRMED by both sides, 2026-08-07.** All checklist items below reviewed and implemented API-side. This document exists because of a real, costly misunderstanding on 2026-08-06/07: the API side believed NanoClaw "actively monitors the `chapter_onboarding_pipeline` table" and reacts to stage changes; it doesn't, and never has. NanoClaw only acts in response to (a) a real chat message, (b) a scheduled task firing, or (c) an inbound `POST /message` to its webapp channel. This doc is the single place both sides agree on what actually triggers what, so assumptions like that don't happen again.

**Update, 2026-08-10 — the LLM agent no longer handles this trigger at all.** Across several live tests this exact flow failed in unrelated ways each time (a false "sent" claim with no real Gmail call ever made; separately, the agent asking for confirmation instead of just acting on an unambiguous instruction) despite the sequence being purely mechanical with no judgment call in it. NanoClaw now intercepts this trigger on the host, before any session or container is involved, and runs it as a deterministic script (`src/modules/onboarding-dashboard/index.ts` → the `onboarding-dashboard-trigger` skillscript skill: fetch the pipeline record, branch on its stage, send the welcome email iff `invited`). **The payload contract below is unchanged** — same `app_id`, `thread_id`, and `message` shape, same `POST /agent/callback` reply. Nothing needs to change API-side; this note is only so "how does the agent decide what to do here" points to the right place going forward.

## Two ways a chapter reaches the onboarding agent

### 1. Conversational (admin talks to the bot directly — Telegram or the admin dashboard's chat panel)

The admin describes a prospect or names an existing chapter in plain language. **In this path, and only this path, the agent itself calls the CM API** (`onboarding_create` for a brand-new prospect, or `onboarding_evaluate`/`onboarding_initiate` for an existing manually-run or inactive chapter) — because nothing else has touched the API yet. This is `onboarding-procedures.md` flows #1 and 1b. No API-side action is required to support this path; it already works this way today.

### 2. Dashboard-triggered (frontend has already called the API)

The admin dashboard's own UI — either the "new chapter" form or an existing chapter's "start onboarding" action — calls `POST /agent/onboarding/initiate` **first**, creating/transitioning the pipeline record before anything is sent to the agent. Only after that succeeds does the dashboard's onboarding chat panel become available (gated on `status === 'onboarding'`). The agent is then notified separately, via a `POST /message` to NanoClaw's webapp channel.

**This is the part that needs to work correctly, and the part this doc is really about.**

## What `POST /message` must contain to trigger dashboard processing

Sent to NanoClaw's webapp endpoint (same endpoint the admin dashboard's chat panel itself uses):

```json
{
  "app_id": "cm-onboarding",
  "thread_id": "<chapter_id>",
  "user_id": "<the admin who took the dashboard action, or a stable system identifier>",
  "message": "[SYSTEM: dashboard-chapter-onboarding]\npipeline_id: <pipeline_id>"
}
```

Field-by-field:

| Field | Required | Value | Why |
|---|---|---|---|
| `app_id` | Yes | Literally `cm-onboarding` | Reuses the admin panel's existing webapp messaging group — already wired to the Chapter Onboarding agent group, already has a reply destination registered. No new NanoClaw-side wiring needed. |
| `thread_id` | Yes | The chapter's UUID | Matches the admin panel's existing per-chapter session convention (`thread_id = chapterId`) — this system message lands in the same conversation an admin would see if they opened that chapter's own dashboard panel. |
| `user_id` | Yes | Any stable identifier | cm-onboarding treats every sender as an admin already (no membership-tier gating), so this matters less for permissions than on the community agent — but the field is required by the endpoint regardless. |
| `message` | Yes | See below | This is the only field NanoClaw's agent actually reads as visible text — everything the agent needs to know must be in here. |

### Why `message` has to look like this, specifically

We confirmed by reading NanoClaw's own message-formatting code (`container/agent-runner/src/formatter.ts`) that **only `message` (plain text) is guaranteed to reach the agent's visible prompt.** Other fields the webapp endpoint accepts — `user_context`, `roles` — are stored but never rendered into what the agent actually sees, despite some of this agent's own instructions incorrectly assuming otherwise. Don't rely on any field except `message` to carry information the agent needs to act on.

`message` must:
1. Start with the literal line `[SYSTEM: dashboard-chapter-onboarding]` — this is the fixed marker the agent's instructions pattern-match on to know this is a system trigger, not a human describing a new prospect (which would otherwise read like a request to create a *new* record).
2. Include `pipeline_id: <the real pipeline record's id>` on its own line. This is the only data field required — the agent looks everything else up itself (current stage, `profile_state`, prospect name/email) via `onboarding_get`.

**Do not include `chapter_id`, prospect name, or prospect email in this message** — they're unnecessary (the agent fetches them) and every additional field is one more thing that could drift out of sync with the real record. Single source of truth is the pipeline record itself, fetched live.

## What happens on receiving this (as of 2026-08-10, code-enforced — see the update note above; previously agent-promised, now a deterministic script)

1. It calls `GET /agent/onboarding/get/:id` on the given `pipeline_id` — nothing else, no `create`/`evaluate`/`initiate` — since this trigger's entire premise is that the record already exists. If that premise is ever false, calling this trigger against a not-yet-existing record is a bug on the API side; the script does not create one itself.
2. It branches strictly on the real `stage` value returned, not on any assumption about what the dashboard "should" have set:
   - **`invited`** → sends the appropriate welcome email (template chosen by `profile_state`) and stops. No stage advance call — the record is already at the right stage.
   - **`needs_attention`** → sends nothing. Relies entirely on the record's own `needs_attention` note/flag being surfaced through the existing admin-review path (action log, UI badge, daily sweep digest) — there is no confirmation exchange for a dashboard-triggered message, since there's no guarantee an admin is actively watching when this fires.
   - **Any other stage** (`meeting`, `verified`, `nagging`, etc.) → just records/reports it; does not proactively act or send anything.

## Confirmed by the API team, 2026-08-07

- [x] **Pre-message endpoint execution.** `POST /agent/onboarding/initiate` is always called first by the frontend, for both new chapters and existing-chapter switches. The dashboard never messages the agent until the pipeline record exists and chapter status is `'onboarding'`.
- [x] **Dispatch mechanism & `user_id`.** Immediately on successful initiate, the API server sends `POST ${NANOCLAW_URL}/message` asynchronously (fire-and-forget, doesn't block the frontend response). `user_id: req.user?.id || 'system'` (the logged-in admin, falling back to `'system'`), `app_id: cm-onboarding`, `message` exactly as specified above.
- [x] **`needs_attention` notes.** Whenever stage is set to `needs_attention`, a descriptive reason (e.g. *"Manual Onboarding Switch: Missing chapter lead email address."*) is always generated and saved to `stage_notes` — reliable for both the dashboard indicator and the agent's own relay of it.
- [x] **Failed/retried message guard.** The dispatch is a genuine fire-and-forget `fetch` (errors logged, no automatic retry) — no risk of the backend itself generating duplicate trigger messages.
- [x] **Agent-initiated `needs_attention` now round-trips correctly.** Previously `advanceStage` cleared the flag when transitioning *away* from `needs_attention` but never set it to `true` when transitioning *into* it via the agent's own `onboarding_advance` call — meaning if the agent itself ever flagged a case as needing attention, the flag silently never appeared in the UI. Fixed: setting stage to `needs_attention` via `/agent/onboarding/advance` now sets the flag on the `chapters` table, and the agent's `notes` parameter is logged as a chapter activity note in the UI Actions log.

The last item surfaces an open design question — see below.

## Resolved: the agent now proactively uses its own `needs_attention` capability

Decided 2026-08-07 — added to `onboarding-procedures.md`'s "Important behaviors" as a general, cross-flow rule (not specific to any one flow): whenever the agent hits a real blocker it can't resolve itself and can't resolve by asking the person it's already talking to — an undeliverable/bounced send, a malformed Luma link, an admin instruction it can't safely interpret, or a clarifying question that went unanswered before the session moved on — it calls `onboarding_advance` to `needs_attention` with a specific `notes` value describing exactly what's blocked, rather than only mentioning it in a chat reply nobody may see. Deliberately scoped to genuine dead ends, not routine clarifying questions or the stage-mismatch confirmations the agent already asks for elsewhere — the boundary is "can this actually be resolved by asking the person here right now," not general uncertainty.

## Known history this design is meant to prevent recurring

- **Duplicate pipeline records**: this project has hit this class of bug before (a dedup-by-city mismatch created a duplicate record under a different name). The dashboard-trigger flow's hard rule against ever calling `create`/`evaluate`/`initiate` exists specifically to make this structurally impossible for this path, not just discouraged.
- **The "agent watches the table" misunderstanding** (2026-08-06/07): documented at the top of this file — worth keeping here as the concrete example of why this document exists, not just an abstract concern.
- **The "thread_id should point at Telegram" misunderstanding** (2026-08-09): API side briefly changed `thread_id` to a Telegram-group-shaped value, believing the dashboard-triggered session needed to route through the Telegram admin channel for the agent's reply to be visible. It doesn't — `app_id: cm-onboarding` always routes to the admin-panel webapp channel regardless of `thread_id`'s contents (`thread_id` is only a session-isolation key within whichever channel `app_id` selects, never itself a routing signal), and the reply was always landing correctly in `chat_sessions` via `/agent/callback` for the admin panel's own chat display. Reverted; `thread_id: <chapter_id>` confirmed still correct. Also clarified in the same exchange: the agent does not "prepare a payload" for the API side to send — it calls `mcp__gmail__send_email` itself and only reports success after that call actually returns success (flow 1c step 3). **Open question raised by this exchange, not yet resolved:** does the dashboard's "invitation sent" UI text fire on the `initiate` response (before the agent has even attempted the send), or on confirmation derived from the agent's actual callback? If the former, that's a plausible root cause for a "sent but never received" report with no bug on NanoClaw's side — success would be getting declared before the real send is even attempted, with no path for a later agent-side failure (or `needs_attention`) to retract it.
