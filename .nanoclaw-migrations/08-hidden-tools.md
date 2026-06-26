# 08 — Hidden Tool Infrastructure + Provider allowedTools

## Intent

Two related changes:

1. **Hidden tools** — `create_agent`, `install_packages`, `add_mcp_server` are moved to a "hidden" registration path so they don't appear in the agent's system prompt (and thus don't consume tokens or confuse models). They're still callable if the agent somehow knows about them, but definitions are suppressed.

2. **allowedTools → disallowedTools suppression** — The Claude provider reads `allowedTools` from `RunnerConfig` and computes the complement (`TOOL_ALLOWLIST minus allowedTools`), then adds those to `disallowedTools`. This ensures tool *definitions* are removed from the system prompt, not just blocked at call time.

## container/agent-runner/src/mcp-tools/server.ts

**File:** Copy verbatim from main tree. Key additions on top of upstream:

```typescript
// Internal registry for hidden tools (not exposed in tool list to the model)
const hiddenTools: McpToolDefinition[] = [];

export function registerHiddenTools(tools: McpToolDefinition[]): void {
  hiddenTools.push(...tools);
}

export function callHiddenTool(name: string, args: unknown): Promise<McpCallToolResult> {
  const tool = hiddenTools.find((t) => t.tool.name === name);
  if (!tool) throw new Error(`Hidden tool not found: ${name}`);
  return tool.handler(args as Record<string, unknown>);
}

export function getHiddenToolDefinitions(): Tool[] {
  return hiddenTools.map((t) => t.tool);
}
```

The existing `registerTools()` / `callTool()` / `getToolDefinitions()` functions remain for normal (visible) tools.

## container/agent-runner/src/mcp-tools/agents.ts

**File:** In `agents.ts`, change `create_agent` to use `registerHiddenTools` instead of `registerTools`:

```typescript
import { registerHiddenTools } from './server.js';

// Replace: registerTools([createAgentTool]);
// With:
registerHiddenTools([createAgentTool]);
```

## container/agent-runner/src/mcp-tools/self-mod.ts

**File:** Same pattern — `install_packages` and `add_mcp_server` move to hidden:

```typescript
import { registerHiddenTools } from './server.js';

// Replace: registerTools([installPackagesTool, addMcpServerTool]);
// With:
registerHiddenTools([installPackagesTool, addMcpServerTool]);
```

## container/agent-runner/src/providers/types.ts

**Intent:** Add `allowedTools` to `ProviderOptions` so the Claude provider can read it.

```typescript
export interface ProviderOptions {
  // ... existing fields ...
  allowedTools?: string[] | 'all';
}
```

Also add to `RunnerConfig`:

```typescript
export interface RunnerConfig {
  // ... existing fields ...
  allowedTools?: string[] | 'all';
}
```

## container/agent-runner/src/providers/claude.ts

**Intent:** Compute `perGroupExcluded` = all known tools minus `allowedTools`, then add to `disallowedTools`. This removes tool definitions from the system prompt rather than just blocking calls.

Apply these changes on top of the new upstream claude.ts (which will have changes for provider abstraction, egress lockdown, etc.):

```typescript
// Full list of SDK + NanoClaw tool names the agent could have
const TOOL_ALLOWLIST = new Set([
  'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep',
  'WebSearch', 'WebFetch', 'SendMessage', 'ToolSearch', 'Skill',
  'Task', 'TaskGet', 'TaskList', 'TaskOutput', 'TaskStop', 'TaskUpdate',
  'TodoWrite', 'TodoRead',
  'Agent', 'NotebookEdit', 'Monitor', 'ScheduleWakeup',
  // add any others that appear in the system prompt
]);

// In the function that builds Claude API options (before calling the SDK):
const allowedTools = options.allowedTools;
let perGroupExcluded: string[] = [];

if (Array.isArray(allowedTools)) {
  perGroupExcluded = [...TOOL_ALLOWLIST].filter((t) => !allowedTools.includes(t));
}

// Merge with any existing disallowedTools from the SDK options:
const finalDisallowedTools = [
  ...(sdkOptions.disallowedTools ?? []),
  ...perGroupExcluded,
];

// Pass to SDK:
sdkOptions.disallowedTools = finalDisallowedTools;
if (Array.isArray(allowedTools)) {
  sdkOptions.allowedTools = allowedTools;
}
```

## container/agent-runner/src/index.ts — pass allowedTools through

**Intent:** Read `allowedTools` from `RunnerConfig` and pass to the provider.

In the main agent runner setup, after loading config:

```typescript
const runnerConfig = loadRunnerConfig(); // loads container.json
const providerOptions: ProviderOptions = {
  // ... existing options ...
  allowedTools: runnerConfig.allowedTools,
};
```
