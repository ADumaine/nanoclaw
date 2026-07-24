/**
 * Regression test: ncl members add/remove accepts both --user/--group AND
 * --user-id/--agent-group-id.
 *
 * ncl members help's generic "Fields:" section lists the DB column names
 * (user_id, agent_group_id) regardless of which verb it's rendered under —
 * it doesn't know that add/remove take different flag names than list/get.
 * A reader (human or agent) who skims past the operation's own correct
 * description ("Use --user and --group") and reads Fields instead gets a
 * confusing "--user is required" error when trying --user-id. Confirmed
 * live 2026-07-23: this exact mismatch misled a live agent mid-conversation.
 * Fix: accept both flag names rather than only documenting the right one.
 */
import fs from 'fs';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { initTestDb, closeDb, runMigrations, createAgentGroup } from '../../db/index.js';
import { upsertUser } from '../../modules/permissions/db/users.js';
import { dispatch } from '../dispatch.js';
// Side-effect import: registers the `members-add` / `members-remove` commands.
import './members.js';

function now(): string {
  return new Date().toISOString();
}

const GROUP = 'ag-1';
const USER = 'webapp:user-1';

describe('members CLI custom ops accept both flag-name forms (2026-07-23)', () => {
  beforeEach(() => {
    const db = initTestDb();
    runMigrations(db);
    createAgentGroup({ id: GROUP, name: 'Agent', folder: 'agent', agent_provider: null, created_at: now() });
    // agent_group_members.user_id has a FK to users(id) — the target user
    // must already exist (matches the field's own description: "Must
    // reference an existing user (users.id)").
    upsertUser({ id: USER, kind: 'webapp', display_name: 'Test User', created_at: now() });
  });

  afterEach(() => {
    closeDb();
  });

  it('add: works with --user/--group', async () => {
    const resp = await dispatch(
      { id: 'req-1', command: 'members-add', args: { user: USER, group: GROUP } },
      { caller: 'host' },
    );
    if (!resp.ok) throw new Error(`expected success, got ${JSON.stringify(resp)}`);
    expect(resp.data).toMatchObject({ user_id: USER, agent_group_id: GROUP });
  });

  it('add: also works with --user-id/--agent-group-id (the flag names shown in help text)', async () => {
    const resp = await dispatch(
      { id: 'req-2', command: 'members-add', args: { user_id: USER, agent_group_id: GROUP } },
      { caller: 'host' },
    );
    if (!resp.ok) throw new Error(`expected success, got ${JSON.stringify(resp)}`);
    expect(resp.data).toMatchObject({ user_id: USER, agent_group_id: GROUP });
  });

  it('remove: works with --user/--group', async () => {
    await dispatch({ id: 'req-add', command: 'members-add', args: { user: USER, group: GROUP } }, { caller: 'host' });
    const resp = await dispatch(
      { id: 'req-remove', command: 'members-remove', args: { user: USER, group: GROUP } },
      { caller: 'host' },
    );
    expect(resp.ok).toBe(true);
  });

  it('remove: also works with --user-id/--agent-group-id', async () => {
    await dispatch({ id: 'req-add', command: 'members-add', args: { user: USER, group: GROUP } }, { caller: 'host' });
    const resp = await dispatch(
      { id: 'req-remove', command: 'members-remove', args: { user_id: USER, agent_group_id: GROUP } },
      { caller: 'host' },
    );
    expect(resp.ok).toBe(true);
  });

  it('add: still errors clearly when neither flag form is given', async () => {
    const resp = await dispatch({ id: 'req-bad', command: 'members-add', args: { group: GROUP } }, { caller: 'host' });
    expect(resp.ok).toBe(false);
  });
});
