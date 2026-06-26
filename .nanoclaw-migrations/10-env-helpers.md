# 10 — Environment Variable Helpers

## src/env.ts — NEW FILE

**Intent:** Parse `.env` files without side effects (does not load into `process.env`). Required by `container-runner.ts` to read `ANTHROPIC_BASE_URL`, `CM_*` vars, and per-app_id overrides at container spawn time.

**File:** `src/env.ts` — copy verbatim from main tree (78 lines).

Key behaviors:
- Reads the `.env` file at the given path (default `.env`)
- Supports quoted values: `KEY="value with spaces"` and `KEY='value'`
- Strips inline comments from unquoted values: `KEY=foo # comment` → `foo`
- Does NOT load into `process.env` — returns a plain `Record<string, string>`

```typescript
export async function readEnvFile(path = '.env'): Promise<Record<string, string>>

// Read all vars with a given prefix, returning suffix → value map
// E.g. readEnvPrefix(env, 'CM_API_BASE_URL_') → { 'CRYPTOMONDAYS': 'https://...' }
export function readEnvPrefix(env: Record<string, string>, prefix: string): Record<string, string>
```

## Usage in container-runner.ts

```typescript
import { readEnvFile, readEnvPrefix } from './env.js';

const envFile = await readEnvFile();

// Get all per-app_id CM_API_BASE_URL overrides
const baseUrlOverrides = readEnvPrefix(envFile, 'CM_API_BASE_URL_');
// { 'CRYPTOMONDAYS': 'http://...', 'CRYPTOMONDAYS_DEV': 'http://...' }

// For a given appId (uppercased, hyphens→underscores):
const appEnvKey = appId?.toUpperCase().replace(/-/g, '_');
const apiBaseUrl = appEnvKey ? (baseUrlOverrides[appEnvKey] ?? envFile['CM_API_BASE_URL']) : envFile['CM_API_BASE_URL'];
```
