# 04 — LLM Proxy Redirect + Container Runner Env Overrides

## Intent

Route all agent Anthropic API calls through a local LLM proxy (`http://192.168.1.50:8888`) instead of the Anthropic API directly. The proxy handles model routing, cost tracking, and translates tool formats for non-Claude models. Additional changes: per-app_id CM_* env var passthrough, NO_PROXY bypass for the MonDAI API server, and compound API key encoding.

## File: src/container-runner.ts

This is the most heavily changed host file. The upstream version will have significant additions (CLI tools manifest, provider selection, egress lockdown, etc.). Apply these changes carefully on top of the new upstream version — do not overwrite the file wholesale.

### New imports needed

```typescript
import { getMessagingGroup } from './db/messaging-groups.js';
import { readEnvFile, readEnvPrefix } from './env.js';
import { openInboundDb } from './db/sessions.js'; // or wherever inbound DB open is
```

### New helper: rewriteLocalhostUrl()

Add this helper function. It converts localhost/127.0.0.1 addresses to `host.docker.internal` so containers can reach host services:

```typescript
function rewriteLocalhostUrl(url: string): string {
  return url
    .replace(/^(https?:\/\/)localhost(:\d+)?/, '$1host.docker.internal$2')
    .replace(/^(https?:\/\/)127\.0\.0\.1(:\d+)?/, '$1host.docker.internal$2');
}
```

### New helper: readSessionContext()

Reads `auth_id` and `llm_mode` from the latest inbound message's `user_context` JSON. Used to encode user identity into the compound API key:

```typescript
async function readSessionContext(sessionId: string): Promise<{ authId?: string; llmMode?: string }> {
  try {
    const db = openInboundDb(sessionId);
    const row = db.prepare(
      'SELECT user_context FROM messages_in ORDER BY seq DESC LIMIT 1'
    ).get() as { user_context?: string } | undefined;
    if (!row?.user_context) return {};
    const ctx = JSON.parse(row.user_context) as Record<string, unknown>;
    return {
      authId: typeof ctx.auth_id === 'string' ? ctx.auth_id : undefined,
      llmMode: typeof ctx.llm_mode === 'string' ? ctx.llm_mode : undefined,
    };
  } catch {
    return {};
  }
}
```

### In spawnContainer() / buildContainerArgs()

When building the Docker container environment, add these env var blocks. Apply them in addition to whatever env var logic the new upstream version has:

**1. Derive appId from messaging group:**

```typescript
const messagingGroup = await getMessagingGroup(session.messagingGroupId);
const appId = messagingGroup?.platform_id ?? undefined;
```

**2. Read session context for compound API key:**

```typescript
const sessionContext = await readSessionContext(session.id);
```

**3. Pass CM_* env vars with per-app_id overrides:**

```typescript
// Forward all CM_* vars from host .env
const envFile = await readEnvFile(); // reads .env without loading into process.env
const cmVars: Record<string, string> = {};
for (const [k, v] of Object.entries(envFile)) {
  if (k.startsWith('CM_')) cmVars[k] = v;
}

// Apply per-app_id overrides: CM_API_BASE_URL_CRYPTOMONDAYS overrides CM_API_BASE_URL for that app
if (appId) {
  const prefix = `CM_API_BASE_URL_${appId.toUpperCase().replace(/-/g, '_')}`;
  const override = envFile[prefix];
  if (override) cmVars['CM_API_BASE_URL'] = override;
}

// Rewrite localhost URLs for container access
for (const [k, v] of Object.entries(cmVars)) {
  if (v) cmVars[k] = rewriteLocalhostUrl(v);
}
```

**4. NO_PROXY bypass for MonDAI API server:**

The MonDAI API server runs locally and should NOT go through the OneCLI credential proxy:

```typescript
const cmApiUrl = cmVars['CM_API_BASE_URL'] ?? '';
const noProxyHosts = cmApiUrl ? new URL(cmApiUrl).hostname : '';

containerEnv['NO_PROXY'] = noProxyHosts;
containerEnv['no_proxy'] = noProxyHosts;
```

**5. LLM proxy redirect (ANTHROPIC_* overrides):**

Point `ANTHROPIC_BASE_URL` at the local LLM proxy. The proxy is at `http://192.168.1.50:8888` (or `host.docker.internal:8888` from inside a container):

```typescript
// Forward ANTHROPIC_BASE_URL from host .env if set (points to local LLM proxy)
const anthropicBaseUrl = envFile['ANTHROPIC_BASE_URL'];
if (anthropicBaseUrl) {
  containerEnv['ANTHROPIC_BASE_URL'] = rewriteLocalhostUrl(anthropicBaseUrl);
}

// Compound API key: encode llm_mode and user_id for proxy-side routing
// Format: <base_key>:<llm_mode>:<user_id>
const baseApiKey = envFile['ANTHROPIC_API_KEY'] ?? process.env.ANTHROPIC_API_KEY ?? '';
if (baseApiKey && sessionContext.llmMode && sessionContext.authId) {
  containerEnv['ANTHROPIC_API_KEY'] = `${baseApiKey}:${sessionContext.llmMode}:${sessionContext.authId}`;
} else if (baseApiKey) {
  containerEnv['ANTHROPIC_API_KEY'] = baseApiKey;
}
```

**6. Reset heartbeat at spawn time:**

Prevents immediate stale-kill for freshly spawned containers:

```typescript
// Touch heartbeat file to prevent stale detection during cold start
const heartbeatPath = path.join(sessionDir(session.id), '.heartbeat');
try {
  const now = new Date();
  fs.utimesSync(heartbeatPath, now, now);
} catch {
  // file may not exist yet — that's fine
}
```

## Env vars required in .env

```
ANTHROPIC_BASE_URL=http://192.168.1.50:8888   # or your LLM proxy address
ANTHROPIC_API_KEY=<base_key>                   # compound encoding added at runtime
CM_API_BASE_URL=http://...                     # MonDAI API server
CM_AGENT_TOKEN=...                             # NanoClaw shared secret (system_agent role)
CM_API_TOKEN=...                               # X-Api-Token for API server
CM_APP_URL=https://...                         # Public webapp URL for absolute links
```
