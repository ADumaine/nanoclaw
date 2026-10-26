# Questions for the API team — community agent instruction review (2026-10-26)

While tightening the community agent's instructions, these are the things NanoClaw's side cannot determine and has deliberately NOT assumed. Answers will be folded into `groups/community/CLAUDE.local.md` and the tool descriptions.

## 1. What `user_context` does the API send for an unlinked Telegram sender?

The agent now sees `auth_id`, `status` and `roles` on each message. For a linked member we observe `{"auth_id":"<uuid>","status":"active","llm_mode":"community"}` with `roles:["admin","member"]`. We have never captured a message from an unlinked sender.

- What are `auth_id`, `status` and `roles` for an unlinked Telegram sender? (We assume `auth_id` = raw numeric Telegram id, per the attribution work. Is `status` `"anonymous"`, absent, or something else?)
- The opportunity tools accept `user_status` of `active`, `pending`, `anonymous`. Is that the full set of values `status` can take? Any others (suspended, banned, etc.)?
- For a webapp-widget visitor who is not logged in, what are `auth_id` / `status`?

## 2. Which id does `/members/search` return, and which id does `/member/<id>` expect?

Instructions tell the agent to link members as `[Name](/member/12345)`. We don't know whether search results carry a numeric member id, a profile UUID, or both, and which one the web app's `/member/` route resolves. Please confirm the field name and format.

## 3. Behavior for unlinked senders on each endpoint

We currently block unlinked senders agent-side from profile lookups, "similar to me" and Earn opportunities. Please confirm what the server itself does, so we don't block anything it would allow (or allow something it should refuse):

- `GET /members/:id`, `update_agent_prefs`, `find_similar_members` with a numeric id.
- `smart_search_members` with a numeric `auth_id` (tool says "omit for anonymous"; does passing it break or just skip the chapter tiebreaker?).
- Opportunity read endpoints (list/search) for anonymous — allowed or refused? Today the agent blocks all opportunity actions for unlinked users, including read-only search.

## 4. Profile card callbacks for unlinked users

Instructions say unlinked users get a limited public profile view (no email). Is that enforced by `get_member_profile` / a public endpoint, or does the agent have to withhold fields itself? Which endpoint should the agent call for the public view?

## 5. Daily token limits (updated after clarification)

