# Chapter Onboarding — Cross-Team Sync Questions (Round 1)

Found while reconciling the NanoClaw agent's actual implementation (`groups/cm-onboarding/onboarding-procedures.md`) against two API/webapp-side documents: a "Section 3: Human vs. Agent Responsibilities" table and a "Chapter Onboarding Agent — Manager's Operational Summary." Several real discrepancies surfaced — this doc is meant to be handed to the API/frontend team for reconciliation, expected to take multiple rounds.

Each item below states what the NanoClaw side actually does (verified against the live agent's instructions and, where noted, live transcripts), what the other-side doc claims, and the specific question that needs an answer.

---

## 1. Scheduling architecture — factual correction, not just a question

**Claim in the Manager's Summary Q&A:** an external scheduler (cron, AWS EventBridge, GitHub Actions, or similar) calls `GET /agent/onboarding/daily-summary` / `GET /agent/onboarding/weekly-summary` directly and statelessly.

**What actually happens**, verified — these exact tasks were registered this session:
1. NanoClaw's own `schedule_task` mechanism creates a recurring row in the agent's own session database. This is entirely internal to NanoClaw (cron-parser + a 60-second host sweep) — not AWS/GitHub Actions/system crontab.
2. The recurrence's `prompt` is natural language, not an endpoint call — the actual registered prompt for the daily sweep is `"run flow #6"`.
3. This wakes the agent for a real LLM conversation turn. The agent then exercises judgment across a multi-step flow: `onboarding_stalled` → iterate per-prospect (render/send/advance chains for follow-ups and nags) → search Gmail for `Needs-Admin` mail → call `onboarding_daily_summary` **once, at the end** → relabel emails.
4. `onboarding_daily_summary` does eventually call that REST endpoint — but only as one step the LLM chose to take partway through a larger orchestrated sequence, not as an external scheduler's sole, direct, stateless action.

**Why this matters:** if the API side is designing around "a scheduler hits our endpoint, no context, no judgment in between," that's a real mismatch with what's actually happening — there's a full agentic reasoning step upstream of any given endpoint call, including branching, tool orchestration, and (per other findings this session) occasional real compliance failures in that reasoning step.

**Ask:** please correct this understanding on your side, and let us know if anything was designed assuming the stateless-external-scheduler model.

---

## 2. Verification step — who receives the Champions invite link?

- **Manager's Summary** says: the bot "generates a single-use invite link... and sends it to the prospect" directly.
- **`onboarding-procedures.md` flow #3`** (the agent's actual instructions) has the agent reply with the link **to the admin**, in their own conversation, along with a Luma setup checklist — for the admin to relay manually.

These are meaningfully different security models for a semi-private community channel. **Ask:** which is actually intended? If it should go directly to the prospect, that's a real behavior change needed on the NanoClaw side, not just a doc fix.

---

## 3. Automatic Luma-publication detection — does this exist anywhere?

Two independent API-side docs (the Section 3 table and the Manager's Summary) both describe automatic detection: *"the sweep detects [Luma event] publication... automatically marks the Chapter as Active."*

But `onboarding-procedures.md` flow #5 ("Complete onboarding") is unambiguous: **"Triggered by: an admin saying the chapter's first event is live/published."** This is a manual chat trigger — there is no code in the agent's instructions that polls Luma or detects publication automatically.

**Ask:** does an automatic detection mechanism exist somewhere with no NanoClaw-side visibility — e.g. a Luma webhook hitting the API server directly, bypassing the agent entirely? If so, flow #5's manual-trigger path may now be partially redundant and worth simplifying. If not, this is a real gap between documented and actual behavior that needs resolving one way or the other.

---

## 4. Referral / Request / Planned terminology is inconsistent across sources

- Per direct clarification this round: **`Request`** = a newly submitted, unreviewed chapter. **`Planned`** = reviewed and decided feasible (the state used manually before the agent existed). **`onboarding`** = a newer chapters-table status meaning "actively in the agent-driven pipeline," used instead of leaving a chapter at `Planned` indefinitely.
- The Manager's Summary's step 1 calls the just-entered lead state **"Planned Chapter"** — which, per the above, actually describes what should be called `Request` (unreviewed), not `Planned` (already reviewed).
- Separately, `chapter_onboarding_pipeline.stage` (the table `onboarding-procedures.md`'s stage table documents) starts at `referred` — a third, distinct field on a different table from `chapters.status`, easy to conflate with the `Request`/`Planned`/`onboarding` states above. Neither side currently has a clear record of why `referred` was chosen as that starting value, and it doesn't map cleanly onto `Request`/`Planned`/`onboarding`.

**Ask:** please standardize terminology across API-side docs to match the `Request` → `Planned` → `onboarding` → `active` model, and confirm how (or whether) `chapter_onboarding_pipeline.stage`'s `referred` starting value relates to `chapters.status` at all — they may be intentionally independent, but that should be stated explicitly rather than left implicit.

---

## 5. Three inbound chapter-creation paths, not yet reconciled with each other

There are (at least) three ways a chapter can enter the process, and it's not yet decided how they interact with agent involvement:

- **Path A — webapp "New Request" form**: any member or admin can submit this. Chapter lands at `Request` status, needs review (existing city? existing member? existing inactive chapter with same city?) before being decided feasible.
- **Path B — admin panel direct creation**: an admin creates a chapter record directly and can click a button to flip status to `onboarding` "outside agent creation" — meaning the pipeline entry can be created without the agent ever being invoked.
- **Path C — Telegram chat** ("create a new chapter for X"): today's actual `onboarding_create` trigger (flow #1), always chat-driven.

**Open questions, needing explicit decisions:**
- **Path A:** should the existing-city/existing-member/existing-inactive-chapter checks be a deterministic API-side check (no LLM judgment at all), an agent-assisted proposal (agent surfaces findings, human decides), or fully agent-autonomous for clean/unambiguous cases? Given a real duplicate-record incident already happened this session from an imperfect automated lookup (see item 6), we'd lean toward keeping a human in the loop for the final call, at minimum for now.
- **Path B:** if a chapter enters `onboarding` via the admin-panel button (bypassing the agent), does the agent still need to be invoked afterward to send the invite email — via some new event/webhook-triggered wake mechanism that doesn't exist today — or does the API server send that email itself for this path? This determines whether new NanoClaw-side trigger infrastructure is needed at all.
- **Path C:** `onboarding-procedures.md` already has a prose instruction telling the agent to check for duplicates before creating — should this same check also gate Path A/B, or is admin say-so via direct chat request considered sufficient grounds to skip it? Given everything else found this session about prose-instruction reliability (see the companion incident log — repeated cases of the agent not reliably following "always check X first" instructions even when explicitly told), we would not treat this prose check alone as a strong guarantee against duplicates; a server-side uniqueness constraint would be more robust regardless of the answer here.

---

## 6. Backfilling ~20+ existing "Planned" chapters — no current mechanism, and a real risk to flag

There are 20+ real chapters currently sitting in `Planned` status with various amounts of onboarding activity already done manually (outside any tracked pipeline). The hope was that the agent could look at which fields are populated plus record age and infer what step each one is actually at.

**Checked, does not currently exist on the NanoClaw side:**
- Neither existing scheduled task (`onboarding-reply-poll`, `onboarding-daily-sweep`) has any visibility into bare `chapters` records — both only ever operate on rows that already exist in `chapter_onboarding_pipeline`, i.e. only chapters that already went through `onboarding_create`.
- The existing `onboarding_list` MCP tool likely can't see chapters without a pipeline row at all — this may need a new API endpoint/filter to even query.

**A risk worth naming directly, not just a technical gap:** inferring pipeline stage from partial, ambiguous legacy field-population data is real judgment on ambiguous input — a materially harder and riskier task than anything currently automated. This session already produced one concrete incident of automated/imperfect matching creating a duplicate record against real data (a mismatched email lookup created a second pipeline row for the same chapter, discovered and root-caused by the API team after the fact). Given the consequence of a wrong inference here is a real email going to a real prospect at the wrong stage, or worse, an admin's manual progress being silently overwritten — **we'd recommend the agent propose what it believes each record's stage/next-step should be, with an admin confirming before any action is taken automatically, at least for this initial backfill.**

**Ask:** does the API side have an endpoint that can list chapters by status regardless of pipeline-row existence? And is propose-then-confirm an acceptable design for this specific backfill, or is there appetite for more autonomy here?

---

## 7. Production's onboarding settings are still on dev/default values — separate, but time-sensitive

Not a sync-gap between docs, but worth including since it's live-blocking: production's `/agent/onboarding/settings` row still shows `"environment":"development"` (likely gates the `[DEV TEST]` email-subject prefix seen throughout dev testing — if left as-is, real production emails would carry that prefix), empty `admin_notify_telegram_ids`, empty `cal_mgr_telegram_id`, and a stray leading space in `meeting_link`. This connects directly to the Manager's Summary's "Shared Sandbox Safety" section, which confirms this `environment`/override mechanism is the intended safety net — meaning it needs to actually be configured correctly per-environment before any real prospect gets a live email from production.

**Ask:** who owns setting these to real production values before go-live — the API/admin-dashboard side, or does NanoClaw need to do this via a direct DB update?

---

## Suggested next step

Given the number of open items, a short joint working session (both sides reviewing this doc together) is probably more efficient than resolving these async in writing. Happy to walk through the NanoClaw-side behavior for any of these live.
