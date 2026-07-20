---
name: setup-webapp
description: Configure a webapp channel deployment — create the messaging group, set access policy and session isolation, wire to an agent group, and restart NanoClaw. Run after /add-webapp. Safe to re-run for additional app_ids or environments.
---

# Setup Webapp

Walks through configuring one webapp deployment: a messaging group for an `app_id`, the access and isolation policy, and a wiring to an agent group. Run once per `app_id` (i.e. once per frontend environment).

## Pre-flight

Check that `/add-webapp` has already been installed:

```bash
grep "import './webapp.js'" src/channels/index.ts
```

If that line is absent, run `/add-webapp` first.

Check that `WEBAPP_SHARED_SECRET` and `WEBAPP_CALLBACK_URL` are set:

```bash
grep -E "WEBAPP_SHARED_SECRET|WEBAPP_CALLBACK_URL" .env
```

If either is missing, add them to `.env` before continuing (see `/add-webapp` for the format).

## Step 1 — App identity

Ask (free-form text, not AskUserQuestion):

1. **`app_id`** — the short identifier your API server sends in each `POST /message` body (e.g. `myapp`, `myapp-prod`). Record as `APP_ID`.
2. **Display name** — human-readable label for this messaging group (e.g. "My App", "My App (prod)"). Record as `MG_NAME`.

## Step 2 — Access policy

AskUserQuestion: "Who can send messages to the agent?"

- **Anyone (public)** — any `user_id` your API sends is accepted. Your API server already validated their auth. Correct for most webapps.
- **Admin approval required** — each new user's first message is held; an admin gets a DM card to approve or deny. On approve the held message is replayed and the user is added to the agent group's member list.
- **Pre-registered only (strict)** — messages from users not in the member list are silently dropped. Use when you manage membership manually via `ncl members add`.

Record the choice as `SENDER_POLICY`: `public`, `request_approval`, or `strict`.

## Step 3 — Session isolation

AskUserQuestion: "How many users will send messages through this app_id?"

- **Multiple users** — each user gets their own isolated agent session (recommended for any multi-user webapp)
- **Single user / personal assistant** — all traffic shares one session

Record as `IS_GROUP`: `1` for multiple users, `0` for single user.

If `IS_GROUP=1`: confirm the `thread_id` strategy with the user (free-form). Most webapps send `user_id` as `thread_id` — one persistent conversation per user. Note this in plain text for awareness; it's the API server's responsibility, not a NanoClaw config value.

## Step 4 — Agent group

List existing agent groups:

```bash
ncl groups list
```

AskUserQuestion: "Which agent group should handle messages from this webapp?"

- One option per existing agent group (show name and folder)
- **Create a new agent group** — will prompt for a name

If creating new, ask for the agent group name (free-form). Then:

```bash
ncl groups create --name "<name>"
```

Record the chosen or created agent group ID as `AG_ID`.

## Step 5 — Create the messaging group

```bash
ncl messaging-groups create \
  --name "${MG_NAME}" \
  --channel-type webapp \
  --platform-id "webapp:${APP_ID}" \
  --instance webapp \
  --is-group ${IS_GROUP} \
  --unknown-sender-policy ${SENDER_POLICY}
```

Record the returned messaging group ID as `MG_ID`.

If the command returns an error indicating the `platform_id` already exists, the messaging group is already registered. Retrieve the existing ID:

```bash
pnpm exec tsx scripts/q.ts data/v2.db \
  "SELECT id FROM messaging_groups WHERE platform_id='webapp:${APP_ID}'"
```

Use that ID as `MG_ID` and continue.

## Step 6 — Wire to agent group

```bash
ncl wirings create \
  --messaging-group-id "${MG_ID}" \
  --agent-group-id "${AG_ID}" \
  --engage-mode pattern \
  --engage-pattern "." \
  --sender-scope all \
  --session-mode per-thread
```

`engage-mode pattern` with `engage-pattern "."` means every message triggers the agent (as opposed to mention-only). `sender-scope all` works alongside `unknown_sender_policy` — `public` policy means all senders pass; `strict`/`request_approval` still apply at the messaging group level.

If a wiring between this messaging group and agent group already exists, skip this step.

## Step 7 — Per-app callback override (optional)

If this `app_id` needs a different callback URL than the default `WEBAPP_CALLBACK_URL` (e.g. a dev environment pointing at `localhost`):

Ask (free-form): "Does this app_id need its own callback URL, different from `WEBAPP_CALLBACK_URL`?"

If yes, ask for the URL and append to `.env`:

```bash
echo "WEBAPP_CALLBACK_URL_${APP_ID}=<url>" >> .env
mkdir -p data/env && cp .env data/env/env
```

## Step 8 — Restart NanoClaw

```bash
systemctl --user restart nanoclaw        # Linux
# launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
```

Wait a few seconds, then verify the adapter started:

```bash
grep "Webapp channel adapter listening" logs/nanoclaw.log | tail -3
```

## Step 9 — Smoke test

Verify end-to-end:

```bash
curl -s -o /dev/null -w "%{http_code}" \
  http://127.0.0.1:${WEBAPP_PORT:-3099}/health
```

Should return `200`.

Then send a test message (replace values as appropriate):

```bash
curl -s -X POST http://127.0.0.1:${WEBAPP_PORT:-3099}/message \
  -H "Content-Type: application/json" \
  -H "X-Shared-Secret: $(grep WEBAPP_SHARED_SECRET .env | cut -d= -f2)" \
  -d "{\"app_id\":\"${APP_ID}\",\"user_id\":\"test-user\",\"thread_id\":\"test-user\",\"message\":\"ping\"}"
```

Expected response: `{"status":"accepted"}`. The agent reply will arrive at your callback URL asynchronously (allow ~60s for cold start on the first message).

If the response is `404`, the messaging group registration didn't take — re-check step 5.
If the response is `401`, the shared secret in the curl command doesn't match `.env`.

## Summary

Show the user a summary of what was configured:

- **`app_id`**: `APP_ID`
- **Messaging group**: `MG_NAME` (`MG_ID`)
- **Platform ID**: `webapp:APP_ID`
- **Agent group**: name from `AG_ID`
- **Access policy**: `SENDER_POLICY`
- **Session isolation**: per-thread (each thread_id gets its own session) if IS_GROUP=1, else shared
- **Callback URL**: resolved per `WEBAPP_CALLBACK_URL` / `WEBAPP_CALLBACK_URL_APP_ID` override

Point the user to [docs/webapp-channel.md](../../docs/webapp-channel.md) for the full API contract to share with their API server developer.

## To add another environment

Re-run `/setup-webapp` with a different `app_id` (e.g. `myapp-dev`). Each `app_id` gets its own messaging group and can be wired to the same or a different agent group.