Limits are a default (50,000) plus optional per-member overrides (the test member's is 70,000). A re-check on 2026-10-26 shows `/agent/usage` returning `daily_token_limit: 70000` for that member, so the endpoint does honor overrides now; the earlier 50,000 we saw on 2026-10-24 was before the override was set (or before it was honored; please confirm which).
- The webapp page showed "18,786 / 70,000": the limit matches the override, but 18,786 did not match `/agent/usage` (707 at the time). Is the widget summing something different (all providers, a different day boundary/timezone, or another user)? What is the day boundary (UTC midnight?) used by `tokens_used_today`?
- Is the unlinked cap (10,000) overridable per sender, or only the default via `TELEGRAM_ANONYMOUS_DAILY_LIMIT`?

## 6. Model and web search

Dev and prod both use the fallback list gpt-5.4-mini → gpt-5.4 → gpt-5.5. 
- Which conditions trigger a fallback to the larger models (error, tool failure, context length, user tier)?
- RESOLVED by the API team: `token_usage.model` used to record the model the agent requested (`claude-sonnet-4-6`) instead of the one the LLM returned (GPT); fixed going forward, older rows keep the wrong label. So the `claude-sonnet-4-6` rows we saw are a recording artifact, not evidence that any channel runs Claude.
- How is `WebSearch` served for GPT models (proxy-emulated, OpenAI native search, other)? Are `allowed_domains`/`blocked_domains` supported, and should `null` values be tolerated? (The agent currently has an instruction to omit them because `null` hard-errors.)

## 7. Scheduled-task / profile-sync support

`agent_prefs.profile_sync_enabled` exists server-side. The agent's file-based profile-sync workflow can no longer run (see NanoClaw note below). Is profile sync still a wanted feature? If so, is there a server-side endpoint or job that could do the comparison (profile vs. what the agent learned) instead of the agent doing it from a local file?

## 8. Group chats

Part 1 of `community-bot-mention-filter-and-attribution.md` (Group Privacy toggle and the reply-to-bot check in `telegram.routes.js`) — is that done? Not verified from NanoClaw's side.

---

## NanoClaw-side findings (FYI, not questions)

- The community agent's `allowed_tools` is `WebSearch, WebFetch, SendMessage, ToolSearch, Skill` — no Read/Write/Edit/Bash. The old instructions told the agent to read/write per-user files (`/workspace/agent/users/<auth_id>.md`) and run a monthly profile sync from them. It could not actually do either. Those sections were removed in this rewrite (a backup of the old file exists; a stale example profile file from May 2026 remains in `groups/community/users/`).
- Tool descriptions and instructions referred to a `<user_context>` tag that is never shown to the model; they now point to the `auth_id`/`status` attributes on the message.

---

# Round 2 — follow-ups after the API team's answers (2026-10-26)

Applied on the NanoClaw side: tiering is now keyed on `status` (`active`/`pending`/`inactive`/`suspended`/`anonymous`); unlinked senders get the `/link` reply for profile/similar/prefs/opportunity-writes; `smart_search_members` and opportunity browsing stay open to them; member links use an absolute `profile_url` that the tools now add to results as `${CM_APP_URL}/profile/<id>`; the tools themselves now refuse a non-UUID id for profile/prefs/similar (so the Postgres UUID error can't happen) and drop a non-UUID `auth_id` from smart search.

1. **Does `X-On-Behalf-Of` change profile masking?** `get_member_profile` sends `X-On-Behalf-Of: <the uuid being fetched>` (the tool only has one id argument). For a profile-card tap that means "viewer = the profile's owner". Answer 4 says masking is applied because the token is a system token — does an `X-On-Behalf-Of` equal to the profile's own id skip masking (returning email, socials, wallet, `agent_prefs`)? If yes, card taps could expose private fields and we need a different call (or a separate viewer parameter).
2. **`agent_prefs`.** Answer 4 says `agent_prefs` is stripped for agent calls. Is it stripped even when the fetched profile is the caller's own? (`update_agent_prefs` still exists; we want to know if the agent can ever read prefs back.)
3. **`inactive` / `suspended` / `pending`.** ANSWERED: inactive/suspended = no interaction; pending = partial profile gathered from external sources, not registered. The agent now gives inactive/suspended one fixed refusal ("Your account can't use this assistant right now. Please contact a CryptoMondays admin.") and calls no tools. Follow-ups: (a) does the API already block those users before NanoClaw, making this moot? (b) for `pending` users, what should we tell them to do and where — is there a registration URL, and does `/link` apply to them in Telegram (they have a partial profile but no account)? We currently say only "register with CryptoMondays" with no link, because we won't guess a URL. (c) Is the refusal wording OK?
4. **Token-count explanation doesn't match what we measured.** On 2026-10-24 we queried `/agent/usage?user_id=6e673443-f55b-4a80-8fef-741f42680b9e` (the linked UUID, `is_linked: true`) and got 707 / 50,000 with both `provider:"telegram"` and `provider:"agent"` rows — not an unlinked sender. The widget showed 18,786. Please sum `token_usage` for that profile for the UTC day of 2026-10-25 by provider, and say which number is right. (Note: the 50,000 vs 70,000 limit difference is explained by the override.)
5. **Numeric Telegram id for unlinked senders.** Since `user_context.auth_id` is omitted, NanoClaw fills `auth_id` from the root `user_id` (`src/channels/webapp.ts`). Confirm that in **group** chats `user_id` is the individual sender's Telegram id (not the chat id), and that it's the same string `/agent/usage` expects.
6. **`/members/match` result shape.** We add `profile_url` only to result objects that have an `id` that's a UUID. Confirm `/members/search` and `/members/match` (both topic and "similar to me") return `id` = `profiles.id` on each member.
7. **App host.** Links are built from `CM_APP_URL` (dev: `https://mondaidev.cryptomondays.io`). Confirm the prod value (is it `https://app.cryptomondays.io`?) and that `/profile/<profiles.id>` works on both hosts.

## Round 2 — answers received and applied (2026-10-26)

- **X-On-Behalf-Of (critical):** confirmed it identifies the VIEWER. `get_member_profile` was sending the target's id there, which makes the server return the owner's unmasked profile. Fixed: tool now takes `auth_id` (target) + `viewer_auth_id` (sender); the header is the viewer only, omitted for unlinked senders. Other tools (smart search, similar, prefs, opportunities) already sent the sender's own id.
- **Usage mismatch:** explained by the UTC day boundary (18,700 on 10-24, 1,599 on 10-25). Closed.
- **Group chats, result shape, hosts:** confirmed (prod `https://mondai.cryptomondays.io`, dev `https://mondaidev.cryptomondays.io`).
- **Resolved (Allan):** inactive/suspended = no data retrieval (no tool calls); the agent uses the API team's separate wording for each. Pending uses the API team's wording too.
- **Links:** API team's advice (absolute URLs) applies only if a link is shown. The agent now shows profiles as chat text and gives `profile_url` only on request.

## Round 3 — cosmetic bug for the API team (2026-10-26)

The Telegram `/link` instructions show a literal backslash in step 4: "Start a private direct message with MonDAIDev\_bot and reply". The `_` in the bot username is being escaped (MarkdownV2 style) but the message is not rendered with a matching `parse_mode`. Either send that text as plain text without escaping, or keep the escaping and set `parse_mode: "MarkdownV2"`. Check the rest of that message for the same issue. This text is generated in the API server (`telegram.routes.js` area), not in NanoClaw.

## Round 3 — match_score scale

`/members/match` returns `match_score` (e.g. 76, 65, 61 for "similar to me"; 104, 87, 80 for a topic search on RWA, so it is not capped at 100). What is the scale and how is it computed (weights for shared interests, expertise, chapter, profile completeness, synonyms)? Can it exceed 100, and is a score comparable between "similar to me" and topic searches? Until answered, the agent presents `match_reasons` and describes the score only as a relative ranking, not a percentage.

### Follow-up on match_score (from Allan)

"Similar to me" and "match a term" (topic) scoring differ, and the agent should not carry its own copy of the rules. Proposal: an API endpoint (e.g. `GET /members/match/scoring?mode=similar|topic`) that returns the current plain-language scoring description and max score, which the agent would fetch only when a user asks what a score means. That keeps one source of truth with the web app's modal.

Reference — the web app's "Similar to Me" modal text: diminishing-returns points, max ~120. Complementary skill exchange up to ~45 (+20/+13/+8/+5…); shared interests up to ~35 (+15/+10/+6/+4…); peer expertise overlap up to ~16 (+10/+6/+4…); +15 home-chapter affinity; up to 20 profile completeness (bio +4–8, company +4, avatar +4, verified socials +4). Sorted highest first. Topic-search scoring is not described there (observed scores above 100, e.g. 104).

## Round 3 — scoring endpoint verified; max_score inconsistency

`GET /members/match/scoring` verified live on dev (200 for similar/topic/both) and wired as the agent tool `explain_match_scoring`. One issue: both modes report `max_score: 100`, but real topic-search scores reach 104 (and the modal says "up to ~120" for similar; the topic breakdown sums to 40+40+20+20 = 120). Please reconcile the reported `max_score` with the real cap so the agent doesn't explain a 104 as out of 100.

---

# Pre-deploy: remaining open items for the API team

1. **Prod parity.** Are all of these deployed on PROD (not just dev), and is the prod server restarted? (a) anonymous-sender usage lookup in `/agent/usage`, (b) `roles:["anonymous"]` + `status:"anonymous"` in `user_context` for unlinked senders, (c) `GET /members/match/scoring` with `max_score:"~120"`, (d) `X-On-Behalf-Of` viewer masking on `GET /members/:id`, (e) group-chat reply/mention filter (commit `7f5e4e2`), (f) the `token_usage.model` fix, (g) the `/link` text backslash fix.
2. **`pending` senders.** What `user_context` do they get over Telegram/webapp: is there an `auth_id` (a Supabase UUID, or only a `profiles.id`/nothing), and what is the root `user_id`? We assume none that works for UUID-only endpoints. Also: does the agent have a URL to send them for registration, and does `/link` apply to them? We currently say only "complete your registration on MonDAI" with no link.
3. **`inactive` / `suspended` senders.** Does the API gate them before the message reaches NanoClaw? If it does, our fixed-reply handling is a harmless backstop; if not, confirm they should still reach the agent (which replies with the status message only).
4. **Prod values.** Confirm prod `CM_APP_URL` should be `https://mondai.cryptomondays.io` (used to build absolute profile links), and that the prod `CM_AGENT_TOKEN` is the one NanoClaw prod uses.
5. **Token model labels.** Old `token_usage` rows keep `claude-sonnet-4-6`; confirm the prod usage totals/limits aren't affected by the label (only the `model` column was wrong).

## Pre-deploy answers received (2026-10-26) and applied

- **pending** = linked Telegram, onboarding unfinished, valid UUID `auth_id` (no `/link`; send to `<app>/onboarding`). Pre-imported contacts arrive as `anonymous` with a numeric id (send to `<app>` and `/link`). Applied: pending gets the activation message + onboarding URL; anonymous gets the `/link` message + sign-up URL.
- **URLs** come from `CM_APP_URL` via a new `get_app_links` tool (and baked into the tool-side "not linked" message), not hard-coded: dev `https://mondaidev.cryptomondays.io`, prod `https://mondai.cryptomondays.io`.
- **inactive/suspended** are NOT stopped by the API; the agent's fixed replies are the enforcement. Applied as-is.
- Still open: item 1 (prod parity of the API changes) and item 4 (prod `CM_APP_URL` / token values).
