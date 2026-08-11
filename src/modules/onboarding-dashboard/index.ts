/**
 * Deterministic handling of the admin-dashboard "chapter onboarding initiated"
 * trigger for cm-onboarding.
 *
 * The dashboard sends a fixed system message ([SYSTEM: dashboard-chapter-
 * onboarding]\npipeline_id: <id>) whenever an admin starts onboarding for a
 * chapter. This used to wake the LLM agent (flow 1c in onboarding-procedures.
 * md), but that flow is purely mechanical — fetch the pipeline record, branch
 * on its known stage, send the welcome email if invited — and repeatedly
 * failed anyway: a false "sent" claim with no real Gmail call, and separately
 * an agent that asked for confirmation instead of acting. Since there is no
 * judgment call anywhere in this sequence, it's handled here instead, before
 * the message ever reaches a session or wakes a container: parse the trigger,
 * call the `onboarding-dashboard-trigger` skillscript skill synchronously,
 * and deliver its result the same way an agent reply would be delivered.
 *
 * Anything else on the same messaging group (real admin chat in the
 * dashboard's own chat panel) doesn't match the pattern below and falls
 * through to routeInbound/the agent exactly as before.
 */
import { rewriteLocalhostUrl } from '../../container-runner.js';
import { getDeliveryAdapter } from '../../delivery.js';
import { readEnvFile, readEnvPrefix } from '../../env.js';
import { log } from '../../log.js';
import { registerMessageInterceptor } from '../../router.js';
import type { InboundEvent } from '../../channels/adapter.js';

const DASHBOARD_PLATFORM_ID = 'webapp:cm-onboarding';
const DASHBOARD_TRIGGER_RE = /^\[SYSTEM: dashboard-chapter-onboarding\]\s*\npipeline_id:\s*(\S+)/m;
const DEFAULT_SKILLSCRIPT_RPC_URL = 'http://localhost:7878/rpc';

function resolveCmApiBaseUrl(): string | undefined {
  const base = readEnvFile(['CM_API_BASE_URL'])['CM_API_BASE_URL'];
  // Mirrors the per-app_id override container-runner.ts applies when injecting
  // this value into the agent container (src/container-runner.ts:531-543).
  const override = readEnvPrefix('CM_API_BASE_URL_')['cm-onboarding'];
  const effective = override ?? base;
  if (!effective) return undefined;
  // The skill body's curl calls run inside skillscript's own container, which
  // needs host.docker.internal to reach a host-side "localhost" API server —
  // same rewrite already applied when this value is injected into the agent
  // container. See docs/mondai/chapter-onboarding-skillscript-setup.md.
  return rewriteLocalhostUrl(effective);
}

function resolveSkillscriptRpcUrl(): string {
  return readEnvFile(['SKILLSCRIPT_RPC_URL'])['SKILLSCRIPT_RPC_URL'] || DEFAULT_SKILLSCRIPT_RPC_URL;
}

interface SkillOutcome {
  final_vars?: { REPLY_TEXT?: string };
  errors?: unknown[];
}

async function runDashboardTriggerSkill(
  pipelineId: string,
): Promise<{ ok: true; replyText: string } | { ok: false; error: string }> {
  const baseUrl = resolveCmApiBaseUrl();
  if (!baseUrl) return { ok: false, error: 'CM_API_BASE_URL is not configured on the host' };

  const rpcUrl = resolveSkillscriptRpcUrl();
  const rpcBody = {
    jsonrpc: '2.0',
    method: 'tools/call',
    params: {
      name: 'execute_skill',
      arguments: { name: 'onboarding-dashboard-trigger', inputs: { PIPELINE_ID: pipelineId, BASE_URL: baseUrl } },
    },
    id: Date.now(),
  };

  let res: Response;
  try {
    res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(rpcBody),
    });
  } catch (err) {
    return { ok: false, error: `skillscript unreachable: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!res.ok) return { ok: false, error: `skillscript RPC returned HTTP ${res.status}` };

  let envelope: { result?: { content?: { text?: string }[] }; error?: { message?: string } };
  try {
    envelope = (await res.json()) as typeof envelope;
  } catch {
    return { ok: false, error: 'skillscript RPC returned non-JSON response' };
  }
  if (envelope.error)
    return { ok: false, error: `skillscript RPC error: ${envelope.error.message ?? JSON.stringify(envelope.error)}` };

  const text = envelope.result?.content?.[0]?.text;
  if (!text) return { ok: false, error: 'skillscript RPC returned no content' };

  let outcome: SkillOutcome;
  try {
    outcome = JSON.parse(text);
  } catch {
    return { ok: false, error: 'onboarding-dashboard-trigger returned unparseable output' };
  }
  if (outcome.errors && outcome.errors.length > 0) {
    return { ok: false, error: `onboarding-dashboard-trigger failed: ${JSON.stringify(outcome.errors)}` };
  }
  const replyText = outcome.final_vars?.REPLY_TEXT;
  if (!replyText) return { ok: false, error: 'onboarding-dashboard-trigger returned no REPLY_TEXT' };

  return { ok: true, replyText };
}

function extractText(event: InboundEvent): string {
  try {
    const parsed = JSON.parse(event.message.content) as { text?: string };
    return parsed.text ?? '';
  } catch {
    return '';
  }
}

async function interceptDashboardTrigger(event: InboundEvent): Promise<boolean> {
  if (event.channelType !== 'webapp' || event.platformId !== DASHBOARD_PLATFORM_ID) return false;

  const match = DASHBOARD_TRIGGER_RE.exec(extractText(event));
  if (!match) return false; // Real admin chat on the same messaging group — let it route to the agent normally.

  const pipelineId = match[1];
  const adapter = getDeliveryAdapter();
  if (!adapter) {
    log.error('onboarding-dashboard: delivery adapter not ready, cannot reply', { pipelineId });
    return true; // Still consume it — there's nothing useful the agent could do with this literal system string either.
  }

  const result = await runDashboardTriggerSkill(pipelineId);
  const replyText = result.ok
    ? result.replyText
    : `Failed to process the dashboard trigger for pipeline ${pipelineId}: ${result.error}. Needs manual follow-up.`;

  if (!result.ok) {
    log.error('onboarding-dashboard: onboarding-dashboard-trigger skill failed', { pipelineId, error: result.error });
  } else {
    log.info('onboarding-dashboard: dashboard trigger handled deterministically', { pipelineId, replyText });
  }

  try {
    await adapter.deliver(
      'webapp',
      DASHBOARD_PLATFORM_ID,
      event.threadId,
      'chat',
      JSON.stringify({ text: replyText }),
      undefined,
      'webapp',
    );
  } catch (err) {
    log.error('onboarding-dashboard: failed to deliver reply', { pipelineId, err });
  }
  return true;
}

registerMessageInterceptor(interceptDashboardTrigger);
