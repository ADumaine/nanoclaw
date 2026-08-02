# Chapter Onboarding — NanoClaw Reply to API/MonDAI Sync (Round 2)

**From:** NanoClaw side
**In reply to:** API/MonDAI Sync Reply (Round 1)
**Status:** Draft — not yet reviewed internally, not finalized. All original items from Round 1 preserved below in order, each with NanoClaw's verification against actual code/docs/live tests. Nothing in this doc should be treated as agreed or acted on until both teams have reviewed it together.

Where a claim could be checked directly (against `onboarding-procedures.md`, `container/agent-runner/src/mcp-tools/onboarding.ts`, live host logs, or live API test calls made earlier this project), it was — findings are cited with the specific evidence, not asserted from memory.

---

## Item 1 — Scheduling: Who Owns the Cron?

**Round 1 said:** two schedules expected — `*/10 * * * *` (Gmail polling) and `0 9 * * *` (daily sweep). Agent calls `GET /agent/onboarding/stalled` and `GET /agent/onboarding/daily-summary` on each tick.

**NanoClaw verification — two corrections, one addition:**
- The actual registered reply-poll interval is **`*/5 * * * *`**, not `*/10`. Confirmed via the live task registration in host logs (`Scheduled task created ... recurrence="*/5 * * * *"`).
- **A third schedule exists and isn't mentioned**: `onboarding-weekly-summary`, `0 9 * * 1` (Mondays), posting to the Champions channel. This isn't optional — it's already registered and running.
- The reply-poll does not call `/stalled` at all. It runs a local, deterministic pre-task script (`reply-poll-gate.ts`) that talks to Gmail directly via the agent container's own credentials — it only reaches the CM API for messages that already matched an existing pipeline record. `/stalled` is called by the *daily* sweep only.

**On the cold-boot question** — real, not hypothetical: schedule_task rows persist in the session's own database and survive ordinary container restarts. But this already failed once in production-adjacent testing: a host-side TTL sweep misjudged the reply-poll's session as idle (since firing on an empty result never touches "last active") and deleted the whole session, silently losing the registered task until it was manually re-registered. The specific cause found has been patched, but there is no self-healing "agent notices its task is missing and re-registers" behavior — schedules are not bulletproof against every possible loss path, only the one we've found and fixed so far.

---

## Item 2 — Stage List Discrepancy

**Round 1's own reply contains an internal contradiction worth resolving before anything else.** Their "actual DB stages (`friendlyStages` map)" list already reads: `referred, invited, following_up, meeting_scheduled, verified, live_instructions, nagging, active, unresponsive, declined`. But two paragraphs earlier in the same reply, "NanoClaw's actual stage list" is stated as using `luma_created` / `go_live_sent` instead — which is not what NanoClaw uses, and the proposed "canonical" recommendation would revert to that same, different naming.

**What `onboarding-procedures.md` actually says, unedited since 2026-07-17 (direct quote):**

> "Do not invent stage names not on this list, and do not use `go_live_sent`, `luma_pending`, `luma_created`, or `images_requested` — those were considered and rejected in favor of the simpler `live_instructions` above (the moments they'd have marked happen close enough together in practice that separate stages added complexity without a real benefit)."

NanoClaw uses `live_instructions` exclusively, with an explicit rationale on record for why the finer-grained split was rejected. Per Round 1's own stated "actual DB stages," the real API implementation already agrees. **We don't believe there is an actual mismatch between the two live systems** — the discrepancy appears to be in how NanoClaw's list was characterized in the reply, possibly conflated with an old/superseded planning doc. Requesting confirmation of where the `luma_created`/`go_live_sent` attribution to NanoClaw came from, since it doesn't match the current, live procedures file.

**To directly answer the question asked:** NanoClaw uses `live_instructions`. Not `go_live_sent`.

---

## Item 3 — Who Sends the Invite Email?

