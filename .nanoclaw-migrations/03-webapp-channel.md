# 03 — Webapp Channel Adapter

## Intent

HTTP bridge channel adapter for the CryptoMondays web frontend. Accepts POST requests from the webapp, validates a JWT/Bearer token, and routes messages through NanoClaw. Supports per-app_id callback URLs so multiple frontend deployments can share one NanoClaw instance.

## Files

- `src/channels/webapp.ts` — **new file**, copy verbatim from main tree (358 lines)
- `src/channels/index.ts` — add one import line

## src/channels/index.ts

Add this import at the end of the channel registrations block:

```typescript
// webapp (native HTTP bridge for custom web frontends)
import './webapp.js';
```

## src/channels/webapp.ts

Copy the full file verbatim from the main tree. Key design points for a fresh session applying this:

**Authentication:** Bearer token in `Authorization` header, validated against `WEBAPP_SECRET` env var. Each request carries a JSON body with `app_id`, `user_id`, `auth_id`, `user_status`, `roles`, and `message`.

**Per-app_id routing:** The `app_id` field maps to a `messaging_group` via `platform_id`. Allows multiple webapp frontends (e.g. `cryptomondays`, `cryptomondays-dev`) to share one NanoClaw instance with different agent groups.

**Per-app_id callback URLs:** Env var pattern `WEBAPP_CALLBACK_URL_<APP_ID>` (uppercased, hyphens→underscores). E.g. `WEBAPP_CALLBACK_URL_CRYPTOMONDAYS=https://...`. Fallback to `WEBAPP_CALLBACK_URL`. Used to deliver agent responses back to the correct frontend.

**Thread model:** Per-user thread per app: `thread_id = <user_id>` (one conversation per user per webapp instance).

**User context:** Passes `auth_id`, `user_status`, `roles` in the message's `user_context` JSON field. Agent reads these to enforce role-based access.

**Env vars required:**
- `WEBAPP_SECRET` — shared secret for Bearer auth
- `WEBAPP_PORT` — port to listen on (default 3001)
- `WEBAPP_CALLBACK_URL` — default callback URL
- `WEBAPP_CALLBACK_URL_<APP_ID>` — per-app overrides
