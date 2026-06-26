# 02 — Types and Container Config

## src/types.ts — ContainerConfigRow additions

**Intent:** Add `allowed_tools` and `disabled_modules` columns to the DB row type so the rest of the host can read them.

**File:** `src/types.ts` — add to `ContainerConfigRow` interface:

```typescript
allowed_tools: string;    // JSON: '"all"' | '["Tool1","Tool2"]'
disabled_modules: string; // JSON: '[]' | '["self-mod","agents"]'
```

Also add to `ContainerConfig` interface (the parsed form):

```typescript
allowedTools?: string[] | 'all';
disabledModules?: string[];
```

## src/container-config.ts — NEW FILE

**Intent:** Materializes `ContainerConfig` from the `container_configs` DB row. Parses `allowed_tools` and `disabled_modules` JSON columns. Called by `container-runner.ts` when building the container spawn arguments.

**File:** `src/container-config.ts` — create this file:

```typescript
import type { ContainerConfig, ContainerConfigRow } from './types.js';

export function parseContainerConfig(row: ContainerConfigRow): ContainerConfig {
  const base = JSON.parse(row.config ?? '{}') as ContainerConfig;

  // Parse allowed_tools column
  try {
    const parsed = JSON.parse(row.allowed_tools ?? '"all"');
    if (parsed === 'all' || Array.isArray(parsed)) {
      base.allowedTools = parsed;
    }
  } catch {
    // leave undefined — treated as 'all'
  }

  // Parse disabled_modules column
  try {
    const parsed = JSON.parse(row.disabled_modules ?? '[]');
    if (Array.isArray(parsed)) {
      base.disabledModules = parsed;
    }
  } catch {
    // leave undefined
  }

  return base;
}
```

(Read `src/container-config.ts` from the main tree verbatim — the above is a summary. Copy the full file.)

## src/db/container-configs.ts — CRUD additions

**Intent:** Expose `getDisabledModules`, `setDisabledModules`, `getAllowedTools`, `setAllowedTools` helper functions so the CLI and other host code can read/write the new columns.

**File:** `src/db/container-configs.ts` — copy the full file from the main tree verbatim. Key additions beyond upstream:

- `getDisabledModules(agentGroupId)` — returns parsed string[] from disabled_modules column
- `setDisabledModules(agentGroupId, modules)` — sets disabled_modules JSON
- `getAllowedTools(agentGroupId)` — returns parsed string[] | 'all' from allowed_tools column
- `setAllowedTools(agentGroupId, tools)` — sets allowed_tools JSON

## src/backfill-container-configs.ts — NEW FILE

**Intent:** On startup, backfills any agent groups that have a `container.json` file but no `container_configs` DB row. This was needed when migrating from file-based container config to the DB.

**File:** `src/backfill-container-configs.ts` — copy the full file from the main tree verbatim.

**Wire it:** In `src/index.ts`, call `backfillContainerConfigs()` during startup (after DB init, before channel adapters).
