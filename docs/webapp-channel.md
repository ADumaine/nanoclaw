# Webapp Channel — Integration Guide

The webapp channel is an HTTP bridge that lets a custom web frontend talk to NanoClaw. NanoClaw acts as an AI agent sidecar: your API server owns auth, chat history display, and the user experience; NanoClaw owns the agent conversation, tool calls, and response generation.

## Separation of responsibilities

| Your API server | NanoClaw |
|----------------|---------|
| Validates user auth (JWT, session, cookie) | Runs the agent and generates replies |
| Stores and displays chat messages | Stores agent conversation context (per-session SQLite) |
| Renders the chat UI | Manages session lifecycle and container isolation |
| Sends messages to NanoClaw | Delivers agent replies via your callback URL |
| Implements the callback endpoint | Calls agent tools, memory, and MCP servers |

NanoClaw does **not** store messages for display purposes. It stores the Claude conversation history needed to continue each session. Your API server is responsible for persisting the full message log and rendering it to users.

## Message flow

```
User sends message
       ↓
API server (validates auth, stores message)
       ↓  POST /message  X-Shared-Secret: <secret>
NanoClaw webapp adapter
       ↓
Router → session resolution → inbound.db
       ↓
Agent container (Claude processes the message)
       ↓
outbound.db → delivery poll
       ↓  POST <WEBAPP_CALLBACK_URL>  X-Shared-Secret: <secret>
API server (stores reply, delivers to user)
```

The `/message` endpoint returns `202 Accepted` immediately. The agent reply arrives asynchronously via callback, typically within a few seconds for an active session or ~30–60 seconds for a cold-start (first message on a new thread).

## Prerequisites

Before running `/add-webapp` and `/setup-webapp`:

