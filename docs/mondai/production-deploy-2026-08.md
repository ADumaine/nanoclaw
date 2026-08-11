# Production Deployment Checklist — 2026-08-03

## Split for the 2026-08-04 chapter lead meeting

**Phases 0–1 only, then stop.** A chapter lead meeting on 2026-08-04 showcases the webapp's newer menu system — the goal is code-current and stable for that, without touching cm-onboarding-specific configuration that isn't needed for the demo and hasn't been through a full production test yet.

- **Do now (Phases 0–1)**: general NanoClaw code — nothing in here is onboarding-specific in effect. `container/agent-runner/src/mcp-tools/onboarding.ts` and the skillscript/egress-lockdown changes only ever activate inside the cm-onboarding container (gated on `IS_ONBOARDING_AGENT`/`CM_ONBOARDING_AGENT_GROUP_ID`) — spawning any other agent group's container is unaffected by those files existing. The genuinely cross-cutting pieces are general robustness/security fixes (webapp null-threadId guard, the `disabled_modules` tool-registration fix, the `appId` prefix-stripping fix — see the pre-flight check below), not new features.
- **Pause after Phase 1** — do not proceed to Phase 2 (destination registration, group-file copies, skillscript skill additions) until after the meeting. All of Phase 2 onward is additive and scoped to cm-onboarding; skipping it for now changes nothing about the community webapp's behavior.

### One pre-flight check before Phase 1, specifically because of the meeting

`af7d05b` (one of the 7 pending commits) fixes `appId` derivation for webapp channels — previously every `CM_API_BASE_URL_<app_id>` / `CM_API_TOKEN_<app_id>` / `CM_AGENT_TOKEN_<app_id>` override in `.env` silently never matched for *any* webapp-channel agent group (not onboarding-specific — a real, general bug). After this deploys, any such override that's actually set for the community webapp's app_id(s) will start applying for the first time. Check what's there before deploying:

```bash
# Find the community webapp's app_id(s):
pnpm exec tsx scripts/q.ts data/v2.db "select platform_id from messaging_groups where channel_type='webapp'"
# For each app_id (strip the "webapp:" prefix), check for a matching override:
grep -E "CM_API_BASE_URL_<app_id>|CM_API_TOKEN_<app_id>|CM_AGENT_TOKEN_<app_id>" .env
```

If nothing matches, there's nothing to worry about — the fix is a no-op for the community agent and this is purely closing a latent bug that happened to only matter for cm-onboarding so far. If something *does* match, confirm the override's value is actually correct/current before deploying, since it's about to start being used for real.

**Checked 2026-08-03 — clear.** Production's webapp app_ids: `cm-onboarding`, `cm-tg`, `cm-tgdev`, `cryptomondays`, `cryptomondays-dev`. Only two `CM_*` overrides matched the demo-relevant app_ids (`cryptomondays`, `cm-tg`) at all: `CM_API_BASE_URL_cm-tg`, which is identical to the base `CM_API_BASE_URL` (`http://localhost:8000` both) — activating it changes nothing. `cryptomondays` itself has no override set. (`cryptomondays-dev`'s three overrides and `cm-onboarding`'s one are out of scope — different app_ids, don't affect the demo either way.) Also worth noting: `cm-tg` (the production Telegram bot) isn't fully deployed yet — DM-only, beta testing channel, not in real use — so even a mismatch here would have had limited blast radius. **No blocker for Phase 0–1.**

### No new `.env` values needed for Phase 0–1

Checked every `.env` variable referenced across the 7 pending commits and today's uncommitted diff against the pre-`731e93d` codebase, plus diffed `.env.example` (unchanged since `731e93d`). The only genuinely new variables are `ANTHROPIC_CUSTOM_HEADERS_<folder>` and `CLAUDE_TRANSCRIPT_ROTATE_AGE_DAYS_<folder>` — both optional and only meaningful for cm-onboarding (Phase 2+, not needed for the demo). Everything else the diff touches (`CM_API_BASE_URL`, `CM_AGENT_TOKEN`, `SKILLSCRIPT_RPC_URL`, `NANOCLAW_EGRESS_LOCKDOWN`, `WEBAPP_SHARED_SECRET`, `CM_APP_URL`) already existed before `731e93d` — the fixes change how correctly they're read, not whether they're required. Production's existing `.env` should work as-is for Phase 0–1.

