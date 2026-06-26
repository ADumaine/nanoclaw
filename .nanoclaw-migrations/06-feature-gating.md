# 06 — Per-Group Feature Gating (Tool Allowlist + Module Gating)

## Intent

Two orthogonal gating mechanisms applied per agent group:

1. **`disabled_modules`** — suppresses built-in instruction fragments from the agent's `.claude-fragments/` at spawn time. E.g. disable `self-mod` and `agents` for the community assistant so it doesn't see those instructions.

2. **`allowed_tools`** — restricts which MCP tool definitions appear in the agent's system prompt. `"all"` (default) = no restriction. `["WebSearch", "WebFetch", ...]` = only those tools. Tools not in the list are added to `disallowedTools` so their definitions are suppressed (not just blocked at call time). Reduces MonDAI context from ~50 tools (25k tokens) to 5 tools (14k tokens).

## src/claude-md-compose.ts (or equivalent) — disabled_modules filtering

**Intent:** At group scaffold time, skip writing fragment files for modules in `disabledModules`.

Find where `.claude-fragments/*.md` files are written (likely `src/group-init.ts` or `src/claude-md-compose.ts`). Add a filter:

```typescript
const disabledModules = containerConfig.disabledModules ?? [];
// Skip fragment if its name is in disabledModules
if (disabledModules.includes(fragmentName)) continue;
```

Fragment names match the instruction file prefix: `self-mod`, `agents`, `scheduling`, `cli`, `interactive`, `core`.

Also filter skill fragments: only write skill instruction files if the skill name is in `containerConfig.skills` (when skills is an array, not `'all'`):

```typescript
const allowedSkills = containerConfig.skills;
if (Array.isArray(allowedSkills) && !allowedSkills.includes(skillName)) continue;
```

## container/agent-runner/src/config.ts — allowedTools propagation

**Intent:** Read `allowedTools` from `RunnerConfig` (loaded from `container.json`) and make it available to the provider.

**File:** `container/agent-runner/src/config.ts` — copy verbatim from main tree. Key: `RunnerConfig` includes `allowedTools?: string[] | 'all'`.

## src/cli/resources/groups.ts — CLI commands

**Intent:** Let operators configure disabled_modules and allowed_tools via `ncl groups config`.

**File:** `src/cli/resources/groups.ts` — copy verbatim from main tree. Key additions on top of upstream:

### ncl groups config set-allowed-tools

```
ncl groups config set-allowed-tools --id <group-id> --tools <tool1,tool2,...>
ncl groups config set-allowed-tools --id <group-id> --all
```

Sets `allowed_tools` column. `--all` restores the default unrestricted mode.

### ncl groups config add-disabled-module / remove-disabled-module

```
ncl groups config add-disabled-module --id <group-id> --name <module>
ncl groups config remove-disabled-module --id <group-id> --name <module>
```

Adds/removes a module name from the `disabled_modules` JSON array.

## MonDAI production config (apply via SQL on each environment)

After migration 019/020 run, configure the MonDAI agent group:

```sql
-- Find group ID
SELECT id FROM agent_groups WHERE name = 'Agent MonDAI';

-- Apply config (replace <id>)
UPDATE container_configs SET
  cli_scope = 'disabled',
  disabled_modules = '["self-mod","agents"]',
  skills = '["agent-browser","onecli-gateway","slack-formatting","welcome"]',
  allowed_tools = '["WebSearch","WebFetch","SendMessage","ToolSearch","Skill"]',
  updated_at = datetime('now')
WHERE agent_group_id = '<id>';
```

This suppresses Bash, Read, Write, Edit, Glob, Grep, Task, TodoWrite from the agent's tool definitions.
