# 05 — Host-Side Changes

## src/env.ts — NEW FILE

**Intent:** Parse `.env` files without loading into `process.env`. Supports quoted values and inline comments. Provides `readEnvPrefix()` for reading sets of env vars that share a common prefix (e.g. `WEBAPP_CALLBACK_URL_*`).

**File:** `src/env.ts` — copy verbatim from main tree (78 lines). Key exports:

```typescript
export async function readEnvFile(path = '.env'): Promise<Record<string, string>>
export function readEnvPrefix(env: Record<string, string>, prefix: string): Record<string, string>
// readEnvPrefix('WEBAPP_CALLBACK_URL_', env) → { 'CRYPTOMONDAYS': 'https://...', ... }
```

Inline comment stripping: for unquoted values, strips from first ` #` occurrence. E.g. `VALUE=foo # comment` → `foo`.

## src/host-sweep.ts — Session TTL sweep

**Intent:** Automatically delete stale sessions after a configurable TTL (default 24h). Prevents unbounded accumulation of old session directories and DB rows.

**File:** `src/host-sweep.ts` — add to the existing sweep function:

```typescript
const SESSION_TTL_MS = (parseInt(process.env.SESSION_TTL_HOURS ?? '24', 10)) * 60 * 60 * 1000;

async function sweepStaleSessions(sessions: Session[]): Promise<void> {
  const now = Date.now();
  for (const session of sessions) {
    const age = now - new Date(session.createdAt).getTime();
    if (age > SESSION_TTL_MS) {
      logger.info({ sessionId: session.id }, 'sweeping stale session');
      await killContainer(session.agentGroupId, session.id).catch(() => {});
      deleteSession(session.id);
      const dir = sessionDir(session.id);
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
```

Call `sweepStaleSessions(sessions)` at the end of the main sweep loop (after existing sweep logic).

Also add these imports at the top of `host-sweep.ts`:

```typescript
import { deleteSession, sessionDir } from './db/sessions.js';
```

## src/router.ts — Inbound roles

**Intent:** Extract `roles` array from the message's JSON content and pass it to `gateCommand()` for role-based command gating (sysadmin vs admin vs member).

**File:** `src/router.ts` — find the call to `gateCommand()` and add `inboundRoles` extraction:

```typescript
// Before calling gateCommand(), extract roles from message content:
let inboundRoles: string[] = [];
try {
  const parsed = JSON.parse(message.content) as Record<string, unknown>;
  if (Array.isArray(parsed.roles)) {
    inboundRoles = parsed.roles.filter((r): r is string => typeof r === 'string');
  }
} catch {
  // not JSON content — no roles
}

// Pass as 4th argument:
const gateResult = await gateCommand(text, userId, agentGroupId, inboundRoles, channelType);
```

## src/command-gate.ts — Webapp blocking + sysadmin role

**Intent:** Block admin-only commands (like `/self-customize`, `/init`) from the webapp channel where users are community members, not operators. Add `sysadmin` role support from inbound JWT claims.

**File:** `src/command-gate.ts` — apply these changes on top of the upstream version:

### New constants

```typescript
// Commands that require sysadmin (never available via webapp)
const SYSADMIN_COMMANDS = ['/self-customize', '/init'] as const;
```

### Updated gateCommand() signature

```typescript
export async function gateCommand(
  text: string,
  userId: string,
  agentGroupId: string,
  inboundRoles: string[] = [],
  channelType?: string,
): Promise<GateResult>
```

### New isSysadmin() helper

```typescript
function isSysadmin(inboundRoles: string[], userRoles: UserRole[]): boolean {
  if (inboundRoles.includes('sysadmin')) return true;
  return userRoles.some((r) => r.role === 'owner');
}
```

### Updated isAdmin check

Rename or extend the existing admin check to `isAdminOrAbove()`:

```typescript
function isAdminOrAbove(inboundRoles: string[], userRoles: UserRole[]): boolean {
  if (inboundRoles.includes('admin') || inboundRoles.includes('sysadmin')) return true;
  return userRoles.some((r) => r.role === 'owner' || r.role === 'admin');
}
```

### Block sysadmin commands from webapp

```typescript
if (SYSADMIN_COMMANDS.some((cmd) => text.startsWith(cmd))) {
  if (channelType === 'webapp') {
    return { allowed: false, reason: 'This command is not available via the webapp.' };
  }
  if (!isSysadmin(inboundRoles, userRoles)) {
    return { allowed: false, reason: 'This command requires sysadmin access.' };
  }
}
```
