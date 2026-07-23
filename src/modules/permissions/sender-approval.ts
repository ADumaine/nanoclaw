/**
 * Unknown-sender approval flow.
 *
 * When `messaging_groups.unknown_sender_policy = 'request_approval'` and a
 * non-member writes into a wired chat, the access gate drops the routing
 * attempt and calls `requestSenderApproval` to:
 *
 *   1. Pick an eligible approver (owner / admin of the agent group).
 *   2. Open / reuse a DM to that approver on a reachable channel.
 *   3. Deliver an Approve / Deny card.
 *   4. Record a pending_sender_approvals row that holds the original message
 *      so it can be re-routed on approve.
 *
 * On approve: the handler in index.ts adds an agent_group_members row for
 * the sender and re-invokes routeInbound with the stored event — the second
 * routing attempt passes the gate because the user is now a member.
 *
 * Failure modes (logged + row NOT created, so the dedup gate lets a future
 * attempt try again):
 *   - No eligible approver in user_roles — fresh install, no owner yet.
 *   - Approver has no reachable DM (no user_dms row + channel can't
 *     openDM) — e.g. owner hasn't registered on any channel we're wired to.
 *   - Delivery adapter missing.
 *
 * Dedup: `pending_sender_approvals` has UNIQUE(messaging_group_id,
 * sender_identity). A retry / rapid second message from the same unknown
 * sender is silently dropped (no duplicate card sent).
 */
import { normalizeOptions, type RawOption } from '../../channels/ask-question.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { getDeliveryAdapter } from '../../delivery.js';
import { log } from '../../log.js';
import type { InboundEvent } from '../../channels/adapter.js';
import { pickApprovalDelivery, pickApprover } from '../approvals/primitive.js';
import { createPendingSenderApproval, hasInFlightSenderApproval } from './db/pending-sender-approvals.js';

const APPROVAL_OPTIONS: RawOption[] = [
  { label: 'Allow', selectedLabel: '✅ Allowed', value: 'approve' },
  { label: 'Deny', selectedLabel: '❌ Denied', value: 'reject' },
];

function generateId(): string {
  return `nsa-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Escape Telegram legacy-Markdown special characters in dynamic/untrusted
 * text before interpolating it into a message declared `format: 'markdown'`
 * (webapp.ts always sets this). Without it, a sender display name containing
 * one of these — e.g. a real user "Robin_Philip" — breaks the receiving
 * platform's Markdown parser: an unpaired `_` opens an italic span with no
 * closing `_`, and Telegram rejects the whole message with a 400 ("can't
 * parse entities"). Confirmed live 2026-07-23. Scoped to legacy Markdown's
 * four special characters, not MarkdownV2's full set — broader escaping
 * would itself corrupt rendering under legacy mode.
 */
function escapeMarkdown(text: string): string {
  return text.replace(/([_*`[])/g, '\\$1');
}

export interface RequestSenderApprovalInput {
  messagingGroupId: string;
  agentGroupId: string;
  senderIdentity: string; // namespaced user id (channel_type:handle)
  senderName: string | null;
  event: InboundEvent;
}

export async function requestSenderApproval(input: RequestSenderApprovalInput): Promise<void> {
  const { messagingGroupId, agentGroupId, senderIdentity, senderName, event } = input;

  // In-flight dedup: don't spam the admin if the same unknown sender
  // retries while a card is already pending.
  if (hasInFlightSenderApproval(messagingGroupId, senderIdentity)) {
    log.debug('Unknown-sender approval already in flight — dropping retry', {
      messagingGroupId,
      senderIdentity,
    });
    return;
  }

  // Best-effort notice back to the requester, gated the same as the approval
  // card (once per pending request, not once per retry). Without this, a
  // first-time sender gets total silence — POST /message always returns 202
  // immediately regardless of what happens next, and nothing else in this
  // flow replies to the original thread. Silence reads as "broken" on a
  // webapp chat interface in particular, where near-instant replies are the
  // norm. Fire-and-forget on purpose — sent before approver resolution, so
  // it goes out even in the (already-broken) edge case where no approver is
  // configured; that's a minor secondary problem, not worth blocking on.
  const notifyAdapter = getDeliveryAdapter();
  if (notifyAdapter) {
    void notifyAdapter
      .deliver(
        event.channelType,
        event.platformId,
        event.threadId,
        'chat',
        JSON.stringify({ text: "Thanks — I've sent your access request to an admin for approval." }),
      )
      .catch((err) => log.error('Pending-approval notice failed to send', { err }));
  }

  const approvers = pickApprover(agentGroupId);
  if (approvers.length === 0) {
    log.warn('Unknown-sender approval skipped — no owner or admin configured', {
      messagingGroupId,
      agentGroupId,
      senderIdentity,
    });
    return;
  }

  const originMg = getMessagingGroup(messagingGroupId);
  const originChannelType = originMg?.channel_type ?? '';
  const target = await pickApprovalDelivery(approvers, originChannelType);
  if (!target) {
    log.warn('Unknown-sender approval skipped — no DM channel for any approver', {
      messagingGroupId,
      agentGroupId,
      senderIdentity,
    });
    return;
  }

  const approvalId = generateId();
  const senderDisplay = escapeMarkdown(senderName && senderName.length > 0 ? senderName : senderIdentity);
  const originName = escapeMarkdown(originMg?.name ?? `a ${originChannelType} channel`);

  const title = '👤 New sender';
  // Delivery can land in a shared/group channel (e.g. resolved via the most
  // recently active session for the approver's identity, which may not be a
  // private DM) — say explicitly that only an existing admin's click counts,
  // since the authorization check (any admin of this agent group, not just
  // the originally-targeted approver) already enforces this silently and a
  // reader with no context otherwise has no way to know who's allowed to act.
  const question = `${senderDisplay} wants to talk to your agent in ${originName}. Only an existing admin of this agent can approve. Allow?`;
  const options = normalizeOptions(APPROVAL_OPTIONS);

  createPendingSenderApproval({
    id: approvalId,
    messaging_group_id: messagingGroupId,
    agent_group_id: agentGroupId,
    sender_identity: senderIdentity,
    sender_name: senderName,
    original_message: JSON.stringify(event),
    approver_user_id: target.userId,
    created_at: new Date().toISOString(),
    title,
    options_json: JSON.stringify(options),
  });

  const adapter = getDeliveryAdapter();
  if (!adapter) {
    // Without a delivery adapter, the card can't be sent. Log + leave the
    // row in place so the admin can see it via DB or manual tooling; the
    // dedup gate will suppress further cards until it's cleared.
    log.error('Unknown-sender approval row created but no delivery adapter is wired', {
      approvalId,
    });
    return;
  }

  try {
    await adapter.deliver(
      target.messagingGroup.channel_type,
      target.messagingGroup.platform_id,
      null,
      'chat-sdk',
      JSON.stringify({
        type: 'ask_question',
        questionId: approvalId,
        title,
        question,
        options,
      }),
    );
    log.info('Unknown-sender approval card delivered', {
      approvalId,
      senderIdentity,
      approver: target.userId,
      messagingGroupId,
      agentGroupId,
    });
  } catch (err) {
    log.error('Unknown-sender approval card delivery failed', {
      approvalId,
      err,
    });
  }
}

/**
 * Option value the admin clicked that means "allow" — shared with the
 * response handler so the two sides can't drift.
 */
export const APPROVE_VALUE = 'approve';
export const REJECT_VALUE = 'reject';
