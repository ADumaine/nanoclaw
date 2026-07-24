import { getDb } from '../../db/connection.js';
import { registerResource } from '../crud.js';

registerResource({
  name: 'member',
  plural: 'members',
  table: 'agent_group_members',
  description:
    'Agent group member — grants an unprivileged user permission to interact with an agent group. Users with admin or owner roles on the group are implicitly members and do not need a separate membership row. Membership is checked by the router when sender_scope is "known".',
  idColumn: 'user_id',
  scopeField: 'agent_group_id',
  columns: [
    {
      name: 'user_id',
      type: 'string',
      description: 'The user to grant membership. Must reference an existing user (users.id).',
    },
    {
      name: 'agent_group_id',
      type: 'string',
      description: 'The agent group to grant access to. Must reference an existing agent group (agent_groups.id).',
    },
    {
      name: 'added_by',
      type: 'string',
      description: 'User ID of whoever added this member. Informational — not enforced.',
    },
    { name: 'added_at', type: 'string', description: 'ISO 8601 timestamp of when the membership was granted.' },
  ],
  operations: { list: 'open' },
  customOperations: {
    add: {
      access: 'approval',
      description:
        'Add a user as a member of an agent group. Use --user and --group (--user-id / --agent-group-id also accepted).',
      handler: async (args) => {
        // Accept both flag names: the generic help renderer's "Fields:" section
        // lists the DB column names (user_id, agent_group_id) regardless of
        // which verb it's under, so a reader skimming past this operation's own
        // description (which correctly says --user/--group) can reasonably try
        // --user-id/--agent-group-id instead and hit a confusing "--user is
        // required" error. Rather than fix only the docs, accept both — no
        // wrong flag name should ever fail silently or misleadingly here.
        const userId = (args.user ?? args.user_id) as string;
        const groupId = (args.group ?? args.agent_group_id) as string;
        const addedBy = (args.added_by as string) ?? null;
        if (!userId) throw new Error('--user is required');
        if (!groupId) throw new Error('--group is required');
        getDb()
          .prepare(
            `INSERT OR IGNORE INTO agent_group_members (user_id, agent_group_id, added_by, added_at)
             VALUES (?, ?, ?, datetime('now'))`,
          )
          .run(userId, groupId, addedBy);
        return { user_id: userId, agent_group_id: groupId };
      },
    },
    remove: {
      access: 'approval',
      description:
        'Remove a user from an agent group. Use --user and --group (--user-id / --agent-group-id also accepted).',
      handler: async (args) => {
        const userId = (args.user ?? args.user_id) as string;
        const groupId = (args.group ?? args.agent_group_id) as string;
        if (!userId) throw new Error('--user is required');
        if (!groupId) throw new Error('--group is required');
        const result = getDb()
          .prepare('DELETE FROM agent_group_members WHERE user_id = ? AND agent_group_id = ?')
          .run(userId, groupId);
        if (result.changes === 0) throw new Error('member not found');
        return { removed: { user_id: userId, agent_group_id: groupId } };
      },
    },
  },
});
