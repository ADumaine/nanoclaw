# Request to API team: only linked senders reach the onboarding bot

## Why
A Telegram sender who has not linked their account arrives at NanoClaw as a raw Telegram id with no roles.
The onboarding agent has no way to verify who they are, and an admin approval tap is the only gate (an admin
can invite the wrong person). Approval is also keyed to the sender's id as sent, so a person approved as a
Telegram id is orphaned the moment they link (their messages then arrive as the profile UUID and are held again).

Link first, then approve: the 6-digit code from a logged-in session is the only verified identity we have.
We do **not** want to match by typed email or name; the bot cannot verify those claims.

You confirmed the building blocks already exist: `/link <code>` writes `user_connections` (Telegram id,
username, `auth_id`) and the onboarding webhook already looks the sender up (telegram.routes.js ~1100).
This request only changes what the webhook does when the lookup finds nothing, or finds someone not allowed.

## Behaviour wanted (onboarding Telegram webhook)
For each inbound message to the onboarding bot (`app_id` `telegram_onboarding_bot`):

| Lookup result | API action |
|---|---|
| No `user_connections` row for this Telegram id | Reply in the same thread with the link instructions (below). **Do not forward to NanoClaw.** |
| Linked, but the profile has none of the allowed roles | Reply "Your account isn't authorised to use this bot." **Do not forward.** |
| Linked and allowed | Forward to NanoClaw `/message` as today, plus `linked: true`. |

Link instructions text (same wording the existing `/link` reply uses is fine). It must say that the code is
sent in a **private direct message** with the bot, because the bot is also used in a group topic.

- **Rate-limit the unlinked and unauthorised replies** (suggest one per sender per 10 minutes) so a sender
  who keeps typing doesn't get the same block repeatedly.
- **Allowed roles must be configurable, not hard-coded.** Today it is `admin`. We expect a more limited or
  self-service bot for new chapter leads later; that should be a configuration change on your side
  (an env var or setting listing allowed roles per bot), not a code change. (How a chapter lead would be
  limited to their own chapter is a separate design question and is not part of this request.)
- The `user_id` sent for a linked sender stays the profile UUID (`auth_id`), as now. Confirm that this
  is the same value your roles come from.
- The web panel (`app_id` `cm-onboarding`, JWT-authenticated) and the dashboard notify calls
  (`/initiate`, `set-lead`, `user_id` `system`) must keep working unchanged. Please also send `linked: true`
  for the web panel's authenticated users, so the host can gate on the field uniformly later.

## New field
`linked` (boolean) on `POST /message`, additive. NanoClaw ignores unknown fields today, so this can ship
first with no coordination.

## Host side (NanoClaw, already built, off by default)
`WEBAPP_REQUIRE_LINKED_APP_IDS` (a comma-separated list of bare app ids). For an app id in the list, a message
without `linked: true` is answered with the same link instructions and is not processed. Until your field
exists, it falls back to the shape of `user_id` (a UUID counts as linked), so it can be turned on for
`telegram_onboarding_bot` only. Button presses (approval cards) are never gated.
This is a second layer behind your check: the API stops unlinked senders first, the host guarantees it.

## Existing members keyed by Telegram id
Some current group members were approved under their Telegram id (for example people approved before
linking). Once they link they arrive as their UUID and will need approval again, and until they link
the gate above stops them. We need a one-off mapping from you for the ids we send, to re-key members:

- Input: a list of Telegram numeric ids (we supply them).
- Output: `{telegram_id, auth_id}` for each id that is linked, nothing for those that are not.
- Admin-only; no emails or profile data in the response.

## Not in this request (noted from your reply)
- Resolving `chapter_lead_id` from a linked Telegram id, and `@handle` lookups, fit after the lead-storage
  work. Treat a username as a hint and confirm name and email with the admin; only admins may see profile
  emails through it.

## Questions
1. Which roles count as allowed today: `admin` only, or also `sysadmin`?
2. Where will the allowed-roles setting live (per bot), and can the settings screen edit it?
3. Does the link reply in a group topic say "private message", or only the DM version?
4. Will you also raise an alert (the new `/agent/onboarding/alert`) for repeated unauthorised attempts?
   Not for every unlinked message.

## Test plan (dev)
1. Unlinked Telegram account messages the bot: gets the link instructions, nothing reaches NanoClaw,
   a second message within 10 minutes gets no repeat.
2. Same account links with `/link <code>`, messages again: forwarded as the profile UUID with
   `linked: true`; if not yet a member, an approval card goes to the admin.
3. Linked account without an allowed role: told it isn't authorised, nothing forwarded.
4. Web panel and `/initiate` flows unchanged.
5. NanoClaw with `WEBAPP_REQUIRE_LINKED_APP_IDS=telegram_onboarding_bot`: an unlinked message sent straight to
   NanoClaw gets the same instructions and is not processed.
