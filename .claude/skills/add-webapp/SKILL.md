---
name: add-webapp
description: Install the webapp HTTP bridge channel adapter. Copies webapp.ts into src/channels/, registers it in the barrel, and builds. Run /setup-webapp afterward to configure a messaging group, access policy, and wiring.
---

# Add Webapp Channel

Installs the `webapp` channel adapter — an HTTP bridge that accepts `POST /message` from your API server and delivers agent replies via a callback URL.

Read [docs/webapp-channel.md](../../docs/webapp-channel.md) before proceeding if you haven't already. It covers the separation of responsibilities, API contract, session isolation decisions, and prerequisites your API server must satisfy.

## Pre-flight (idempotent)

Skip to **Next steps** if all of these are already true:

- `src/channels/webapp.ts` exists
- `src/channels/index.ts` contains `import './webapp.js';`

## Install

### 1. Copy the adapter

```bash
cp "${CLAUDE_SKILL_DIR}/webapp.ts" src/channels/webapp.ts
```

### 2. Register in the barrel

Append to `src/channels/index.ts` (skip if the line is already present):

```typescript
// webapp (native HTTP bridge for custom web frontends)
import './webapp.js';
```

### 3. Build

```bash
pnpm run build
```

Build must be clean before continuing. The adapter uses only Node's built-in `http` module — no npm dependencies to install.

## Environment variables

Add to `.env`:

```bash
WEBAPP_SHARED_SECRET=<secret>          # generate: openssl rand -hex 32
WEBAPP_CALLBACK_URL=https://your-api.example.com/agent-callback

# Optional
WEBAPP_PORT=3099                       # default: 3099
WEBAPP_BIND_HOST=127.0.0.1             # set 0.0.0.0 if API server is on another host

# Per-app_id callback overrides (add as needed after /setup-webapp)
# WEBAPP_CALLBACK_URL_myapp-dev=http://localhost:4000/agent-callback
```

Sync to container after editing: `mkdir -p data/env && cp .env data/env/env`

Both `WEBAPP_SHARED_SECRET` and `WEBAPP_CALLBACK_URL` are required for the adapter to start. The adapter silently skips registration if either is missing.

## Next steps

Run `/setup-webapp` to create the messaging group, configure access policy, wire to an agent group, and restart NanoClaw.

## Troubleshooting

| Symptom | Check |
|---------|-------|
| Adapter not starting | Verify `WEBAPP_SHARED_SECRET` and `WEBAPP_CALLBACK_URL` are set in `.env` |
| `404` on `/message` | Messaging group not registered yet — run `/setup-webapp` |
| `401 Unauthorized` | `X-Shared-Secret` header doesn't match `WEBAPP_SHARED_SECRET` |
| Agent never replies | Check `logs/nanoclaw.error.log`; verify callback URL is reachable from this host |

## Channel info

- **type**: `webapp`
- **supports-threads**: yes
- **typical-use**: Custom web frontend — one agent session per user, isolated per `thread_id`
- **default-isolation**: `per-thread` (forced automatically when `is_group=1`)
- **how-to-find-id**: The `platform_id` is `webapp:<app_id>` where `app_id` is the value sent in each `POST /message` request body.