**Confirmed correct, verified in code.** `container/agent-runner/src/mcp-tools/onboarding.ts` (render_template tool handler) already sends `email` as a top-level parameter alongside `variables` on every call — matches what Round 1 specifies is needed for dev-safety redirect and token auto-fill. No action needed.

---

## Item 4 — `link-luma` Parameters

**Real gap found.** Round 1 states all three fields (`id`, `calendar_url`, `calendar_id`) are required. NanoClaw's actual tool schema currently has `required: ['id', 'calendar_url']` — **`calendar_id` is optional**, and no code exists anywhere to auto-extract a slug from a pasted Luma URL. If the API genuinely requires it, every `link-luma` call where the agent doesn't separately populate it would fail.

**Needs a decision:** either NanoClaw adds slug-extraction logic (parsing the `lu.ma/<slug>` URL), or the API relaxes `calendar_id` to optional/derivable server-side from `calendar_url`.

**Call order, answered precisely** from the documented flow (`onboarding-procedures.md` flow #4, unedited): `onboarding_link_luma` first (this alone transactionally sets stage + saves the URL/ID + logs the activity note — no separate `advance` call for that specific transition) → render+send the go-live email → `get_settings` + notify the calendar manager → **then**, as a distinct, later, explicit call, `advance` to `nagging`. Not simultaneous with the link-luma call, not reversed.

---

## Item 5 — `generate-invite-link` Endpoint Missing

Nothing on our side to verify (API-internal). Open question stands: NanoClaw does not currently have its own direct Telegram bot-token access baked into the onboarding tool layer — today, everything for this agent flows through the CM API. Direct Telegram API calls from NanoClaw would be a new integration pattern for this agent, not a small change. Leaning toward the API-side implementation as described, but this needs an explicit decision, not an assumption either way.

---

## Item 6 — `notify-telegram` Endpoint Missing

**Flagging higher urgency than "add it later."** `onboarding.ts` has already been calling `POST /agent/onboarding/notify-telegram` in real usage this whole project (confirmed in code — this is not new/speculative on NanoClaw's side). If this route has genuinely never existed as Round 1 states, every calendar-manager notification (flow #4) and every decline/reply Telegram alert (flow #2) would have been silently failing since those flows were first used. We checked host-side error logs for direct evidence and found none either way — **inconclusive, not proof of success** — worth the API team checking their own request logs for `notify-telegram` 404s to determine actual impact before treating this as a routine backlog item.

---

## Item 7 — `log-activity` Endpoint

No strong position from the NanoClaw side — this is genuinely the API team's call on scope. The automatic logging from state-change endpoints (`advance`, `link-luma`, etc.) appears to cover what `onboarding-procedures.md`'s documented flows currently need; we don't have a concrete case today for supplemental free-text notes beyond that.

---

## Item 8 — `set-active` Stage Guard

Per the documented flow, the guard should hold naturally without any special handling: flow #4 always explicitly advances to `nagging` as its last step, and `set-active` (flow #5) is only ever triggered afterward by an admin separately reporting the first event went live — meaning by the time `set-active` could ever be called, the record should already be at `nagging`.

**The genuine edge case**: an admin reporting "the event is live" *before* the chapter ever went through the Luma-link flow at all (i.e., no `nagging` transition has happened yet). This is an out-of-order admin request, not really contemplated by the current flow set. NanoClaw already has a general pattern for this class of situation — an instruction requiring the agent to check the record's actual current stage before acting on an ad hoc request that doesn't match the expected sequence, and confirm with the admin rather than silently proceeding or silently failing. We'd lean toward handling this the same way rather than relaxing the server-side guard, but this is a product decision for joint discussion, not something to decide unilaterally from either side.

---

## Item 9 — `render-template` Template Names

**Two of the four names given are wrong, with direct empirical evidence, not just doc disagreement.** All four names were tested live against the real API earlier this project via direct `curl` calls to `/agent/onboarding/render-template`, each returning a successful response with real rendered content:

| Round 1's claimed name | Actually confirmed working (live test) |
|---|---|
| `Chapter Onboarding — Invite` | **`Chapter Welcome`** |
| `Chapter Onboarding — Follow-up` | **`Chapter Onboarding Follow-up`** (no em dash — a plain space) |
| `Chapter Onboarding — Go Live` | matches |
| `Chapter Onboarding — Nag` | matches |

Requesting the API team re-check the live `email_templates` table directly rather than whatever list this reply was generated from — half of the given names would fail if NanoClaw switched to them.

**On the dynamic-discovery question**: given two of four hardcoded names in a fresh cross-team reply were already wrong, we'd lean toward a `GET /agent/onboarding/templates` discovery endpoint being worth building — hardcoding has already demonstrably drifted from reality once.

---

## Item 10 — Admin UI vs. Agent Responsibilities (Step 1)

New, useful clarification — both creation paths converging on the same `/agent/onboarding/create` endpoint with a `409` dedup guard makes sense and matches nothing we'd contradict.

**One piece of history worth surfacing that Round 1 didn't reference**: the `/agent/onboarding/initiate` endpoint mentioned here is the same endpoint already root-caused earlier this project for a real duplicate-record incident — its dedup lookup missed an existing record because it queried by an email address that had since been repointed for testing, creating a second pipeline row against the same chapter (the "Organizer" record). This was reportedly fixed API-side at the time. Given `/initiate` is now being formalized as a first-class, expected path rather than an edge case, worth explicit confirmation that the dedup fix from that incident is durable under the same conditions, not just resolved for the one case that triggered it.

---

## Item 11 — Kill Switch Behavior

**Confirmed real gap, not just a documentation question.** Checked `onboarding-procedures.md` directly — there is no mention anywhere of checking `onboarding_settings.active` before running a sweep or acting on a Telegram command. The agent currently has no kill-switch-checking behavior at all. This needs to be added, not just documented, once the exact expected behavior (log-and-exit on sweeps, specific reply text for Telegram commands) is confirmed as final.

---

## Updated Summary Table

| Item | Round 1 status | NanoClaw verification result |
|---|---|---|
| 1. Scheduling | ✅ claimed correct | ⚠️ interval wrong (5 min not 10), third schedule (weekly summary) omitted entirely |
| 2. Stage names | ❗ claimed 3-way mismatch | ❗ likely no real mismatch — Round 1's own reply self-contradicts; NanoClaw confirmed using `live_instructions` only, matching Round 1's own stated "actual DB stages" |
| 3. Invite email sender | ✅ | ✅ confirmed correct in code |
| 4. `link-luma` params | ✅ documented | ⚠️ real gap — `calendar_id` not required in NanoClaw's schema, no slug-extraction exists |
| 5. `generate-invite-link` missing | ❗ API to build | ❓ needs explicit decision on Telegram-token ownership |
| 6. `notify-telegram` missing | ❗ API to build | 🔴 higher urgency than stated — already in live use, likely silently failing since first used |
| 7. `log-activity` missing | ⚠️ may not be needed | No NanoClaw-side objection to leaving as-is |
| 8. `set-active` guard | ⚠️ requires `nagging` | Should hold naturally per documented flow; genuine edge case needs a joint decision, not a unilateral guard relaxation |
| 9. Template names | ✅ documented | 🔴 2 of 4 names wrong, confirmed via live test — recommend a discovery endpoint given hardcoding already drifted once |
| 10. Dual creation paths | ✅ | ✅ agreed, plus relevant unreferenced history on `/initiate`'s dedup bug worth reconfirming |
| 11. Kill switch | ⚠️ agent must check | ✅ confirmed as a real, currently-unimplemented gap |

---

*Draft for internal NanoClaw review before this goes back to the API/MonDAI team. Nothing here is finalized or committed.*
