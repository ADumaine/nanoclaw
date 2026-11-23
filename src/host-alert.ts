/**
 * Best-effort operator alerts from the host.
 *
 * POSTs { source: "host", kind, detail } to the MonDAI API's
 * /agent/onboarding/alert, which formats it and posts to the system-admin
 * Telegram topic (dev/prod tagged by the API). The API de-duplicates by `kind`
 * for 10 minutes; we also keep a short local guard so an outage does not turn
 * into a stream of failing HTTP calls.
 *
 * Never throws and never blocks the caller: a failure to alert is only logged.
 * No-op when the webapp channel is not configured or under test.
 *
 * Do not put message bodies, emails or secrets in `detail` (the API truncates
 * it to 500 chars, but it lands in a chat topic).
 */
import { readEnvFile } from './env.js';
import { log } from './log.js';

const ALERT_PATH = '/agent/onboarding/alert';
const TIMEOUT_MS = 5000;
const LOCAL_DEDUPE_MS = 60_000;
const MAX_DETAIL = 500;

const lastSent = new Map<string, number>();

function alertUrl(callbackUrl: string): string | null {
  try {
    return new URL(callbackUrl).origin + ALERT_PATH;
  } catch {
    return null;
  }
}

export function sendAlert(kind: string, detail: string): void {
  if (process.env.VITEST || process.env.NODE_ENV === 'test') return;
  const now = Date.now();
  const prev = lastSent.get(kind);
  if (prev !== undefined && now - prev < LOCAL_DEDUPE_MS) return;
  lastSent.set(kind, now);

  const env = readEnvFile(['WEBAPP_SHARED_SECRET', 'WEBAPP_CALLBACK_URL']);
  if (!env.WEBAPP_SHARED_SECRET || !env.WEBAPP_CALLBACK_URL) return;
  const url = alertUrl(env.WEBAPP_CALLBACK_URL);
  if (!url) return;

  void fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-shared-secret': env.WEBAPP_SHARED_SECRET },
    body: JSON.stringify({ source: 'host', kind, detail: detail.slice(0, MAX_DETAIL) }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
    .then(async (res) => {
      if (!res.ok) {
        log.warn('Host alert rejected by API', { kind, status: res.status });
        return;
      }
      const out = (await res.json().catch(() => ({}))) as { sent?: boolean; reason?: string };
      if (out.sent === false) log.warn('Host alert not delivered by API', { kind, reason: out.reason });
      else log.info('Host alert sent', { kind });
    })
    .catch((err) => log.warn('Host alert could not be sent', { kind, err: String(err) }));
}
