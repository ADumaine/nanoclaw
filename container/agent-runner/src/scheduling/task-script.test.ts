import { describe, it, expect } from 'bun:test';

import { runScript } from './task-script.js';

describe('runScript', () => {
  it('executes a plain bash script (no shebang) via bash', async () => {
    const script = 'echo \'{"wakeAgent": true, "data": "plain-bash"}\'';
    const result = await runScript(script, `test-${Date.now()}-bash`);
    expect(result).not.toBeNull();
    expect(result?.wakeAgent).toBe(true);
    expect(result?.data).toBe('plain-bash');
  });

  it('executes a shebang-declared script by honoring the shebang, not forcing bash', async () => {
    // A `#!/bin/sh` shebang is a stand-in for any non-bash interpreter (e.g.
    // `#!/usr/bin/env bun`) — the point is that forcing `bash <path>` would
    // treat this line as a comment and then fail on `printf`'s shell builtin
    // differences, or on a genuinely non-bash script's real syntax. If the
    // shebang isn't honored, this either errors or silently misbehaves.
    const script = '#!/bin/sh\necho \'{"wakeAgent": true, "data": "shebang-honored"}\'';
    const result = await runScript(script, `test-${Date.now()}-shebang`);
    expect(result).not.toBeNull();
    expect(result?.wakeAgent).toBe(true);
    expect(result?.data).toBe('shebang-honored');
  });

  it('returns null on a script that errors (e.g. shebang\'d TS run as bash would)', async () => {
    const script = '#!/bin/sh\nexit 1';
    const result = await runScript(script, `test-${Date.now()}-error`);
    expect(result).toBeNull();
  });
});
