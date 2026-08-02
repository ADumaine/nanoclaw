/**
 * Webapp channel adapter — HTTP bridge for custom web frontends.
 *
 * Exposes a local HTTP server that accepts messages from an external API
 * server (which has already validated the user's JWT) and delivers agent
 * responses back via a callback URL.
 *
 * Designed for white-labelled deployments: each community_id maps to one
 * NanoClaw messaging group / agent group pair.
 *
 * Required .env vars:
 *   WEBAPP_SHARED_SECRET              — shared secret between NanoClaw and the API server
 *   WEBAPP_CALLBACK_URL               — default URL NanoClaw POSTs responses to
 *
 * Optional .env vars:
 *   WEBAPP_PORT                       — port to listen on (default: 3099)
 *   WEBAPP_BIND_HOST                  — bind address (default: 127.0.0.1)
 *   WEBAPP_CALLBACK_URL_<app_id>      — per-app_id callback override; takes precedence
 *                                       over WEBAPP_CALLBACK_URL for that app_id.
 *                                       Allows multiple API servers (e.g. dev, beta) to
 *                                       share one NanoClaw instance.
 *
 * Inbound (API server → NanoClaw):
 *   POST /message
 *   Header: X-Shared-Secret: <secret>
 *   Body: { app_id, user_id, message, thread_id, display_name?, roles?: string[],
 *           user_context?: { home_chapter?, home_chapter_country?, expertise?,
 *                            interests?, badges?, token_budget_remaining? } }
 *   Response: 202 { status: 'accepted' }
 *
 *   POST /close
 *   Header: X-Shared-Secret: <secret>
 *   Body: { app_id, thread_id }
 *   Response: 200 { status: 'closed' }
 *   Call when the user deletes a chat. Kills the container and removes the
 *   session. Idempotent — returns 200 if the session is already gone.
 *
 * Outbound (NanoClaw → API server):
 *   POST <WEBAPP_CALLBACK_URL>
 *   Header: X-Shared-Secret: <secret>
 *   Body (message): { app_id, thread_id, content, format: 'markdown', source: 'agent', timestamp, tokens_used?, model? }
 *   Body (typing):  { app_id, thread_id, type: 'typing', source: 'agent' }
 */
import fs from 'fs';
import http from 'http';

import { getMessagingGroupByPlatform } from '../db/messaging-groups.js';
import { findRecentPlatformIdForHandle, findSession, deleteSession } from '../db/sessions.js';
import { readEnvFile, readEnvPrefix } from '../env.js';
import { log } from '../log.js';
import { killContainer } from '../container-runner.js';
import { sessionDir } from '../session-manager.js';
import { registerChannelAdapter } from './channel-registry.js';
import type { ChannelAdapter, ChannelSetup, OutboundMessage } from './adapter.js';

const CHANNEL_TYPE = 'webapp';
const DEFAULT_PORT = 3099;
const DEFAULT_BIND_HOST = '127.0.0.1';

