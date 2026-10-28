# API team: Telegram `/help` and `/link` text (2026-10-28)

NanoClaw filters `/help` (`src/command-gate.ts`) and has no `/link` handler, so the replies users see come from the API server. Three requests:

1. **Escaped bot name.** The `/help` reply shows `@MonDAIDev\_bot` (literal backslash). Same issue in the `/link` instructions (first reported in Round 3). The text is probably escaped for Telegram MarkdownV2 but sent with a different `parse_mode` (or none). Please send it consistently.
2. **`/link` does not mention registration.** The text only says "connect your CryptoMondays profile". Someone with no MonDAI profile cannot link: they must first register on the web app (`/onboarding`) and then send `/link`. Please add that step, plus the sign-up URL for the environment.
3. **Commands in `/help` are not tappable.** Tapping `/link` in the `/help` reply only copies the text (Telegram does that for code-formatted text). Please send the command names as plain text, not in backticks / code entities, so a tap sends the command. (Our video `/summary<id>` commands are plain text and work.)
4. **`/help` content.** Currently only lists `/link`, `/link <code>`, `/help` and the group-mention note. Suggested additions: what the bot can do (events, chapters, member search, call videos with tappable `/summary<id>`, opportunities, usage), the video summary commands, and a pointer to the MonDAIConnect bot for matching. We are also adding a "what can you do?" answer on the agent side, so the two should agree. Is `/help` meant to stay API-owned, or would you rather NanoClaw handle it (we would remove it from the filtered list)?

MonDAIConnect's handle is @MondaiConnectBot (already used in the agent's answer). Allan is checking whether the `/help` text is hardcoded or set in a MonDAI admin configuration page.

## Reply from API team (2026-10-28) and decisions

- Item 1 (escaped bot name): root cause is the underscore-escaping regex in `server/routes/telegram.routes.js` (~line 158); legacy `parse_mode: 'Markdown'` does not consume the backslash inside @mentions/link text. API team to bypass escaping inside usernames.
- Item 2 (`/link` registration): API team to update `getLinkingPromptText()` to send unregistered users to `<app>/onboarding` first.
- Item 3: **Choice A chosen** (NanoClaw owns `/help`; `/link` and `/link <code>` stay API-owned). NanoClaw side done: `/help` passes the command gate on the webapp channel and reaches the agent as plain chat; the agent answers with the "what can you do?" text including @MondaiConnectBot.

### New findings (2026-10-28, from a group chat containing three bots)

1. **`/help@CMOnboard_bot` was answered by all three bots** in the group (CMOnboard, MonDAIDev_bot, CMOnboardDev), each with the identical API guide. A command with an `@suffix` should be handled only by the bot it names; plain `/help` in a group should arguably not be answered by every bot either.
2. **The help text is shared, not per bot.** CMOnboard replied "mention me with @MonDAIbot"; the two dev bots said `@MonDAIDev\_bot`. Each bot should name itself.
3. **Before removing `/help` from `handleCommand()`:** please forward `/help` to NanoClaw only for the community bots (cm-tg / cm-tgdev), and only when the `@suffix` is absent or matches the receiving bot. The onboarding agent (webapp:cm-onboarding, webapp:telegram_onboarding_bot) has no `/help` handling, so it should keep the existing API reply.

## Round 4: requesting a new chapter from the bot

The web app lets any member request a new chapter (`ChaptersView.vue`, which notifies admins via `POST /email/send`). The bot has no equivalent: a member asked "can I request a new chapter be created?" and the agent offered to take the details, but there is no tool to submit them. Interim fix: the agent now points to the web app form.

Questions for the API team:
1. Is there a dedicated endpoint for chapter requests, or does the web app only compose an email through `/email/send`? What is the exact recipient (fixed admin address or a setting), subject and body/fields?
2. Can chapter requests be made by the `community` agent on behalf of a member (X-On-Behalf-Of) so the request is attributed to them, or must it carry the requester's details in the body?
3. If it is only an email: may NanoClaw add a constrained `request_new_chapter` tool (fixed fields: chapter name, city, country, requested lead, requester auth_id) that always goes to the admin recipient, instead of letting the model compose the email?

## Decisions recorded (2026-10-28)

- `/help`: community bots forward to NanoClaw (agent answers); onboarding bot keeps a local API-side `/help` (Option 1). NanoClaw's command gate passes `/help` only for the `community` agent group and strips Telegram's `@botname` suffix before matching commands.
- API confirmed: `chapter_lead` role value; `updateChapter` enforces lead ownership and the five lead-editable fields server-side.
- `send_email`: left as is (admin-only by tool description). The community agent token is accepted by `/email/send`; revisit with a code-level role check if exposure becomes a concern.
- Deferred: chapter requests from the bot (Round 4 questions) and attendee matching.
- Open: confirm the API stops answering `/help@OtherBot` on bots it wasn't addressed to.
