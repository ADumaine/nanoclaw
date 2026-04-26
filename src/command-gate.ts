/**
 * Host-side command gate. Classifies inbound slash commands and gates
 * them before they reach the container.
 *
 * - Filtered commands: dropped silently (never reach the container)
 * - Sysadmin commands: terminal-only; blocked from app channels (webapp)
 *   regardless of role. From terminal, require 'sysadmin' inbound role or
 *   NanoClaw 'owner' in user_roles.
 * - Admin commands: require 'sysadmin' or 'admin' inbound role, or NanoClaw
 *   'owner'/'admin' in user_roles.
 * - Normal messages: pass through unchanged
 *
 * inboundRoles: roles passed in the message body by the channel adapter
 * (e.g. from the webapp API server). These are checked first; the NanoClaw
 * user_roles table is the fallback for non-app channels (terminal, Discord, etc.).
 */
import { getDb, hasTable } from './db/connection.js';

export type GateResult = { action: 'pass' } | { action: 'filter' } | { action: 'deny'; command: string };

const FILTERED_COMMANDS = new Set(['/help', '/login', '/logout', '/doctor', '/config', '/remote-control']);
// Require admin or sysadmin — these are Claude Code session / diagnostic commands.
const ADMIN_COMMANDS = new Set(['/clear', '/compact', '/context', '/cost', '/files']);
// Require sysadmin AND a non-app channel — these modify the agent's own setup.
const SYSADMIN_COMMANDS = new Set(['/self-customize', '/init']);

/**
 * Classify a message and decide whether it should reach the container.
 *
 * @param channelType  The channel the message arrived on (e.g. 'webapp', 'discord').
 *                     Null / undefined for terminal/CLI.
 * @param inboundRoles Roles asserted by the channel adapter for this sender
 *                     (e.g. ['sysadmin'] or ['admin', 'chapter_leader']).
 */
export function gateCommand(
  content: string,
  userId: string | null,
  agentGroupId: string,
  channelType: string | null = null,
  inboundRoles: string[] = [],
): GateResult {
  let text: string;
  try {
    const parsed = JSON.parse(content);
    text = (parsed.text || '').trim();
  } catch {
    text = content.trim();
  }

  if (!text.startsWith('/')) return { action: 'pass' };

  const command = text.split(/\s/)[0].toLowerCase();

  if (FILTERED_COMMANDS.has(command)) return { action: 'filter' };

  if (SYSADMIN_COMMANDS.has(command)) {
    // System-modification commands are terminal-only — blocked from all app channels.
    if (channelType === 'webapp') {
      return { action: 'deny', command };
    }
    if (isSysadmin(userId, agentGroupId, inboundRoles)) {
      return { action: 'pass' };
    }
    return { action: 'deny', command };
  }

  if (ADMIN_COMMANDS.has(command)) {
    if (isAdminOrAbove(userId, agentGroupId, inboundRoles)) {
      return { action: 'pass' };
    }
    return { action: 'deny', command };
  }

  // Unknown slash commands pass through (the agent/SDK handles them).
  return { action: 'pass' };
}

/** sysadmin inbound role, or NanoClaw owner via user_roles. */
function isSysadmin(userId: string | null, agentGroupId: string, inboundRoles: string[]): boolean {
  if (inboundRoles.includes('sysadmin')) return true;
  if (!userId) return false;
  if (!hasTable(getDb(), 'user_roles')) return true;
  const row = getDb()
    .prepare(
      `SELECT 1 FROM user_roles
       WHERE user_id = ?
         AND role = 'owner'
         AND (agent_group_id IS NULL OR agent_group_id = ?)
       LIMIT 1`,
    )
    .get(userId, agentGroupId);
  return row != null;
}

/** admin or sysadmin inbound role, or NanoClaw owner/admin via user_roles. */
function isAdminOrAbove(userId: string | null, agentGroupId: string, inboundRoles: string[]): boolean {
  if (inboundRoles.includes('sysadmin') || inboundRoles.includes('admin')) return true;
  if (!userId) return false;
  if (!hasTable(getDb(), 'user_roles')) return true;
  const row = getDb()
    .prepare(
      `SELECT 1 FROM user_roles
       WHERE user_id = ?
         AND (role = 'owner' OR role = 'admin')
         AND (agent_group_id IS NULL OR agent_group_id = ?)
       LIMIT 1`,
    )
    .get(userId, agentGroupId);
  return row != null;
}
