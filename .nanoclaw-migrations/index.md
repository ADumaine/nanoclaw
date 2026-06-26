# NanoClaw Migration Guide — MonDAI Community Platform

Generated: 2026-06-25
Base: 24922593e3f79552039449d679e92a9f216c21a0 (upstream v2.0.59)
HEAD at generation: 7754d66
Upstream at generation: 2df7544 (v2.1.21)

## Overview

This is a **Tier 3 (Complex)** migration. No upstream skill branches were merged. All 47 changed files are custom development for the CryptoMondays MonDAI community platform.

## Applied Skills

No upstream skill branches were applied. All customizations are original.

**Custom container skills** (in `container/skills/`, not `.claude/skills/`):
- `frontend-engineer/` — admin/sysadmin only, build-test-verify workflow
- `vercel-cli/` — admin/sysadmin only, pinned to v52.2.1
- `slack-formatting/` — Telegram/Slack message formatting rules (upstream skill, may have local edits)
- `self-customize/` — self-modification skill (upstream skill)
- `welcome/` — upstream skill
- `onecli-gateway/` — upstream skill
- `agent-browser/` — upstream skill
- `whatsapp-formatting/` — upstream skill

## Migration Plan

Apply in this order — later sections depend on earlier ones:

1. **[01-migrations.md](01-migrations.md)** — DB migrations (CRITICAL: renumber 016→019, 017→020 due to upstream adding 016–018)
2. **[02-types-and-config.md](02-types-and-config.md)** — TypeScript types and container-config materialization
3. **[03-webapp-channel.md](03-webapp-channel.md)** — New HTTP channel adapter
4. **[04-llm-proxy.md](04-llm-proxy.md)** — LLM proxy redirect + compound API key (container-runner.ts)
5. **[05-host-changes.md](05-host-changes.md)** — Host-side changes: session TTL sweep, cascade delete, router roles, command-gate
6. **[06-feature-gating.md](06-feature-gating.md)** — Per-group tool allowlist + module gating (CLI + runtime)
7. **[07-mondai-tools.md](07-mondai-tools.md)** — MonDAI MCP tools (mondai.ts, opportunities.ts)
8. **[08-hidden-tools.md](08-hidden-tools.md)** — Hidden tool infrastructure (server.ts, agents.ts, self-mod.ts, claude.ts provider)
9. **[09-container.md](09-container.md)** — Dockerfile, container/CLAUDE.md, container skills, group files, docs
10. **[10-env-helpers.md](10-env-helpers.md)** — readEnvPrefix helper (src/env.ts)

## Skill Interactions

None — no upstream skill branches were applied.

## Risk Areas

- **Migration numbering conflict (CRITICAL)**: Our 016/017 collide with upstream's new 016/017/018. Must renumber to 019/020. See section 01.
- **container-runner.ts** is heavily changed upstream (new CLI tools manifest, provider selection, egress lockdown, etc.). The LLM proxy and compound API key changes need careful application on top of the new upstream version. See section 04.
- **command-gate.ts** has upstream changes (new gate logic). Our inbound roles + webapp channel blocking need to be applied on top. See section 05.
- **claude.ts provider** has upstream changes (new provider abstraction). Our allowedTools→disallowedTools suppression needs to be applied on top. See section 08.
- **docs/mondai/** — copy as-is from main tree (planning artifacts, not affected by upstream).
- **groups/community/** — copy as-is from main tree (data directory, not touched by upgrade).
