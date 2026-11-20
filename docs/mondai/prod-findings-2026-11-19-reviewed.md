# Prod findings 2026-11-19 — reviewed against the host code (dev)

Source: prod team write-up of 2026-11-19, checked line by line against `src/` on dev
(`local/mondai`). **Verified** = confirmed in code or logs here. Corrections to the original are marked.
No secret values appear here.

## Status summary

| # | Item | Status | Who |
|---|------|--------|-----|
| 1 | Unknown-sender approval cards never reach the approver | Confirmed, plus two defects the original missed | Host (NanoClaw) **and** API |
| 2 | `set_lead` notify returns 401 | **Resolved 2026-11-18** — see section 2 | Done (API fix deployed, verified end to end) |
| 3 | Prod-only state to mirror in dev | Mostly already mirrored | Mixed |
| 4 | Smaller notes | Valid | Agent prompt |

The host changes are all in this repo. The API team needs only the two items under 1B.

## 1. Unknown-sender approval cards

### Verified chain of failure
1. `handleUnknownSender` drops the message and calls `requestSenderApproval`
   (`src/modules/permissions/sender-approval.ts`).
2. **The requester is told "I've sent your access request to an admin" first**, before any approver is
   resolved (sender-approval.ts, "Best-effort notice"). It is sent whether or not a card can be delivered.
   (Original missed this: it is why the user was told approval was requested when it never was.)
3. `pickApprovalDelivery` → `ensureUserDm(approver)` → `webapp.openDM(handle)` →
   `findRecentPlatformIdForHandle` matches `sessions.thread_id LIKE '%<handle>%'`.
   A website-login UUID owner never matches Telegram thread ids (`telegram_<numericId>`), so openDM throws.
   Granting owner to the Telegram id works around it. Verified: the lookup is a thread-id substring match.
4. `adapter.deliver(channel, platformId, null, 'chat-sdk', {type:'ask_question',…})` passes `threadId = null`
   (sender-approval.ts and `requestApproval` in `approvals/primitive.ts` both do this).
5. `webapp.ts deliver()` returns `undefined` when `threadId` is null (logged as an error).
   It does **not throw**, so the caller's `try` succeeds and logs "Unknown-sender approval card delivered".
   **Correction to the original:** "treat `undefined` from `deliver` as failure" is not usable on its own,
   because `postCallback` also returns `undefined` on a *successful* callback whenever the API omits
   `message_id`. The failure has to be signalled by throwing.
6. Even with a thread, `deliver()` sends `content.text` or `JSON.stringify(content)` as markdown, so the admin
   would receive a raw JSON blob with no buttons.
7. The same null-thread path affects every other approval card (`requestApproval`: install_packages,
   OneCLI credential approvals) when the approver is on the webapp channel.

### 1A. Host work (this repo — I will do these)
- **Resolve a thread for approver DMs.** Add an optional `resolveDmThread(handle)` to the channel adapter
  (webapp: most recent session `thread_id` for that handle). `requestSenderApproval` and `requestApproval`
  pass it to `deliver`. The `user_dms` cache stores only the messaging group (shared by every user of the
  bot), so the thread has to be looked up per approver.
- **`deliver()` handles `type: 'ask_question'`.** Send one callback carrying both:
  - `content`: a readable text fallback (sender, chat, "Allow / Deny"), so an API that has not been updated
    still posts a visible message instead of rejecting the callback; and
  - structured fields: `type: 'question'`, `question_id`, `title`, `question`, `options: [{label, value}]`.
- **Throw on failure for approval cards** (null thread, non-2xx callback) so the existing `catch` in
  `requestSenderApproval` runs. Ordinary agent messages keep today's behaviour.
- **Honest outcomes in `requestSenderApproval`:** on failure delete the pending row (so the next attempt can
  retry instead of being deduplicated into silence), log an error instead of "delivered", and only send the
  "request sent to an admin" notice **after** the card is delivered. If delivery fails, tell the requester
  to contact an admin directly.
