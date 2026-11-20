# Request to API team: approval buttons over `/agent/callback`

**Context.** Unknown senders in the onboarding bot chats (`webapp:cm-onboarding`,
`webapp:telegram_onboarding_bot`) are held until an admin approves them. NanoClaw is building the host side
now, and we will test it on dev with the onboarding bot (@CMOnboard_bot). We need two things from the API:
render the approval card as buttons, and send the button press back. Nothing else changes.

Full findings and the host plan are in `docs/mondai/prod-findings-2026-11-19-reviewed.md`.

## 1. New callback shape: `type: "question"` on `POST /agent/callback`

NanoClaw will POST this (same `X-Shared-Secret` header as today):

```json
{
  "app_id": "webapp:telegram_onboarding_bot",
  "thread_id": "telegram_5945384141",
  "type": "question",
  "source": "agent",
  "question_id": "nsa-1795104681008-vio6dw",
  "title": "👤 New sender",
  "question": "Lou wants to talk to your agent in Chapter Onboarding. Only an existing admin of this agent can approve. Allow?",
  "options": [
    { "label": "Allow", "selectedLabel": "✅ Allowed", "value": "approve" },
    { "label": "Deny",  "selectedLabel": "❌ Denied",  "value": "reject" }
  ],
  "content": "👤 New sender\nLou wants to talk to your agent in Chapter Onboarding. Allow? (Buttons unavailable: ask an owner to approve from the host.)",
  "format": "markdown",
  "timestamp": "2026-11-19T16:11:21.008Z"
}
```

Please:
- **Render `question` as a message with an inline keyboard**, one button per entry in `options`
  (show `label`). Telegram `callback_data` is limited to 64 bytes, so map the button to the
  `question_id` and option `value` (for example keep a lookup, or use `q:<question_id>:<value>`).
- **Keep supporting plain `content`.** The `content` field is a text fallback. If a callback has
  `type: "question"` but you cannot render buttons, post `content` as an ordinary assistant message
  rather than returning an error. Ignore fields you do not know.
- `app_id` in callbacks already carries the `webapp:` prefix today. That is existing behaviour and is
  unchanged. The inbound call below uses the bare app id, as it does today.
- After a press, edit the original message: remove the buttons and show the chosen option's
  `selectedLabel`. A second press on the same card should be ignored.
- Respond 2xx with `{ "success": true }` as for normal callbacks. A `message_id` is optional.

## 2. Forward the button press to NanoClaw

`POST <NANOCLAW_URL>/message`, header `X-Shared-Secret: <the webapp shared secret>`
(the same secret as for every other call, the one fixed on 2026-11-18):

```json
{
  "app_id": "telegram_onboarding_bot",
  "thread_id": "telegram_5945384141",
  "user_id": "5945384141",
  "question_id": "nsa-1795104681008-vio6dw",
  "selected_option": "approve"
}
```

Notes:
- `question_id` and `selected_option` are the only new fields. `message` is not required when both are present.
  `selected_option` is the option's `value` (`approve` or `reject`), not its label.
- **`user_id` must be the identity of the person who pressed the button** (for Telegram, the pressing
  user's id from the callback query), not the bot's and not the original requester's. NanoClaw authorizes
  the click as `webapp:<user_id>` and accepts it only if that is the targeted approver or any admin of the
  onboarding agent group. Any other id is silently refused, with no error to you.
- `app_id` and `thread_id` should be the ones from the card's callback (`app_id` without the `webapp:` prefix).
- NanoClaw replies 202 immediately. The result (member added, held message replayed) happens afterwards
  and the original sender gets the bot's reply in their own chat as normal.

## 3. What we need back from you
1. Confirmation that you can do 1 and 2, and a dev date.
2. Whether Telegram `callback_data` will carry `question_id` and the value directly or via a lookup.
3. Whether the button-press `user_id` is the Telegram numeric id (what we expect), or the website UUID
   when the pressing Telegram user is linked to a profile. **NanoClaw's roles on prod are keyed to the
   Telegram id**, so tell us if that is not what you will send.
4. Confirmation that an unrecognised `type` or extra fields on `/agent/callback` do not cause a 4xx.

## 4. Test plan (dev, onboarding bot)
1. Unknown sender writes to @CMOnboard_bot → the approver gets a Telegram message with Allow and Deny buttons.
2. Allow → the approver's message shows "✅ Allowed", the sender is added to the group and the held message
   is answered.
3. Deny → "❌ Denied", no member row.
4. A non-admin presses a button → no effect, nothing added.
5. Pressing the same card twice → the second press does nothing.
6. Before your change ships: the approver should still see a readable fallback message (the `content` text),
   not a 4xx or silence.
