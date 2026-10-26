# Community Bot — Mention Filtering & Token Attribution

**Status: 2026-10-24 — Parts 1 & 2 as before (see below); Part 3 confirmed working via real webapp traffic the same day, no action needed.** Part 1 (mention filtering) still needs the BotFather toggle + the `telegram.routes.js` reply-check update on the API side; NanoClaw's wiring needs no change. Part 2 (attribution): NanoClaw now threads the inbound `user_id` through to the `/agent/callback` payload (`container/agent-runner/src/formatter.ts`, `poll-loop.ts`, `src/channels/webapp.ts` — see `docs/webapp-channel.md` and `docs/mondai/nanoclaw-api-consumers.md` for the updated payload shape). No further NanoClaw-side work pending on Parts 1/2; remaining work there is API-side (the UUID-vs-numeric branching on `req.body.user_id` described below). Part 3 (cross-channel aggregation) was confirmed correct against real traffic — no further action.

Three independent asks for the API team, bundled here because they came up in the same investigation. Doing #1 reduces how often #2's gap actually bites, but does not fix it; #3 is a separate axis entirely (which channel a member used, not who sent a given message) — treat all three as separate pieces of work with separate owners.

## Current state (confirmed before writing this doc)

- Community bot's Telegram **Group Privacy is currently disabled**, and the bot has never been deployed into a live group chat yet. No migration risk, no existing traffic pattern to preserve — this is a clean window to make both changes before real usage exists.
- The community bot and the onboarding bot (`telegram_onboarding_bot` proxy) are **separate Telegram bot tokens** — confirmed because Group Privacy is a bot-wide setting, not per-chat, and the two bots already behave differently today (onboarding mention-filtered, community always-on). Changes to one do not affect the other.
- NanoClaw's own wiring for the community bot is `engage_mode=pattern`, `engage_pattern='.'` (always-engage, matches every message), `sender_scope=all`. This is identical to the onboarding bot's NanoClaw-side wiring — the behavioral difference between the two bots today is entirely upstream of NanoClaw, at the Telegram/API-server layer.

---

## Part 1 — Mention filtering for the community bot

**Goal:** stop spending LLM tokens answering messages nobody directed at the bot. Right now, with Group Privacy disabled, every message any member posts in the group would reach NanoClaw and trigger a full agent turn.

**Requested change — Telegram side, before any group deployment:**

Enable Group Privacy for the community bot: `@BotFather → /mybots → [community bot] → Bot Settings → Group Privacy → ON`.

With this on, Telegram itself stops delivering plain group chatter to the bot's webhook. Only these update types will arrive going forward:
- messages that start with a bot command
- messages that @mention the bot
- replies to one of the bot's own messages

Everything else is filtered by Telegram before it ever reaches the API server — no inbound traffic to process, no round trip to NanoClaw, no LLM call.

**What we need confirmed, not assumed, on the API side:**

1. Does the webhook handler for this bot's updates currently do anything that depends on seeing *every* group message (analytics, moderation logging, anything unrelated to the NanoClaw forward)? If so, flag it before flipping the setting — this would silently stop seeing that traffic too. (This is the same caveat `docs/mondai/production-deploy-2026-08.md` raises about the onboarding bot's token/webhook ownership — same category of "confirm with whoever owns this before changing it.")
2. Whether any additional app-level mention/reply check is needed in code, or whether Telegram's own Group Privacy filtering is sufficient on its own. We don't have visibility into whether the onboarding bot's existing filtering (described in `production-deploy-2026-08.md` as the API server "already filters Telegram group messages down to @mentions before ever forwarding to NanoClaw") relies on Group Privacy doing the work, or on an explicit code-level check in `telegram.routes.js`. If it's the latter, the same explicit check likely needs adding for the community bot's handler too — please confirm which mechanism is actually in place today.

**What does NOT need to change:**

- NanoClaw's wiring (`engage_mode=pattern`, `pattern='.'`) stays as-is. Once the upstream stream is already mention-filtered, "always engage on whatever arrives" is the correct NanoClaw-side config — this is exactly the onboarding bot's existing setup, proven to work.
- No new messaging group, wiring, or destination needed on the NanoClaw side for this change.

**Worth flagging separately (not an API-side task):** this is a visible behavior change to the community once the bot is live in a group — it will only respond when tagged or replied-to, not to every message. Worth a one-time heads-up post in the group when it goes live, so it doesn't read as the bot being broken.

---

## Part 2 — Token attribution for group-chat usage

**Recap of what's already fixed (confirmed working, thank you):**
- Telegram DM attribution (`telegram:<chatId>` thread pattern) now resolves `profiles.id` from `auth_id` correctly before inserting into `token_usage`.
- `get_my_usage`'s column-selection bug is fixed (`total_tokens`/`tokens` mapping).

