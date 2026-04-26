/**
 * Inbound message operations (container side).
 *
 * Reads from inbound.db (host-owned, opened read-only).
 * Writes processing status to processing_ack in outbound.db (container-owned).
 *
 * The container never writes to inbound.db — all status tracking goes through
 * processing_ack. The host reads processing_ack to sync message lifecycle.
 */
import { getConfig } from '../config.js';
import { getInboundDb, getOutboundDb } from './connection.js';

export interface MessageInRow {
  id: string;
  seq: number | null;
  kind: string;
  timestamp: string;
  status: string;
  process_after: string | null;
  recurrence: string | null;
  tries: number;
  /** 1 = wake-eligible (default); 0 = accumulated context only */
  trigger: number;
  platform_id: string | null;
  channel_type: string | null;
  thread_id: string | null;
  content: string;
}

// Cap on how many messages reach the agent in one prompt. Read from
// container.json; falls back to 10.
function getMaxMessagesPerPrompt(): number {
  try {
    return getConfig().maxMessagesPerPrompt;
  } catch {
    // Config not loaded yet (e.g. test harness) — use default
    return 10;
  }
}

/**
 * The thread_id of the message batch currently being processed this turn.
 *
 * Set by getPendingMessages() when it selects the batch. Used by
 * getProcessingThreadId() so resolveRouting can reply to the right thread
 * in shared-session mode without a cross-DB query.
 */
let _currentBatchThreadId: string | null = null;

/**
 * Fetch pending messages that are due for processing.
 * Reads from inbound.db (read-only), filters against processing_ack in outbound.db
 * to skip messages already picked up by this or a previous container run.
 *
 * In shared-session mode, multiple users' messages (with different thread_ids)
 * all land in the same session. To keep reply routing correct, we process only
 * the oldest-pending thread per turn. Messages from other threads wait for the
 * next container run. Thread-less messages (thread_id IS NULL) are treated as
 * their own group and processed when they are the oldest.
 *
 * Returns the most recent `MAX_MESSAGES_PER_PROMPT` pending rows from the
 * selected thread in chronological order.
 */
export function getPendingMessages(): MessageInRow[] {
  const inbound = getInboundDb();
  const outbound = getOutboundDb();

  // Build the set of already-acked message IDs first (completed or processing
  // from a prior/concurrent run).
  const ackedIds = new Set(
    (outbound.prepare('SELECT message_id FROM processing_ack').all() as Array<{ message_id: string }>).map(
      (r) => r.message_id,
    ),
  );

  // Fetch all pending, due messages in chronological order (ASC) so we can
  // find the oldest unacked one to determine which thread to process.
  const allPending = inbound
    .prepare(
      `SELECT * FROM messages_in
       WHERE status = 'pending'
         AND (process_after IS NULL OR datetime(process_after) <= datetime('now'))
       ORDER BY seq ASC`,
    )
    .all() as MessageInRow[];

  const unacked = allPending.filter((m) => !ackedIds.has(m.id));
  if (unacked.length === 0) {
    _currentBatchThreadId = null;
    return [];
  }

  // Pick the thread_id of the oldest unacked message. Process only that thread
  // this turn so every send_message call can route to the correct thread.
  const targetThreadId = unacked[0].thread_id;
  _currentBatchThreadId = targetThreadId;

  const batch =
    targetThreadId !== null
      ? unacked.filter((m) => m.thread_id === targetThreadId)
      : unacked.filter((m) => m.thread_id === null);

  // Return the most recent maxMessagesPerPrompt from this thread, oldest first.
  const max = getMaxMessagesPerPrompt();
  return batch.length <= max ? batch : batch.slice(batch.length - max);
}

/** Mark messages as processing — writes to processing_ack in outbound.db. */
export function markProcessing(ids: string[]): void {
  if (ids.length === 0) return;
  const db = getOutboundDb();
  const stmt = db.prepare(
    "INSERT OR REPLACE INTO processing_ack (message_id, status, status_changed) VALUES (?, 'processing', datetime('now'))",
  );
  db.transaction(() => {
    for (const id of ids) stmt.run(id);
  })();
}

/** Mark messages as completed — updates processing_ack in outbound.db. */
export function markCompleted(ids: string[]): void {
  if (ids.length === 0) return;
  const db = getOutboundDb();
  const stmt = db.prepare(
    "INSERT OR REPLACE INTO processing_ack (message_id, status, status_changed) VALUES (?, 'completed', datetime('now'))",
  );
  db.transaction(() => {
    for (const id of ids) stmt.run(id);
  })();
}

/** Mark a single message as failed — writes to processing_ack in outbound.db. */
export function markFailed(id: string): void {
  getOutboundDb()
    .prepare(
      "INSERT OR REPLACE INTO processing_ack (message_id, status, status_changed) VALUES (?, 'failed', datetime('now'))",
    )
    .run(id);
}

/** Get a message by ID (read from inbound.db). */
export function getMessageIn(id: string): MessageInRow | undefined {
  return getInboundDb().prepare('SELECT * FROM messages_in WHERE id = ?').get(id) as MessageInRow | undefined;
}

/**
 * Return the thread_id for the message batch currently being processed.
 *
 * Used by resolveRouting when the session's thread_id is null (shared session
 * mode). Set by getPendingMessages() at the start of each turn, so it is
 * always scoped to the current batch rather than scanning all messages_in.
 */
export function getProcessingThreadId(): string | null {
  return _currentBatchThreadId;
}

/**
 * Return the thread_id of the oldest unacked pending message without modifying
 * _currentBatchThreadId. Used by the poll loop's follow-up poller to decide
 * whether incoming messages belong to the current turn's thread before calling
 * getPendingMessages() (which would mutate _currentBatchThreadId).
 */
export function peekNextThreadId(): string | null {
  const inbound = getInboundDb();
  const outbound = getOutboundDb();

  const ackedIds = new Set(
    (outbound.prepare('SELECT message_id FROM processing_ack').all() as Array<{ message_id: string }>).map(
      (r) => r.message_id,
    ),
  );

  const rows = inbound
    .prepare(
      `SELECT id, thread_id FROM messages_in
       WHERE status = 'pending'
         AND (process_after IS NULL OR datetime(process_after) <= datetime('now'))
       ORDER BY seq ASC`,
    )
    .all() as Array<{ id: string; thread_id: string | null }>;

  const first = rows.find((r) => !ackedIds.has(r.id));
  return first !== undefined ? first.thread_id : null;
}

/**
 * Find a pending response to a question (by questionId in content).
 * Reads from inbound.db, checks processing_ack to skip already-handled responses.
 */
export function findQuestionResponse(questionId: string): MessageInRow | undefined {
  const inbound = getInboundDb();
  const outbound = getOutboundDb();

  const response = inbound
    .prepare("SELECT * FROM messages_in WHERE status = 'pending' AND content LIKE ?")
    .get(`%"questionId":"${questionId}"%`) as MessageInRow | undefined;

  if (!response) return undefined;

  // Check it hasn't been acked already
  const acked = outbound.prepare('SELECT 1 FROM processing_ack WHERE message_id = ?').get(response.id);
  if (acked) return undefined;

  return response;
}