- Not changing owner resolution (UUID vs Telegram id). Keeping the Telegram-id owner row is the simple,
  explicit fix; identity mapping in the host would be a larger security-relevant change.

### 1B. API work (API team)
1. **Accept `type: 'question'` on `/agent/callback`** and render an inline keyboard from `options`
   (`label` shown, `value` returned). Keep treating a callback with plain `content` as a normal message,
   since the fallback text depends on it.
2. **Forward the button press to NanoClaw `/message`** with `question_id` and `selected_option` (the option
   `value`: `approve` or `reject`), plus `app_id`, `thread_id` and `user_id`.
   **`user_id` must be the pressing admin's own id, the same id that holds the owner/admin role in NanoClaw**
   (the Telegram numeric id for the prod workaround). The host authorizes the click as
   `webapp:<user_id>` and accepts it only if it matches the targeted approver or any admin of the group
   (`hasAdminPrivilege`). A different identity is silently refused.
3. Confirm the host receives `question_id` and `selected_option` (the host handler already supports them).

### 1C. Interim (until 1A and 1B are live)
Manual grant: `./bin/ncl dropped-messages list`, then
`./bin/ncl members add --user <id> --group 2049e126-e974-485d-85aa-29bd855e49d7`.
Lou (`webapp:a7839095-…`) still needs this for the Houston email request.

### Tests (dev)
Unknown sender → card in the approver's Telegram DM; Approve → member row, held message replayed; Deny → no
member row; null thread or callback 401 → no "delivered" log, row removed, requester told it failed.
Host unit tests for the sender-approval path exist (`sender-approval.test.ts`) and will be extended.

## 2. `set_lead` notify 401 — resolved (replaces the original section 2)

- Root cause: the API's notify call sent the onboarding agent's own token (`ONBOARDING_AGENT_SECRET`)
  instead of the host's `WEBAPP_SHARED_SECRET`. Introduced 2026-08-20 ("unify agent secrets") in `/initiate`,
  then copied into the shared helper used by `/initiate` and `set-lead`. Dev worked only because the two
  values happen to be equal there.
- Fix: the notify call now sends the shared secret. No host change, and per-agent isolation is unchanged.
  Deployed to prod 2026-11-18; PHX TEST 31 set-lead notified the agent and the welcome email arrived.
- The original "decide the design" question is therefore answered: the API sends the webapp shared secret.
- **Still open:** welcomes for records that were never sent: PHX TEST 30, Boulder
  (`df8d353b-…`, malformed prospect email — fix first), Guayaquil (`19402e6c-…`), and any real chapter
  where `set_lead` or `/initiate` was used since 2026-08-20. Prod `/initiate` has been 401-ing since then.
  Search the prod API log for "Failed to notify NanoClaw agent. Status: 401" to list them.

## 3. Prod-only state to mirror in dev
- Procedures paragraph ("every tool is a directly callable `mcp__nanoclaw__*` MCP tool, never `ncl`/`Grep`/
  `Bash`; start lookups with `mcp__nanoclaw__onboarding_lookup`"): already in dev's
  `groups/cm-onboarding/onboarding-procedures.md`. Prod's `.BU` backup is not needed in dev.
- Service name: dev is `nanoclaw-v2-333812a3.service`, prod is `nanoclaw.service`. `ncl` on prod is
  `./bin/ncl`; `members add` takes `--group`. Noted for the prod deploy steps.
- The prod DB changes (owner role and `user_dms` row for `webapp:5945384141`; member row in the onboarding
  group) are prod-only data. Do not copy to dev.
- **Container-only changes since the last prod sync** (`onboarding_set_lead`, OB- refs, `cleanEmail`, the
  `notify_skipped_reason` wording) are pushed (`82abc69a`). Prod needs `git pull`, a group restart and `/clear`.
  (A host change from 1A will additionally need `pnpm run build` and a service restart.)

## 4. Smaller notes
- Add a prompt line: the agent cannot see approval routing and must not describe it. Valid.
- The "request sent to an admin" wording is addressed by 1A (notice sent only after delivery).