registerChannelAdapter(CHANNEL_TYPE, {
  factory: () => {
    const env = readEnvFile(['WEBAPP_SHARED_SECRET', 'WEBAPP_CALLBACK_URL', 'WEBAPP_PORT', 'WEBAPP_BIND_HOST']);

    if (!env.WEBAPP_SHARED_SECRET || !env.WEBAPP_CALLBACK_URL) return null;

    const sharedSecret = env.WEBAPP_SHARED_SECRET;
    const callbackUrl = env.WEBAPP_CALLBACK_URL;
    // Per-app_id overrides: WEBAPP_CALLBACK_URL_<app_id>=http://...
    // Allows dev and beta API servers to share one NanoClaw instance.
    const callbackUrlOverrides = readEnvPrefix('WEBAPP_CALLBACK_URL_');
    const port = parseInt(env.WEBAPP_PORT ?? String(DEFAULT_PORT), 10);
    const bindHost = env.WEBAPP_BIND_HOST ?? DEFAULT_BIND_HOST;

    let setupConfig: ChannelSetup | null = null;
    let server: http.Server | null = null;
    let connected = false;

    function parseBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
      return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', (chunk: Buffer) => (body += chunk));
        req.on('end', () => {
          try {
            resolve(JSON.parse(body) as Record<string, unknown>);
          } catch {
            reject(new Error('Invalid JSON'));
          }
        });
        req.on('error', reject);
      });
    }

    async function postCallback(
      payload: Record<string, unknown>,
      targetUrl = callbackUrl,
    ): Promise<string | undefined> {
      const response = await fetch(targetUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shared-Secret': sharedSecret,
        },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        // Typing indicator calls don't carry content; many API servers reject them.
        // Log at debug to avoid noise, but don't fail — typing is best-effort.
        if (payload.type === 'typing') {
          log.debug('Webapp: typing callback rejected (best-effort)', { status: response.status });
        } else {
          log.warn('Webapp: callback delivery failed', { status: response.status, body });
        }
        return undefined;
      }
      const result = (await response.json()) as Record<string, unknown>;
      return typeof result.message_id === 'string' ? result.message_id : undefined;
    }

    async function handleClose(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
      if (req.headers['x-shared-secret'] !== sharedSecret) {
        res.writeHead(401).end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }

      let body: Record<string, unknown>;
      try {
        body = await parseBody(req);
      } catch {
        res.writeHead(400).end(JSON.stringify({ error: 'Invalid JSON' }));
        return;
      }

      const app_id = body.app_id as string | undefined;
      const thread_id = body.thread_id as string | undefined;
      if (!app_id || !thread_id) {
        res.writeHead(400).end(JSON.stringify({ error: 'Missing required fields: app_id, thread_id' }));
        return;
      }

      const platformId = `${CHANNEL_TYPE}:${app_id}`;
      const mg = getMessagingGroupByPlatform(CHANNEL_TYPE, platformId);
      if (!mg) {
        res.writeHead(404).end(JSON.stringify({ error: 'Messaging group not found' }));
        return;
      }

      const session = findSession(mg.id, thread_id);
      if (!session) {
        // Already gone — treat as success
        res.writeHead(200).end(JSON.stringify({ status: 'closed' }));
        return;
      }

      killContainer(session.id, 'chat-closed');
      deleteSession(session.id);
      try {
        fs.rmSync(sessionDir(session.agent_group_id, session.id), { recursive: true, force: true });
      } catch (err) {
        log.warn('Webapp: failed to remove session dir on close', { sessionId: session.id, err });
      }

      log.info('Webapp: session closed by API', { sessionId: session.id, threadId: thread_id });
      res.writeHead(200).end(JSON.stringify({ status: 'closed' }));
    }

    async function handleMessage(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
      if (req.headers['x-shared-secret'] !== sharedSecret) {
        log.warn('Webapp: inbound /message rejected — bad secret', {
          from: req.socket.remoteAddress,
          header: req.headers['x-shared-secret'] ? '(present but wrong)' : '(missing)',
        });
        res.writeHead(401).end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }

      let body: Record<string, unknown>;
      try {
        body = await parseBody(req);
      } catch {
        log.warn('Webapp: inbound /message rejected — invalid JSON body', { from: req.socket.remoteAddress });
        res.writeHead(400).end(JSON.stringify({ error: 'Invalid JSON' }));
        return;
      }

      log.info('Webapp: inbound /message body keys', {
        keys: Object.keys(body),
        hasQuestionId: !!(body.question_id || body.questionId),
        hasSelectedOption: !!(body.selected_option || body.selectedOption),
      });

      const app_id = body.app_id as string | undefined;
      const user_id = body.user_id as string | undefined;
      const display_name = body.display_name as string | undefined;
      const message = body.message as string | undefined;
      const thread_id = body.thread_id as string | undefined;
      const question_id = body.question_id as string | undefined;
      const selected_option = body.selected_option as string | undefined;
      const roles = Array.isArray(body.roles) ? (body.roles as string[]) : body.roles ? [String(body.roles)] : [];
      const user_context = body.user_context && typeof body.user_context === 'object' ? body.user_context : undefined;
      const llm_mode = typeof body.llm_mode === 'string' ? body.llm_mode : undefined;

      const isQuestionResponse = !!(question_id && selected_option);
      const missing = ['app_id', 'user_id', 'thread_id'].filter((k) => !body[k]);
      if (!isQuestionResponse && !message) missing.push('message');
      if (missing.length > 0) {
        log.warn('Webapp: inbound request missing required fields', { missing, from: req.socket.remoteAddress });
        res.writeHead(400).end(JSON.stringify({ error: `Missing required fields: ${missing.join(', ')}` }));
        return;
      }

      // Respond immediately — agent reply arrives asynchronously via callback
      res.writeHead(202).end(JSON.stringify({ status: 'accepted' }));

      // Question response — unblock the waiting ask_user_question tool call
      if (isQuestionResponse) {
        log.info('Webapp: question response received', { question_id, selected_option, user_id });
        setupConfig!.onAction(question_id, selected_option, `${CHANNEL_TYPE}:${user_id}`);
        return;
      }

      log.info('Webapp: routing message', { app_id, user_id, thread_id, platformId: `webapp:${app_id}` });

      // Construct the full platform_id — must match what was registered in the DB
      const platformId = `${CHANNEL_TYPE}:${app_id}`;
      await setupConfig!.onInbound(platformId, thread_id!, {
        id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        kind: 'chat',
        content: {
          text: message,
          senderId: user_id, // router prepends 'webapp:' → 'webapp:<user_id>'
          sender: display_name ?? user_id, // 'sender' is what formatter.ts looks for
          roles, // informational — NanoClaw roles set via user_roles table
          user_context: {
            ...(user_context ?? {}),
            // Prefer explicit auth_id from caller (e.g. Telegram resolved to Supabase UUID).
            // Fall back to user_id so the agent always has something to forward.
            auth_id: (user_context as Record<string, unknown>)?.auth_id ?? user_id,
            ...(llm_mode ? { llm_mode } : {}),
          },
        },
        timestamp: new Date().toISOString(),
      });
    }

    const adapter: ChannelAdapter = {
      name: 'webapp',
      channelType: CHANNEL_TYPE,
      supportsThreads: true,

      async setup(config: ChannelSetup): Promise<void> {
        setupConfig = config;

        server = http.createServer(async (req, res) => {
          res.setHeader('Content-Type', 'application/json');
          log.debug('Webapp: inbound request', { method: req.method, url: req.url, from: req.socket.remoteAddress });
          try {
            if (req.method === 'POST' && req.url === '/message') {
              await handleMessage(req, res);
            } else if (req.method === 'POST' && req.url === '/close') {
              await handleClose(req, res);
            } else if (req.method === 'GET' && req.url === '/health') {
              res.writeHead(200).end(JSON.stringify({ status: 'ok' }));
            } else {
              res.writeHead(404).end(JSON.stringify({ error: 'Not found' }));
            }
          } catch (err) {
            log.error('Webapp adapter: unhandled request error', { err });
            if (!res.headersSent) res.writeHead(500).end(JSON.stringify({ error: 'Internal error' }));
          }
        });

        await new Promise<void>((resolve, reject) => {
          server!.listen(port, bindHost, () => {
            connected = true;
            log.info('Webapp channel adapter listening', { host: bindHost, port });
            resolve();
          });
          server!.on('error', reject);
        });
      },

      async teardown(): Promise<void> {
        connected = false;
        await new Promise<void>((resolve) => {
          if (server) server.close(() => resolve());
          else resolve();
        });
      },

      isConnected(): boolean {
        return connected;
      },

      async deliver(
        platformId: string,
        threadId: string | null,
        message: OutboundMessage,
      ): Promise<string | undefined> {
        // Refuse rather than send a callback with no thread_id. The API server's
        // own behavior on a missing thread_id is to fall back to guessing the
        // user's most-recently-active session — which silently misattributes
        // the message to an unrelated chat rather than failing loudly. Confirmed
        // live 2026-07-27: an onboarding-agent test message landed in the
        // operator's Community Assistant chat history this way. Dropping here
        // (best-effort, matches the existing catch-block contract below) is
        // safer than shipping a callback we know will be misrouted.
        if (!threadId) {
          log.error('Webapp: refusing to deliver — no thread_id resolved', { platformId });
          return undefined;
        }
        try {
          const raw = message.content as Record<string, unknown> | null;
          const contentText: string = typeof raw?.text === 'string' ? raw.text : JSON.stringify(message.content);
          const tokensUsed = typeof raw?.tokens_used === 'number' ? raw.tokens_used : undefined;
          const model = typeof raw?.model === 'string' ? raw.model : undefined;
          const appId = platformId.startsWith(`${CHANNEL_TYPE}:`)
            ? platformId.slice(CHANNEL_TYPE.length + 1)
            : platformId;
          const resolvedCallbackUrl = callbackUrlOverrides[appId] ?? callbackUrl;
          log.info('Webapp deliver raw keys', {
            keys: raw ? Object.keys(raw) : null,
            model,
            tokensUsed,
            callbackUrl: resolvedCallbackUrl,
          });
          return await postCallback(
            {
              app_id: platformId,
              thread_id: threadId,
              content: contentText,
              format: 'markdown',
              ...(tokensUsed !== undefined ? { tokens_used: tokensUsed } : {}),
              ...(model !== undefined ? { model } : {}),
              type: 'message',
              source: 'agent',
              timestamp: new Date().toISOString(),
            },
            resolvedCallbackUrl,
          );
        } catch (err) {
          log.error('Webapp: deliver error', { err, platformId, threadId });
          return undefined;
        }
      },

      async setTyping(platformId: string, threadId: string | null): Promise<void> {
        if (!threadId) return; // same misrouting risk as deliver() above — silently skip
        try {
          const appId = platformId.startsWith(`${CHANNEL_TYPE}:`)
            ? platformId.slice(CHANNEL_TYPE.length + 1)
            : platformId;
          await postCallback(
            {
              app_id: platformId,
              thread_id: threadId,
              type: 'typing',
              source: 'agent',
            },
            callbackUrlOverrides[appId] ?? callbackUrl,
          );
        } catch {
          // typing indicators are best-effort
        }
      },

      // The generic webapp bridge has no native "open a DM" platform API
      // (unlike Discord's POST /users/@me/channels) — many app_ids/bots
      // share this one HTTP adapter, so a bare handle (e.g. a raw Telegram
      // numeric ID) is meaningless without knowing which app_id it actually
      // belongs to. Without this, ensureUserDm's no-openDM fallback treats
      // the handle as directly addressable and returns it bare, producing
      // an unroutable platform_id downstream (confirmed live: a proactive
      // approval-card delivery sent app_id="5945384141" instead of
      // "webapp:telegram_onboarding_bot", and the receiving API server had
      // to guess a fallback thread — and guessed wrong).
      async openDM(handle: string): Promise<string> {
        const platformId = findRecentPlatformIdForHandle(CHANNEL_TYPE, handle);
        if (!platformId) {
          throw new Error(`webapp openDM: no prior session found for handle "${handle}"`);
        }
        return platformId;
      },
    };

    return adapter;
  },
});
