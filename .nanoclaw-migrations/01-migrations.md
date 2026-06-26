# 01 — Database Migrations

## CRITICAL: Renumber migrations

Upstream v2.1.21 added migrations 016, 017, and 018. Our custom migrations were numbered 016 and 017. They **must be renumbered to 019 and 020** in the worktree to avoid collisions.

## Migration 019: disabled_modules

**Intent:** Add `disabled_modules` JSON column to `container_configs` so certain built-in instruction fragments (self-mod, agents, scheduling, etc.) can be suppressed per agent group. Reduces token waste and confusion for agents (like MonDAI) that don't need those capabilities.

**File:** `src/db/migrations/019-disabled-modules.ts` (renamed from 016)

```typescript
import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration019: Migration = {
  version: 19,
  name: 'disabled-modules',
  up(db: Database.Database) {
    db.prepare("ALTER TABLE container_configs ADD COLUMN disabled_modules TEXT NOT NULL DEFAULT '[]'").run();
  },
};
```

## Migration 020: allowed_tools

**Intent:** Add `allowed_tools` JSON column to `container_configs` for per-group MCP tool allowlisting. Value is `"all"` (default, unrestricted) or a JSON array of tool names. Used to suppress unwanted tool definitions from the agent's system prompt, reducing token usage from ~25k to ~14k for MonDAI.

**File:** `src/db/migrations/020-allowed-tools.ts` (renamed from 017)

```typescript
import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration020: Migration = {
  version: 20,
  name: 'allowed-tools',
  up(db: Database.Database) {
    db.prepare('ALTER TABLE container_configs ADD COLUMN allowed_tools TEXT NOT NULL DEFAULT \'"all"\'').run();
  },
};
```

## Register in migrations index

**File:** `src/db/migrations/index.ts`

Add imports and append to the migrations array after the last upstream migration (018):

```typescript
import { migration019 } from './019-disabled-modules.js';
import { migration020 } from './020-allowed-tools.js';

// In the migrations array, after migration018:
  migration019,
  migration020,
```

## sessions.ts: cascade-delete before session delete

**Intent:** Prevent FK constraint errors when deleting a session that still has pending questions or approvals.

**File:** `src/db/sessions.ts` — update `deleteSession()`:

```typescript
export function deleteSession(id: string): void {
  const db = getDb();
  db.prepare('DELETE FROM pending_questions WHERE session_id = ?').run(id);
  db.prepare('DELETE FROM pending_approvals WHERE session_id = ?').run(id);
  db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
}
```
