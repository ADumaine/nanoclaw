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
 *   WEBAPP_SHARED_SECRET   — shared secret between NanoClaw and the API server
 *   WEBAPP_CALLBACK_URL    — URL NanoClaw POSTs responses to (your API server)
 *
 * Optional .env vars:
 *   WEBAPP_PORT            — port to listen on (default: 3099)
 *   WEBAPP_BIND_HOST       — bind address (default: 127.0.0.1)
 *
 * Inbound (API server → NanoClaw):
 *   POST /message
 *   Header: X-Shared-Secret: <secret>
 *   Body: { app_id, user_id, message, thread_id, role?, display_name? }
 *   Response: 202 { status: 'accepted' }
 *
 * Outbound (NanoClaw → API server):
 *   POST <WEBAPP_CALLBACK_URL>
 *   Header: X-Shared-Secret: <secret>
 *   Body (message): { app_id, thread_id, content, source: 'agent', timestamp }
 *   Body (typing):  { app_id, thread_id, type: 'typing', source: 'agent' }
 */
import http from 'http';

import { readEnvFile } from '../env.js';
import { log } from '../log.js';
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
    const port = parseInt(env.WEBAPP_PORT ?? String(DEFAULT_PORT), 10);
    const bindHost = env.WEBAPP_BIND_HOST ?? DEFAULT_BIND_HOST;

    let setupConfig: ChannelSetup | null = null;
    let server: http.Server | null = null;
    let connected = false;

    function parseBody(req: http.IncomingMessage): Promise<Record<string, string>> {
      return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', (chunk: Buffer) => (body += chunk));
        req.on('end', () => {
          try {
            resolve(JSON.parse(body) as Record<string, string>);
          } catch {
            reject(new Error('Invalid JSON'));
          }
        });
        req.on('error', reject);
      });
    }

    async function postCallback(payload: Record<string, unknown>): Promise<string | undefined> {
      const response = await fetch(callbackUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shared-Secret': sharedSecret,
        },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        log.warn('Webapp: callback delivery failed', { status: response.status, body });
        return undefined;
      }
      const result = (await response.json()) as Record<string, unknown>;
      return typeof result.message_id === 'string' ? result.message_id : undefined;
    }

    async function handleMessage(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
      if (req.headers['x-shared-secret'] !== sharedSecret) {
        res.writeHead(401).end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }

      let body: Record<string, string>;
      try {
        body = await parseBody(req);
      } catch {
        res.writeHead(400).end(JSON.stringify({ error: 'Invalid JSON' }));
        return;
      }

      const { app_id, user_id, display_name, role, message, thread_id } = body;

      const missing = ['app_id', 'user_id', 'message', 'thread_id'].filter((k) => !body[k]);
      if (missing.length > 0) {
        log.warn('Webapp: inbound request missing required fields', { missing, from: req.socket.remoteAddress });
        res.writeHead(400).end(JSON.stringify({ error: `Missing required fields: ${missing.join(', ')}` }));
        return;
      }

      // Respond immediately — agent reply arrives asynchronously via callback
      res.writeHead(202).end(JSON.stringify({ status: 'accepted' }));

      // Construct the full platform_id — must match what was registered in the DB
      const platformId = `${CHANNEL_TYPE}:${app_id}`;
      await setupConfig!.onInbound(platformId, thread_id, {
        id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        kind: 'chat',
        content: {
          text: message,
          senderId: user_id, // router prepends 'webapp:' → 'webapp:<user_id>'
          senderName: display_name ?? user_id,
          role: role ?? 'user', // informational — NanoClaw roles set via user_roles table
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
          try {
            if (req.method === 'POST' && req.url === '/message') {
              await handleMessage(req, res);
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
        try {
          return await postCallback({
            app_id: platformId,
            thread_id: threadId,
            content: message.content,
            source: 'agent',
            timestamp: new Date().toISOString(),
          });
        } catch (err) {
          log.error('Webapp: deliver error', { err, platformId, threadId });
          return undefined;
        }
      },

      async setTyping(platformId: string, threadId: string | null): Promise<void> {
        try {
          await postCallback({
            app_id: platformId,
            thread_id: threadId,
            type: 'typing',
            source: 'agent',
          });
        } catch {
          // typing indicators are best-effort
        }
      },
    };

    return adapter;
  },
});