> For whoever (human or Claude session) runs this on the production server. Production is currently at commit `731e93d` (`fix: webapp cold-DM routing, Telegram Markdown escaping, pending-approval notice`, 2026-07-23) — everything below has landed on dev since then and needs to reach production.
>
> Known production state as of this writing (confirm before assuming still true):
> - **cm-onboarding**: partially set up — agent group/some wiring exists, but group files (`onboarding-procedures.md` etc.) were never copied, or are stale from an earlier partial attempt.
> - **skillscript-runtime**: production runs its own separate deployment (per `docs/mondai/chapter-onboarding-skillscript-setup.md`'s per-host setup pattern).
> - **`NANOCLAW_EGRESS_LOCKDOWN`**: off on production.

## Phase 0 — DONE, pushed 2026-08-03

The previously-uncommitted files (skillscript/egress-lockdown fix, `onboarding_evaluate`/`onboarding_initiate`, `disabled_modules` tool-registration fix, `/setup-webapp` destination fix) are now four separate commits on `origin/local/mondai`: `2a62787`, `ad370b4`, `c18b179`, `d7d03ac`. Combined with the 7 commits already ahead of `731e93d`, `origin/local/mondai` is now **11 commits ahead of production's `731e93d`**. Nothing left to do here — proceed to Phase 1.

**Checked every diff for dev-specific hardcoded values (dev IPs, `mondaidev` hostnames, dev tokens) — none found.** Everything reads from `.env`/DB config at runtime; production will pick up its own values automatically. The one thing to be aware of (not a hardcoded dev value, just a convention to match): `SKILLSCRIPT_EGRESS_HOSTNAME = 'skillscript-dashboard'` in `container-runner.ts` assumes production's skillscript container is also named `skillscript-dashboard` — true if it followed the same `docker-compose.yml` pattern documented in the skillscript setup doc.

**No container image rebuild needed anywhere in this batch** — confirmed via diff: nothing in these 11 commits touches `container/Dockerfile` or `container/cli-tools.json`. Host-side build + restart only.

**One more commit exists on dev but is deliberately NOT pushed**: `3c9395d` (`allowed_tools` enforcement fix — a real, separate bug where a group's configured tool restriction was silently never enforced). Held back because it changes real tool availability for the community agent and hasn't been live-tested yet — don't expect it in this pull, and don't go looking for it. Revisit after the meeting.

## Phase 1 — Bring NanoClaw's code current

```bash
git pull origin local/mondai      # picks up all 11 commits ahead of 731e93d
pnpm install --frozen-lockfile
pnpm run build
pnpm exec tsx scripts/upgrade-state.ts set   # only if package.json's version changed since production's last deploy — check first
systemctl --user restart <nanoclaw-unit>     # find with: systemctl --user list-units | grep nanoclaw
```

After restart, confirm the service actually came back clean before moving on — check `logs/nanoclaw.error.log` for anything new, and confirm the community webapp still responds to a real test message end-to-end (not just that the process is running).

> **Resolved — smoke-test artifact, not a real bug (2026-08-03).** Post-deploy test used a human-readable `thread_id` (`post-api-restart-smoke-test`) instead of a real UUID. The API server's session table stores `thread_id` as a Postgres `uuid` column, so the lookup threw `invalid input syntax for type uuid: "post-api-restart-smoke-test"`, surfaced to NanoClaw as a generic `500 {"error":"Database error"}` on `POST /agent/callback`. Confirmed via the API server's own log line. Real production traffic is unaffected — `thread_id = user_id` for actual users, which is a Supabase auth UUID, not a test string. The earlier cm-onboarding occurrence of the identical error was almost certainly the same class of mistake (a friendly test thread_id), not a second independent failure.
>
> **Re-verified with a real thread ID, 2026-08-03 01:59:39 — clean.** Retested using an actual UUID thread (`521d09b9-c2a8-4d94-b711-31ac946ed36d`) instead of a synthetic string: callback delivered with no error, nothing new in `logs/nanoclaw.error.log`. Confirms the earlier `500`s were purely the synthetic-thread_id artifact above, not a real API-server or NanoClaw defect.
>
> **Non-blocking follow-up for the API team:** the endpoint should validate `thread_id` and return `400` for a malformed UUID instead of leaking a raw DB type error as `500` — good hygiene, not urgent, doesn't affect the 2026-08-04 demo since real thread_ids are always valid UUIDs.

**✅ Phase 1 signed off, 2026-08-03 01:59.** Full pipeline verified end-to-end: repo pulled (11 commits, `731e93d` → current), host build clean, service restarted with no new errors, `disabled_modules` tool-registration security gate confirmed closed (`c18b179`, on top of the earlier instructions-only fix `7641ce4` — note `3c9395d`, the separate `allowed_tools` enforcement fix, is deliberately *not* part of this deploy, see Phase 0), community webapp (cryptomondays) and cm-onboarding both replying correctly with real callback delivery confirmed. **Per the split at the top of this doc: STOP HERE for the 2026-08-04 meeting — do not proceed to Phase 2.**

**Why this matters beyond routine catch-up**: one of the uncommitted changes (`config.ts`/`agents.ts`/`self-mod.ts`/`providers/claude.ts`) closes a real gap in the `disabled_modules` security boundary. The earlier fix (already in the 7 pending commits, `7641ce4`) only stopped the agent from being *told about* `self-mod`/`agents` tools via CLAUDE.md instructions — it never actually stopped those tools from being *registered and callable*. If MonDAI's production agent group has `disabled_modules: ["self-mod","agents"]` configured (per earlier deploy notes, it should), those tools have been live and callable on production this whole time despite the config saying otherwise. This deploy is what actually closes that gap — treat it as higher priority than a routine sync, not optional cleanup.

---
**⏸ STOP HERE for the 2026-08-04 meeting.** Everything below (Phase 2 onward) is cm-onboarding-specific, additive, and not needed for the webapp demo — see "Split for the 2026-08-04 chapter lead meeting" at the top. Resume after the meeting.

---

## Phase 2 — Verify/complete cm-onboarding's base wiring

Given cm-onboarding is only "partially set up," check each of these rather than assuming:

```bash
ncl groups list                                          # confirm the Chapter Onboarding agent group exists, note its id
ncl groups config get --id <cm-onboarding-agent-group-id> # confirm cli_scope, disabled_modules etc. as expected
grep -E "CM_ONBOARDING_AGENT_GROUP_ID|SKILLSCRIPT_RPC_URL|CM_AGENT_TOKEN_cm-onboarding" .env
ncl messaging-groups list | grep -i onboarding            # expect two: telegram_onboarding_bot AND the admin webapp panel
```

**If the admin webapp panel messaging group doesn't exist yet**, create it (via `/setup-webapp`, or manually — see `docs/webapp-channel.md`): `app_id` something like `cm-onboarding`, `is_group=1`, `session_mode=per-thread`, `thread_id = chapterId`, `unknown_sender_policy: request_approval` (not `strict` — dev switched to this 2026-07-22 after real friction, see `[[project_chapter_onboarding]]` memory if available, or just use `request_approval` directly).

> **Correction, 2026-08-03/04: the Telegram side is NOT a native NanoClaw Telegram channel.** Earlier drafts of this doc (and the assumption behind "expect a `telegram` destination should already exist" below) treated this as if cm-onboarding had its own NanoClaw-managed bot token, requiring BotFather + `pair-telegram`. That's wrong. The actual architecture: the MonDAI **API server** owns the Telegram bot token, webhook, and all Telegram-specific formatting — NanoClaw never sees a bot token. The API server's `telegram.routes.js` forwards onboarding-bot messages to NanoClaw's existing **webapp channel** (`POST /message`) with a hardcoded `app_id: 'telegram_onboarding_bot'` and `thread_id` formatted as `telegram-group:<chatId>` (or `telegram:<chatId>` for DMs), then reads replies back the same way every other webapp-proxied client does (`POST /agent/callback`). So on NanoClaw's side this is just another `webapp`-channel-type messaging group, exactly like the admin panel above — not a separate channel type, no bot token, no pairing flow.

**Check the reply destination exists — this is the exact bug found and fixed on dev today, and it will silently reproduce here if skipped:**

```bash
ncl destinations list --agent-group-id <cm-onboarding-agent-group-id>
```

Expect destinations for **both** the admin webapp panel and the Telegram-onboarding-bot proxy. If either is missing, create the messaging group + wiring + destination for it. For the Telegram-onboarding-bot proxy specifically (`app_id` is hardcoded API-server-side as `telegram_onboarding_bot` — don't invent a different value):

```bash
# 1. Messaging group — webapp channel_type, platform_id = webapp:<app_id>
ncl messaging-groups create \
  --channel-type webapp \
  --platform-id webapp:telegram_onboarding_bot \
  --is-group 1 \
  --unknown-sender-policy request_approval   # revisit: API server already does its own identity/anonymous-mode gating before forwarding — request_approval may double-gate a legitimate sender. Confirm behavior before trusting this default.

# 2. Wiring — the API server already filters Telegram group messages down to
#    @mentions before ever forwarding to NanoClaw, so every message NanoClaw
#    sees on this thread is already meant for the bot. Use pattern/"." (always-on),
#    not "mention" — NanoClaw will never see a repeated @mention to match on.
ncl wirings create \
  --messaging-group-id <id-from-step-1> \
  --agent-group-id <cm-onboarding-agent-group-id> \
  --engage-mode pattern \
  --engage-pattern "." \
  --session-mode per-thread

# 3. Destination, same pattern as admin_panel below
ncl destinations add \
  --agent-group-id <cm-onboarding-agent-group-id> \
  --local-name telegram \
  --target-type channel \
  --target-id <id-from-step-1>
```

If the admin panel's destination is missing (likely, if the messaging group above was just created, or even if it's older but was set up via `/setup-webapp` before today's skill fix):

```bash
ncl destinations add --agent-group-id <cm-onboarding-agent-group-id> --local-name admin_panel --target-type channel --target-id <admin-panel-messaging-group-id>
```

Takes effect immediately on live sessions, no restart. Without this, the agent can receive messages from either source but every reply silently drops — no error visible anywhere, looks like the agent just isn't responding.

**Separately, on the physical Telegram side (unavoidable regardless of who holds the token — this is Telegram's own requirement, not NanoClaw's):** if swapping dev's bot for a dedicated production bot in the real chapter-leads' Telegram group, add the new bot to the group, remove dev's bot, and turn off Group Privacy for the new bot via `@BotFather → /mybots → bot → Bot Settings → Group Privacy → OFF` — Telegram won't deliver non-mention group messages to any bot, proxied or not, unless this is off. The bot token, webhook registration (`GET /telegram/setup-webhook`), and `TELEGRAM_WEBHOOK_SECRET_TOKEN` all live in the **API server's** config, not this repo — confirm with whoever owns that service that it's pointed at production's URL, not dev's.

## Phase 3 — Copy cm-onboarding's group files (not git-tracked, manual every time)

From the dev host to production, at `groups/cm-onboarding/`:

```
onboarding-procedures.md      # full current version — flow 1b, needs_attention handling
                               #   (both fields), destination-routing fix, daily-sweep
                               #   trigger-ambiguity fix are all in this file, none of it
                               #   travels via git
CLAUDE.local.md                # the @-import wrapper + access-check rules
scripts/reply-poll-gate.ts     # deterministic pre-task script for the reply-poll gate
```

Overwrite whatever's on production for these three — don't try to merge by hand, dev's copy is current. Confirm the `onboarding-reply-poll` scheduled task still has its `script` field pointing at the (now-updated) `reply-poll-gate.ts` contents — if the task already exists, `update_task` to refresh the script rather than leaving it stale.

## Phase 4 — skillscript-cm on production

Full setup reference: `docs/mondai/chapter-onboarding-skillscript-setup.md` (updated today with an "Egress lockdown compatibility" section — **not applicable right now** since production has `NANOCLAW_EGRESS_LOCKDOWN` off; skip that section unless/until that changes).

Check what's actually present on production's skillscript instance — per earlier notes the base render/advance skills were done 2026-07-20/21, but the newer go-live/daily-sweep skills and the Gmail-via-skillscript connector setup were built 2026-07-28, likely *after* production's last skillscript update:

```bash
curl -s -X POST http://localhost:7878/rpc -H "Content-Type: application/json" -d '{
  "jsonrpc":"2.0","id":1,"method":"tools/call",
  "params":{"name":"skill_list","arguments":{}}
}'
```

Expect to see `onboarding-render-email`, `onboarding-advance` (should already be there) and `onboarding-go-live`, `onboarding-daily-sweep`, `onboarding-notify-admins`, `chapter-onboarding-log` (check these specifically — likely missing). **`onboarding-notify-admins` is easy to miss**: `onboarding.ts` never calls it directly (it's not in the `executeSkill(...)` call list), so a check that only greps `onboarding.ts` for skill names won't catch it — it's invoked as a *nested sub-skill* from inside `onboarding-daily-sweep.skill.md` itself (fans a notification out to multiple admins inside a foreach loop, since skillscript doesn't support nested foreach). If `onboarding-daily-sweep` is copied without it, the skill will exist and pass a render-only check, but fail at runtime the first time a real sweep hits an exhausted-prospect/admin-notify branch. If any of the newer three are missing, they need to be written fresh via `skill_write` on production's own skillscript instance (they're not git-tracked anywhere, only ever existed as `skill_write` calls against dev's skillscript RPC) — the full skill source and the Gmail connector wiring (`connectors.json` gmail entry, `onecli run --agent <id> -- gmail-mcp` wrapper, `gcompat`, stub credential files, production's own OneCLI agent identity) is documented in the skillscript setup doc's "Gmail via skillscript's own connector" section — production needs its own OneCLI agent id and account-level API key, not dev's.

**If these aren't done**, `onboarding_go_live` and `onboarding_daily_sweep` won't be registered in the agent's tool list at all (they're gated on `SKILLSCRIPT_RPC_URL` being set, which it is, but the underlying skills need to exist and be `Approved` in skillscript's store or `execute_skill` will fail) — the agent falls back to the manual multi-step flows documented as the fallback path in `onboarding-procedures.md` flows #4 and #6, which still work, just without the determinism guarantees.

`onboarding_evaluate` and `onboarding_initiate` (new today) call `POST /agent/onboarding/evaluate` / `/initiate` on the MonDAI API server directly — **not** skillscript-gated, no skillscript-side setup needed for these two specifically.

## Phase 5 — Confirm the MonDAI API server itself is current

Everything in this doc assumes the API server already has `/agent/onboarding/evaluate`, `/agent/onboarding/initiate`, the `needs_attention`/stage-sync logic, and the fixed `email_redirect_override` parsing (comma-string-as-array bug) live. That's the API team's own deploy, outside this repo — confirm with them rather than assuming it shipped to production alongside their dev/staging testing today.

## Phase 6 — Verification

Read-only, safe to run against real production data at any time:

```bash
# From the agent, or directly:
curl -s -X POST "$CM_API_BASE_URL/agent/onboarding/evaluate" -H "Authorization: Bearer $CM_AGENT_TOKEN_cm-onboarding" -H "Content-Type: application/json" -d '{"chapterId":"<a real inactive/planned chapter id>"}'
# Expect {"success":true,"evaluation":{"stage":...,"notes":...,"isRevival":...,"resetPipeline":...}}
```

**Do not test `onboarding_initiate`, `onboarding_daily_sweep`, or `onboarding_daily_summary` against real production chapters/admins without the operator present** — all three have real side effects (chapter status changes, real emails, real Telegram notifications). A `curl` "just checking if the route exists" against a mutating endpoint is exactly how a real chapter got accidentally switched to `onboarding` during dev testing this same day — see `[[project_chapter_onboarding]]` memory if available. Discarding a response body to check only the HTTP status code does not make a call safe.

For the admin webapp panel specifically: send one real test message from the panel and confirm a reply actually arrives in that same chat (not just that `POST /message` returns `202`) — that's the exact failure mode Phase 2's destination check exists to prevent.
