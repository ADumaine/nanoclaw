/**
 * Tests for core per-session messages_in schema maintenance.
 *
 * Task-specific DB tests (insertTask, cancel/pause/resume, updateTask,
 * insertRecurrence) live in `src/modules/scheduling/db.test.ts` with the
 * rest of the scheduling module.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { describe, it, expect, afterEach } from 'vitest';

import {
  ensureSchema,
  getInboundSourceSessionId,
  hasFutureScheduledWork,
  migrateMessagesInTable,
} from './session-db.js';

const TEST_DIR = '/tmp/nanoclaw-session-db-test';
const DB_PATH = path.join(TEST_DIR, 'inbound.db');

afterEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('migrateMessagesInTable', () => {
  it('backfills series_id = id on legacy rows and is idempotent', () => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });

    // Build a legacy inbound.db WITHOUT series_id to simulate a pre-fix install.
    const db = new Database(DB_PATH);
    db.exec(`
      CREATE TABLE messages_in (
        id             TEXT PRIMARY KEY,
        seq            INTEGER UNIQUE,
        kind           TEXT NOT NULL,
        timestamp      TEXT NOT NULL,
        status         TEXT DEFAULT 'pending',
        process_after  TEXT,
        recurrence     TEXT,
        tries          INTEGER DEFAULT 0,
        platform_id    TEXT,
        channel_type   TEXT,
        thread_id      TEXT,
        content        TEXT NOT NULL
      );
    `);
    db.prepare(
      "INSERT INTO messages_in (id, seq, kind, timestamp, status, content) VALUES (?, ?, 'task', datetime('now'), 'pending', '{}')",
    ).run('legacy-1', 2);

    migrateMessagesInTable(db);
    migrateMessagesInTable(db); // idempotent

    const row = db.prepare('SELECT series_id FROM messages_in WHERE id = ?').get('legacy-1') as {
      series_id: string;
    };
    expect(row.series_id).toBe('legacy-1');
    db.close();
  });

  it('adds source_session_id on a legacy DB, leaves existing rows NULL, is idempotent', () => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });

    const db = new Database(DB_PATH);
    db.exec(`
      CREATE TABLE messages_in (
        id             TEXT PRIMARY KEY,
        seq            INTEGER UNIQUE,
        kind           TEXT NOT NULL,
        timestamp      TEXT NOT NULL,
        status         TEXT DEFAULT 'pending',
        process_after  TEXT,
        recurrence     TEXT,
        tries          INTEGER DEFAULT 0,
        platform_id    TEXT,
        channel_type   TEXT,
        thread_id      TEXT,
        content        TEXT NOT NULL
      );
    `);
    db.prepare(
      "INSERT INTO messages_in (id, seq, kind, timestamp, status, content) VALUES (?, ?, 'chat', datetime('now'), 'pending', '{}')",
    ).run('legacy-2', 2);

    migrateMessagesInTable(db);
    migrateMessagesInTable(db); // idempotent

    const cols = (db.prepare("PRAGMA table_info('messages_in')").all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain('source_session_id');

    expect(getInboundSourceSessionId(db, 'legacy-2')).toBeNull();
    expect(getInboundSourceSessionId(db, 'does-not-exist')).toBeNull();
    db.close();
  });
});

describe('hasFutureScheduledWork', () => {
  function freshDb(): Database.Database {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
    ensureSchema(DB_PATH, 'inbound');
    return new Database(DB_PATH);
  }

  it('is false for an empty session', () => {
    const db = freshDb();
    expect(hasFutureScheduledWork(db)).toBe(false);
    db.close();
  });

  it('is false when the only pending row is already due', () => {
    const db = freshDb();
    db.prepare(
      `INSERT INTO messages_in (id, seq, kind, timestamp, status, process_after, content)
       VALUES ('m-due', 2, 'chat', datetime('now'), 'pending', datetime('now', '-1 minute'), '{}')`,
    ).run();
    expect(hasFutureScheduledWork(db)).toBe(false);
    db.close();
  });

  it('is true for a recurring task waiting on its next occurrence', () => {
    // Mirrors what recurrence.ts's insertRecurrence writes: pending, future
    // process_after, recurrence carried forward. This is the exact shape
    // that let a live reply-poll task's session get TTL-swept — the task
    // kept firing every 5 minutes but never touched last_active.
    const db = freshDb();
    db.prepare(
      `INSERT INTO messages_in (id, seq, kind, timestamp, status, process_after, recurrence, content)
       VALUES ('m-recur', 2, 'task', datetime('now'), 'pending', datetime('now', '+5 minutes'), '*/5 * * * *', '{}')`,
    ).run();
    expect(hasFutureScheduledWork(db)).toBe(true);
    db.close();
  });

  it('is true for a one-shot reminder not yet due', () => {
    const db = freshDb();
    db.prepare(
      `INSERT INTO messages_in (id, seq, kind, timestamp, status, process_after, content)
       VALUES ('m-oneshot', 2, 'task', datetime('now'), 'pending', datetime('now', '+3 days'), '{}')`,
    ).run();
    expect(hasFutureScheduledWork(db)).toBe(true);
    db.close();
  });

  it('ignores completed/failed rows even with a future process_after', () => {
    const db = freshDb();
    db.prepare(
      `INSERT INTO messages_in (id, seq, kind, timestamp, status, process_after, content)
       VALUES ('m-done', 2, 'task', datetime('now'), 'completed', datetime('now', '+5 minutes'), '{}')`,
    ).run();
    expect(hasFutureScheduledWork(db)).toBe(false);
    db.close();
  });
});