1. **A callback endpoint** on your API server that accepts `POST` requests with `X-Shared-Secret` header and a JSON body (see [Outbound callback](#outbound-callback) below).
2. **A shared secret** — generate one with `openssl rand -hex 32`. The same value goes in NanoClaw's `.env` as `WEBAPP_SHARED_SECRET` and in your API server's config.
3. **An `app_id`** — a short string that identifies your frontend (e.g. `myapp`, `myapp-prod`). It maps to one NanoClaw messaging group. Use different `app_id` values for dev/staging/prod environments.
4. **NanoClaw's HTTP port reachable from your API server** — default port 3099. If the API server runs on a different host, set `WEBAPP_BIND_HOST=0.0.0.0` and open the port in your firewall.

## API reference

### POST /message

Forward a user message to NanoClaw. Call this from your API server after validating the user's auth.

**Request header:** `X-Shared-Secret: <WEBAPP_SHARED_SECRET>`

**Request body:**

```json
{
  "app_id": "myapp",
  "user_id": "user-123",
  "thread_id": "user-123",
  "message": "Hello, what can you help me with?",
  "display_name": "Alice",
  "roles": ["member"],
  "user_context": {
    "auth_id": "uuid-from-your-auth-system",
    "plan": "pro",
    "any_extra": "fields the agent needs"
  }
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `app_id` | Yes | Identifies which messaging group to route to. Must match what was registered via `/setup-webapp`. |
| `user_id` | Yes | Your platform's identifier for this user. Becomes `webapp:<user_id>` in NanoClaw's user table. |
| `thread_id` | Yes | Controls session isolation — see [Thread ID strategy](#thread-id-strategy). |
| `message` | Yes* | The user's message text. Required unless this is a question response (`question_id` + `selected_option` instead). |
| `display_name` | No | Human-readable name shown in logs and potentially to the agent. Defaults to `user_id`. |
| `roles` | No | Array of role strings forwarded to the agent as context. NanoClaw access is controlled separately via `unknown_sender_policy`, not this field. |
| `user_context` | No | Arbitrary JSON object passed to the agent verbatim. Include anything the agent needs: auth_id, subscription tier, preferences, etc. |
| `llm_mode` | No | Optional string forwarded inside `user_context`. Useful for switching agent behavior per request. |

**Response:** `202 { "status": "accepted" }` — the agent reply arrives later via callback.

**Error responses:**

| Status | Meaning |
|--------|---------|
| 401 | `X-Shared-Secret` header missing or wrong |
| 400 | Missing required fields or invalid JSON |
| 404 | No messaging group found for this `app_id` — run `/setup-webapp` |

---

### POST /close

Call when a user deletes or explicitly closes a chat. Kills the agent container and removes the session from NanoClaw. Idempotent — safe to call even if the session is already gone.

**Request header:** `X-Shared-Secret: <WEBAPP_SHARED_SECRET>`

**Request body:** `{ "app_id": "myapp", "thread_id": "user-123" }`

**Response:** `200 { "status": "closed" }`

This frees container resources immediately rather than waiting for the idle timeout. Call it on user-initiated chat deletion but not on browser close — users expect to continue a conversation when they return.

---

### GET /health

Returns `200 { "status": "ok" }` when the adapter is running. Use for load balancer health checks or uptime monitoring.

---

### Outbound callback

NanoClaw POSTs agent replies to `WEBAPP_CALLBACK_URL`. Your API server must implement this endpoint.

**Request header:** `X-Shared-Secret: <WEBAPP_SHARED_SECRET>`

**Message payload:**

```json
{
  "app_id": "webapp:myapp",
  "thread_id": "user-123",
  "content": "Agent reply in markdown",
  "format": "markdown",
  "type": "message",
  "source": "agent",
  "timestamp": "2025-01-01T12:00:00.000Z",
  "tokens_used": 1234,
  "model": "claude-sonnet-4-6"
}
```

> **Note:** `app_id` in the callback is the full NanoClaw platform ID — `webapp:<app_id>`, not just `<app_id>`. Your callback handler should strip the `webapp:` prefix if you need the bare `app_id`.

**Typing indicator payload** (best-effort, may be absent or rejected):

```json
{
  "app_id": "webapp:myapp",
  "thread_id": "user-123",
  "type": "typing",
  "source": "agent"
}
```

**Expected response:** Any `2xx` response is accepted. Return `{ "message_id": "<string>" }` if you want NanoClaw to track the stored message ID. Typing indicator errors are logged at debug level and do not affect message delivery — many API servers ignore or reject typing payloads and that's fine.

## User identity

The `user_id` you send in the request body becomes `webapp:<user_id>` in NanoClaw's `users` table. This namespaced ID is how NanoClaw identifies the sender across requests.

NanoClaw auto-creates a `users` row on first sight — you do not need to pre-register users. Whether a user can actually send messages to the agent is controlled separately by `unknown_sender_policy` (see [Access control](#access-control)).

If you have an internal auth ID (e.g. a Supabase UUID) that differs from `user_id`, pass it as `user_context.auth_id`. NanoClaw forwards it to the agent verbatim.

## Access control

`unknown_sender_policy` on the messaging group controls what happens when a user who isn't an owner, admin, or member of the agent group sends a message:

| Policy | Behavior | When to use |
|--------|----------|-------------|
| `public` | Any user_id passes through without membership check | Open webapp — any authenticated user can chat |
| `request_approval` | Message held; admin gets a DM card to approve/deny. On approve, user is added to members and the held message is replayed | Closed community with self-serve onboarding |
| `strict` | Message dropped silently | When you want to pre-register users manually via `ncl members add` |

For most webapps `public` is correct. Your API server has already validated the user's auth; NanoClaw doesn't need to re-gate them.

## Session isolation

### The `is_group` flag

The messaging group's `is_group` flag tells the router whether this is a multi-user channel. This is the most important configuration decision.

- **`is_group = 1`** — router forces `per-thread` session mode. Each `thread_id` value gets its own isolated agent session (and its own Docker container). Use this for any webapp where multiple users send messages.
- **`is_group = 0`** (default) — all traffic collapses to a single shared session. Every `thread_id` lands in the same container. Only appropriate for a single-user personal assistant frontend.

### Thread ID strategy

`thread_id` in each request is the session key. You control the granularity:

| Strategy | `thread_id` value | Result |
|----------|------------------|--------|
| One conversation per user | `user_id` | Each user has their own persistent conversation |
| One conversation per chat room | chat room ID | Multiple users share one agent session |
| Fresh session each page load | `uuid()` per load | Stateless — no cross-request memory within NanoClaw |

The most common pattern for a webapp assistant is `thread_id = user_id`. The agent then maintains a continuous conversation with each user across sessions, container restarts, and NanoClaw restarts.

### Container lifecycle

Each unique `thread_id` maps to one agent container. Containers start on first message (~30–60s cold start), stay alive while active, and are killed by the host sweep when idle. Conversation context persists in SQLite between starts — the agent picks up where it left off.

Call `POST /close` when a user deletes a chat to free the container immediately.

## Passing context to the agent

The `user_context` object is forwarded verbatim to the agent in the message content. The agent reads it from the conversation as JSON. Include anything the agent needs to personalize its response or enforce business rules:

```json
{
  "auth_id": "uuid-from-supabase",
  "plan": "pro",
  "locale": "en-US",
  "org_id": "org-456"
}
```

The `roles` array is also forwarded and visible to the agent, but it is informational only — NanoClaw access control is governed by `unknown_sender_policy` and agent group membership, not the `roles` field.

`llm_mode`, if sent, is merged into `user_context` automatically.

## Interactive questions (agent → user)

The agent can ask the user a multiple-choice question using the `ask_user_question` MCP tool. NanoClaw sends the question to your callback URL with `type: "question"` in the payload (via the Chat SDK shape). When the user answers, your API server POSTs back to `/message` with `question_id` and `selected_option` instead of `message`:

```json
{
  "app_id": "myapp",
  "user_id": "user-123",
  "thread_id": "user-123",
  "question_id": "q-abc123",
  "selected_option": "option-value"
}
```

NanoClaw unblocks the waiting tool call and the agent continues. No `message` field is needed for question responses.

## Multiple environments

To share one NanoClaw instance across dev and prod (or any number of environments):

1. Register a separate messaging group per `app_id` via `/setup-webapp` (run it once per environment).
2. Add per-environment callback overrides in `.env`:

```bash
WEBAPP_CALLBACK_URL=https://api.example.com/agent-callback       # default fallback
WEBAPP_CALLBACK_URL_myapp-dev=http://localhost:4000/agent-callback
WEBAPP_CALLBACK_URL_myapp-prod=https://api.example.com/agent-callback
```

Key format: `WEBAPP_CALLBACK_URL_<app_id>` — exact match, case-sensitive. The default `WEBAPP_CALLBACK_URL` is used for any `app_id` that doesn't have its own override.

Each environment can point to a different agent group if you want isolated agent workspaces, or share one agent group if you want dev and prod to share memory and configuration.

## See also

- [docs/isolation-model.md](isolation-model.md) — the three session isolation levels in full
- `/add-webapp` — install the channel adapter
- `/setup-webapp` — configure a messaging group, access policy, and wiring
