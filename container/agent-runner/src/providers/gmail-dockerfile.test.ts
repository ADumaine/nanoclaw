/**
 * Structural guard for the Gmail MCP package-install integration point (container image).
 *
 * `@gongrzhe/server-gmail-autoauth-mcp` is a CLI binary installed into the image via
 * container/cli-tools.json (a skill-appendable manifest — see install-cli-tools.sh) — it is
 * not importable or typed from this tree, so the build leg can't catch its removal and
 * there's no runtime seam to behavior-test. This asserts the manifest still carries the
 * gmail-mcp entry and its zod-to-json-schema pin. Drop either and this goes red, signalling
 * the agent would boot without the `gmail-mcp` binary on PATH (or hit the
 * ERR_PACKAGE_PATH_NOT_EXPORTED resolution bug the pin exists to avoid).
 *
 * Note: this replaces an earlier version of this test (from the add-gmail-tool skill) that
 * asserted a Dockerfile ARG + `pnpm install -g` line — that pattern predates the cli-tools.json
 * manifest refactor. Re-copying this test from the skill will regress it; update the skill
 * itself if this drifts again.
 */
import fs from 'fs';
import path from 'path';

import { describe, it, expect } from 'bun:test';

interface CliTool {
  name: string;
  version: string;
  onlyBuilt?: boolean;
}

function manifest(): CliTool[] {
  // container/agent-runner/src/providers/ -> ../../../cli-tools.json == container/cli-tools.json
  const p = path.join(import.meta.dir, '..', '..', '..', 'cli-tools.json');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

describe('container/cli-tools.json installs the Gmail MCP server', () => {
  const tools = manifest();

  it('pins @gongrzhe/server-gmail-autoauth-mcp to an exact version', () => {
    const entry = tools.find((t) => t.name === '@gongrzhe/server-gmail-autoauth-mcp');
    expect(entry).toBeDefined();
    expect(entry?.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('pins the zod-to-json-schema workaround version alongside it', () => {
    const entry = tools.find((t) => t.name === 'zod-to-json-schema');
    expect(entry).toBeDefined();
    expect(entry?.version).toBe('3.22.5');
  });
});
