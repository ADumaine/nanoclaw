# CM Data API — NanoClaw Agent Integration & Application Summary

## Overview
- Purpose: Node/Express API for Cryptomondays data and tooling (video metadata, transcripts, embeddings, AI proxy, admin/user management).
- Entry point: `server/server.js` — main HTTP server, routes, middleware, and startup tasks.
- Config: central settings in `config/config.js` (server ports, secrets, Google keys, AI provider config).

## Architecture & Core Components
- Express server with JSON and URL-encoded parsing, optional CORS, `express-session`, and Swagger UI.
- Services (domain logic) under `server/services/`:
  - `db.js` — MySQL (Knex) access and schema helpers.
  - `youtube.js` — YouTube metadata and download helpers.
  - `transcription.js` — Speakr/transcription workflows.
  - `embeddings.js` — chunking, embedding generation, Milvus storage.
  - `ai.js` — generic LLM provider abstraction and `callProvider()`.
  - `supabase.js` — Supabase client helpers for chat_sessions and profiles.
  - `notion.js`, `sheetdata.js`, `luma.js`, `kb.js` — other integrations.
- Helpers/middleware: `authorize.js` (JWT), `checkAPIToken.js`, `error-handler.js`, and `logger.js`.

## Authentication & Authorization
- Site API tokens: header-based tokens used by most website/agent endpoints via `checkApiToken` and `checkKbaiApiToken`.
- JWT + `authorize()` for admin/user routes (routes under `/users`).
- Sessions: `express-session` for OAuth flows (Google) and some session-based features (e.g., inquire/search token budget).
- NanoClaw secret: `process.env.NANOCLAW_SECRET` or `config.secret`.

## Configuration & Env Validation
- `validateEnv.js` ensures required environment variables before startup.
- AI providers configured under `config.ai.providers`; `server/services/ai.js` chooses provider.

## Data Persistence & Caching
- Primary DB: MySQL (via `server/services/db.js`) with schema in `dbschemas/mysql-db.sql`.
- Vector DB: Milvus (for embeddings and collections) accessed via `server/services/embeddings.js`.
- Supabase: used for chat sessions, profiles, and some KB flows (`server/services/supabase.js`).
- In-memory cache: `Cache` Map in `server/server.js` (e.g., cached chapter data from Google Sheets).

## Key Routes (grouped)
- General / Health
  - `GET /` — basic response.
  - `GET /ucount` — total user count.
- Auth
  - `GET /auth/google`, `GET /auth/google/callback`, `GET /auth/google/logout` — Google OAuth flows.
- Users
  - `app.use('/users', userRoutes)` — JWT-protected user admin/auth endpoints.
- Google Sheets / Website Data
  - `GET /chapters` — fetch and cache chapter data from Google Sheets.
- YouTube & Media
  - `GET /playlist`, `GET /playlistitems`, `GET /videolist`, `GET /videodetails`, `GET /downloadaudio`, `GET /downloadvideo`, `POST /video` and DB-backed lists (`/videolistdb`, `/videoids`, `/playlistsdb`).
- Transcription & Speakr
  - `POST /transcribe/queue` — batch download + transcription.
  - `POST /speakr/ingest` — ingest Speakr recordings: fetch transcripts, chunk, embed, store.
  - `POST /updateSpeakrRecordings` — sync Speakr metadata with DB.
  - `GET /video/summary`, `GET /video/transcript` — retrieve summaries/transcripts.
- Embeddings & Collections
  - `GET /tran/search` — search Milvus transcripts.
  - `GET /chunks` — get chunks by video id.
  - `GET /collections`, `POST /collections`, `POST /collections/active`, `POST /collections/drop` — manage Milvus collections.
- AI
  - `POST /ai` — generic AI provider proxy (`callProvider()`), timing/logging, chunked calls support.
  - `GET /ai/providers` — list configured AI providers.
- Knowledgebase & Inquire
  - `GET /kb/search` — KB semantic search.
  - `POST /inquire/search` — guarded semantic search (feature-flagged; forwards cookies; optional token budget enforcement).
- Luma
  - `GET /luma/events`, `GET /luma/people`, `GET /luma/calendar-events`.

## NanoClaw Agent Integration (message flow)
### Outbound (from app to NanoClaw)
- Endpoint: `POST /agent/message` (protected by `checkApiToken`).
- Body must include: `thread_id` and `message`.
- Server extracts `userId` from `req.user?.id || 'anonymous'` and roles from `req.user?.app_metadata?.roles || req.user?.role` coerced to an array.
- Forwards fire-and-forget POST to `<NANOCLAW_URL>/message` with JSON body:
  - `app_id` (env `NANOCLAW_APP_ID` or `cryptomondays`), `thread_id`, `message`, `user_id`, `roles`.
- Uses header `x-shared-secret: NANOCLAW_SECRET` for authentication.
- Responds immediately with `{ status: 'queued' }`.

### Inbound (NanoClaw callback to app)
- Endpoint: `POST /agent/callback` (validates `x-shared-secret` header).
- Expects `{ thread_id, content }` in body. Validates both present.
- Loads Supabase `chat_sessions` row by `id = thread_id` and selects `messages` and `token_count`.
- Appends an assistant message object to `messages`:
  - `{ id: <uuid>, role: 'assistant', content: <text>, source: 'agent', timestamp: <ISO> }`.
- Updates `chat_sessions` row (`messages`, `updated_at`).
- Responds `{ success: true }`.

### Security and Roles
- Outbound is guarded by API token middleware; inbound callback is guarded by shared secret header.
- Roles are forwarded as an array so NanoClaw can apply role-based behavior/policies.

## Operational Notes
- Server timeout extended to 12 minutes for long ingestion/transcription tasks.
- `/chapters` refreshes cache in background when serving cached data.
- Error handling via `logIt()` and `error-handler` middleware.
- Some server features are feature-flagged via config or env vars (e.g., inquire search).

## Where Chat & Agent State Lives
- Chat sessions: persisted in Supabase `chat_sessions` table (`messages` array, `token_count`, `updated_at`).
- Session/OAuth: `express-session` stores temporary session data (Google OAuth, etc.).
- Content/meta: MySQL for video metadata; Milvus for vector chunks/embeddings.

## Implications for Building NanoClaw Multiuser Assistant
- Use `POST /agent/message` as the canonical ingestion point for user messages; include a unique `thread_id` per conversation.
- NanoClaw should call `POST /agent/callback` with the assistant content; the app will persist it into Supabase for clients to read.
- Ensure Supabase `chat_sessions` rows exist before NanoClaw callbacks arrive; implement a session-creation flow if needed.
- Roles and user_id are available for personalization and access control.
- For retrieval-augmented generation, NanoClaw can call server KB/search endpoints or the server can orchestrate retrieval and pass context to NanoClaw.

## Recommended Next Steps
1. Verify Supabase `chat_sessions` schema: required fields are `id`, `messages` (array), `token_count`, `updated_at`.
2. Add a `POST /agent/session` endpoint (optional) to create/initialize `chat_sessions` rows to guarantee existence prior to messages/callbacks.
3. Harden security: rotate/store `NANOCLAW_SECRET` securely, consider HMAC signing or mutual TLS for callbacks, and rate-limit `/agent/message`.
4. Add observability: include `thread_id` in logs and add metrics for queueing/callback latency and failures.
5. Provide a test harness or Postman collection that simulates `/agent/message` and `/agent/callback` flows.

---
If you want, I can add a `POST /agent/session` endpoint, produce a Postman collection, or generate a formal NanoClaw payload schema and examples.