**The gap that remains:** group threads share one `thread_id` across every member who posts in them. We've seen two distinct thread_id shapes in use across the two bots:
- `telegram-group:<chatId>:<topicId>` (community bot, forum-style group with topics)
- `telegram-group:<chatId>` (onboarding bot's admin group — flat, no topics)

Neither shape identifies *who sent the specific message* that triggered a given reply. Resolving `profiles.id` from the thread_id alone — which is what DM resolution can safely do, since a DM thread maps 1:1 to one person — cannot be correct for a shared group thread. Every reply in a group chat currently risks being attributed to the wrong member (or no member) in `token_usage`, regardless of the DM fix above.

**What's already in place on the API side, per your own summary:** `req.body.user_id` is honored when present for this resolution. That's exactly the right hook — but **NanoClaw does not currently send `user_id` in the `/agent/callback` payload at all.** Today's actual payload (per `docs/webapp-channel.md`):

```json
{
  "app_id": "webapp:cm-tg",
  "thread_id": "telegram-group:<chatId>:<topicId>",
  "content": "...",
  "format": "markdown",
  "type": "message",
  "source": "agent",
  "timestamp": "...",
  "tokens_used": 1234,
  "model": "claude-sonnet-4-6"
}
```

(`cm-tg` is the production app_id; a separate `cm-tgdev` exists for testing — expect both.)

Adding a correct `user_id` here is real work on NanoClaw's side — the per-message sender's identity isn't currently tracked as structured routing data anywhere in the pipeline (session DB schema, routing context, or the outbound delivery path all need a new field threaded through). We'll scope and build that separately. **Before we do, we need the following confirmed from the API side**, so we build the right shape the first time rather than another round-trip of mismatched fields:

1. **What value should `user_id` carry?** The Supabase `auth_id` (UUID) — same identifier already used elsewhere in the `X-On-Behalf-Of` header for other MCP tool calls — or `profiles.id` directly, or something else? Please specify exactly.
2. **What should happen for an unlinked/anonymous Telegram sender in a group** — someone who posted without ever connecting a MonDAI account? Three options we can build for, pick one: (a) omit `user_id` and let it fall back to whatever the current thread_id-based resolution does, (b) send the raw numeric Telegram user id as a distinct non-UUID identifier and have the API side treat that as "no linked profile, skip or bucket separately," or (c) something else you'd prefer.
3. **Confirm this `req.body.user_id` handling is meant to apply uniformly** to both thread_id shapes above (with and without `:<topicId>`), so NanoClaw doesn't need separate logic per bot.

---

## Confirmed by the API team, 2026-10-23

**Part 1:**
1. The webhook handler (`server/routes/telegram.routes.js#L461-L488`) does nothing that depends on seeing every group message before the mention filter runs (just an in-memory `lastUserMessageId` update, a debug log, and the slash-command check) — safe to enable Group Privacy without starving any background functionality.
2. Both mechanisms are in play: Group Privacy stops Telegram from delivering plain chatter at all, **and** there's an existing explicit code check (`telegram.routes.js#L486-L488`) that currently tests only `botMentionRegex.test(rawText)`. The API team identified a real gap themselves: that check doesn't look at `message.reply_to_message`, so once Group Privacy is on, Telegram will forward replies-to-the-bot alongside @mentions, and the current code would silently drop the replies. **API team is updating the condition** to also accept `message.reply_to_message?.from?.is_bot || message.reply_to_message?.from?.username === botUsername`.

**Part 2:**
1. `user_id` can be either shape — a bare numeric Telegram id or a bare Supabase `auth_id`/`profiles.id` UUID. The API server resolves whichever one it gets: numeric → look up `user_connections.provider_user_id` → `profiles.id`; UUID → resolve directly. Confirmed this already works out-of-the-box with what NanoClaw forwards, since the inbound `forwardToNanoClaw` step already sends `authId || sender_id` as `user_id` and NanoClaw's webapp adapter already captures that per-message — see the implementation note below.
2. For unlinked/anonymous senders: **send the raw numeric Telegram id**, not nothing. Omitting it would make the callback fall back to `chatId`, which for a group is the negative group id — that would bucket every anonymous chatter in the group as a single shared "user" for rate-limiting purposes, letting one person's volume exhaust the whole group's quota. With the numeric id instead, the API server rate-limits that specific anonymous person individually and buckets their usage under `SYSTEM_ANONYMOUS_ID` with `external_user_id = senderId`. (Cap reconciled 2026-10-24: the real figure is 10,000/day, `TELEGRAM_ANONYMOUS_DAILY_LIMIT` in the API server's `.env` — the "5,000" originally stated here was superseded; see `docs/mondai/nanoclaw-api-consumers.md`'s `/agent/usage` section, which also covers the `GET /agent/usage` anonymous-lookup fix the API team shipped the same day.)
3. Confirmed uniform: `agent.routes.js#L553-L625` matches on `thread_id.startsWith('telegram:')` or `thread_id.startsWith('telegram-group:')`, covering DMs, flat groups, and forum-topic threads with the same logic. No per-bot special-casing needed.

**Implemented on NanoClaw's side, 2026-10-23** (no further NanoClaw-side work pending):
- `container/agent-runner/src/formatter.ts`: `RoutingContext` now carries `senderId`, populated from the triggering inbound message's `content.senderId`/`content.author.userId` **without** the channel-type-prefix that the existing (differently-purposed) `extractSenderId` applies for admin-id comparisons — this field must stay a bare id, exactly as received, to match either of the two shapes the API server accepts.
- `container/agent-runner/src/poll-loop.ts`: threaded through `dispatchResultText` → `sendToDestination` (resolved per-destination, same as `threadId`/`inReplyTo` already were, via `resolveDestinationThread`) and `deliverErrorResult`; added as `user_id` on the outbound `content` JSON alongside `tokens_used`/`model`.
- `src/channels/webapp.ts`: `deliver()` reads `user_id` off that content and includes it in the `/agent/callback` POST body when present.
- `docs/webapp-channel.md` and `docs/mondai/nanoclaw-api-consumers.md` updated with the new field.

**Next step (Parts 1 & 2):** API team applies the `telegram.routes.js` reply-check update and flips Group Privacy on for the community bot; no further coordination needed for either side's changes described here.

---

## Part 3 — Cross-channel usage aggregation (Telegram + webapp widget), raised 2026-10-24

**Confirmed working, 2026-10-24 — no fix needed.** Real traffic arrived same-day: the user opened an actual webapp-widget chat (first-ever session on `webapp:cryptomondays`/`-dev`) and sent a couple of messages. `GET /agent/usage` for that member immediately afterward showed both channels landing in the same `profiles.id`-keyed total: `tokens_used_today: 707 / 50000`, with `recent_usage` rows tagged `provider: "agent"` (the two new webapp-widget turns, 119 + 87 tokens) interleaved with the existing `provider: "telegram"` rows, all summing into one number. So despite the `thread_id` shape mismatch flagged below, aggregation to one per-member daily total already works correctly for a linked member. The original concern (raised before any real webapp traffic existed) turned out to be unfounded, or was already fixed server-side independent of the Part 2 work — leaving the open question below purely for documentation/completeness, not as a live bug.

**Original concern (superseded by the confirmation above, kept for context):**

The same CryptoMondays member can reach Agent MonDAI through two different NanoClaw channel instances that both resolve to the *same* community agent group: the Telegram bot (`webapp:cm-tg` / `webapp:cm-tgdev`) and the actual website chat widget (`webapp:cryptomondays` / `webapp:cryptomondays-dev`). `/agent/usage` is supposed to report one combined daily total per member regardless of which surface they used — the requirement is that usage aggregates across Telegram and web, not two separate buckets.

**Why this is a real risk, not just a hypothetical:** Part 2's confirmation #3 above states the attribution fix's resolution logic matches specifically on `thread_id.startsWith('telegram:')` or `thread_id.startsWith('telegram-group:')`. Per `docs/mondai/planning-summary.md`, the website widget's `thread_id` is the Supabase `chat_session_id` — it does not start with either prefix. So webapp-widget-originated messages take a different path through `agent.routes.js` than Telegram ones do, and we don't know whether that path also normalizes to `profiles.id` the same way, or whether it buckets usage by `thread_id`/`chat_session_id` instead — which would NOT merge with that same member's Telegram usage into one combined total.

**Not yet tested empirically** — unlike Parts 1/2, there is zero real traffic to check against: `mg-1776553670171-p3uds3` (`webapp:cryptomondays`) and `mg-1778131470796-7hl0j` (`webapp:cryptomondays-dev`) have had zero sessions ever (confirmed via the sessions table on NanoClaw's side, 2026-10-24) — the website widget has never actually been used against this community agent group, so this can't be confirmed live the way Parts 1/2 were.

**What we need confirmed from the API side:**
1. When a webapp-widget message arrives with a `chat_session_id`-shaped `thread_id` (not `telegram:`/`telegram-group:`-prefixed), does `agent.routes.js` resolve `profiles.id` the same way (direct for a UUID `user_id`, since every webapp-widget user is logged in — no anonymous case there) before writing to `token_usage`? Or does it use a different/legacy path?
2. Is `token_usage` keyed in a way where a single member's rows from both channels sum into one total regardless of which `thread_id`/channel produced them — i.e., is `/agent/usage`'s daily total truly per-`profiles.id`, not per-thread or per-channel?
3. If the webapp-widget path does NOT currently normalize the same way, what's needed to fix it — the same `req.body.user_id`-based fix as Part 2, or something else entirely since there's no anonymous-sender case to handle on this channel?

**What does NOT need to change on NanoClaw's side (pending the above answer):** NanoClaw already sends `user_id` on every outbound callback uniformly, regardless of which channel instance triggered it (the Part 2 fix is channel-agnostic — same `formatter.ts`/`poll-loop.ts`/`webapp.ts` code path for Telegram and webapp-widget messages alike). If the gap turns out to be API-side only, no NanoClaw change is needed; if it isn't, come back and scope that separately once the answer is in.
