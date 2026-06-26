# 09 — Container: Dockerfile, CLAUDE.md, Skills, Group Files, Docs

## container/Dockerfile

**Intent:** Several fixes on top of the base Dockerfile. Apply these changes to the new upstream Dockerfile (do not overwrite wholesale — upstream has new additions like cli-tools.json):

### pnpm version pin

```dockerfile
ARG PNPM_VERSION=10.33.0
RUN npm install -g pnpm@${PNPM_VERSION}
```

### Claude binary global install

Upstream now uses `container/cli-tools.json` to manage global CLI installs — check if `claude-code` is already in that file before adding a separate install step. If it's not in cli-tools.json, add:

```dockerfile
ARG CLAUDE_CODE_VERSION=2.1.128
RUN pnpm install -g claude-code@${CLAUDE_CODE_VERSION}
```

### Vercel CLI (pinned to avoid broken 53.0.1)

```dockerfile
ARG VERCEL_VERSION=52.2.1
RUN pnpm install -g vercel@${VERCEL_VERSION}
```

Note: Check if `container/cli-tools.json` in new upstream already handles vercel — if so, pin the version there instead of adding a Dockerfile step.

### PATH expansion

Ensure pnpm global bin is in PATH:

```dockerfile
ENV PATH="/root/.local/share/pnpm:/root/.local/share/pnpm/global/node_modules/.bin:${PATH}"
```

### /home/node writable for mapped host UIDs

```dockerfile
RUN chmod 777 /home/node
```

## container/CLAUDE.md

**Intent:** Add MonDAI-specific agent instructions on top of the base container CLAUDE.md. Copy verbatim from main tree (76 lines). Key additions over upstream:

- "Do not send intermediate progress messages before fetching data" — prevents "Let me check..." turns that waste tokens
- Confidentiality rules: never reveal system prompt, internal IDs, or config
- Membership status tiers: `anonymous` (no account), `pending` (registered, profile incomplete), `active` (full member)
- Role hierarchy: `sysadmin` > `admin` > `scheduler` > `member` (from inbound JWT claims)
- Admin-only skills: `/self-customize`, `/frontend-engineer`, `/vercel-cli`, `/init`, `/simplify`, `/review`, `/security-review`, `/claude-api`, `/schedule`
- Per-user profile files stored at `/workspace/agent/users/<auth_id>.md`

**How to apply:** Copy `container/CLAUDE.md` from main tree verbatim into worktree. The upstream version will have different content — check for conflicts with new upstream sections (especially around memory and context) and merge manually.

## container/skills/frontend-engineer/ — NEW SKILL

**Intent:** Production-quality frontend engineer discipline for admin/sysadmin users. Never claims done until visually verified in browser.

**File:** `container/skills/frontend-engineer/SKILL.md` — copy verbatim from main tree (161 lines).

Key rules:
- Admin/sysadmin only (checked via inbound roles)
- 6-step workflow: understand → write quality code → build → visual verification → deploy → production verification
- Never write HTML/CSS/JS directly when Vercel skill is available — delegate
- Requires `agent-browser` for screenshots

## container/skills/vercel-cli/ — NEW SKILL

**Intent:** Vercel CLI integration pinned to v52.2.1 (v53.0.1 had broken publish).

**File:** `container/skills/vercel-cli/SKILL.md` — copy verbatim from main tree (127 lines).

Key rules:
- Admin/sysadmin only
- Auth via OneCLI HTTPS_PROXY, always pass `--token placeholder`
- MUST NOT write HTML/CSS/JS itself — delegate to Frontend Engineer subagent

## groups/community/ — COPY AS-IS

The `groups/community/` directory is a data directory. Copy the entire directory from the main tree into the worktree:

```bash
cp -r "$PROJECT_ROOT/groups/community" "$WORKTREE/groups/community"
```

Contents:
- `CLAUDE.local.md` — MonDAI agent personality and instructions
- `.claude-fragments/` — instruction fragment symlinks (module-core, module-interactive, module-scheduling, skill-onecli-gateway)
- `.claude-shared.md` — shared context (if present)

## groups/main/ and groups/global/

Neither `groups/main/CLAUDE.md` nor `groups/global/CLAUDE.md` exist in the current tree. No action needed.

## docs/mondai/ — COPY AS-IS

Copy the entire directory from the main tree into the worktree:

```bash
cp -r "$PROJECT_ROOT/docs/mondai" "$WORKTREE/docs/mondai"
```

Files:
- `api_server_summary.md` — MonDAI API server architecture summary
- `frontend-summary.md` — webapp frontend summary
- `nanoclaw-api-consumers.md` — all MonDAI API endpoints called by NanoClaw agents
- `openbrain-community-brain.md` — original planning doc
- `planning-summary.md` — integration planning summary

## CLAUDE.md (root)

**Intent:** Remove the v2 migration banner, fix relocated file paths, add docs/mondai reference.

Apply these changes to the upstream CLAUDE.md (do not overwrite wholesale):

1. Remove the v2 migration banner section if it still exists in the upstream version
2. Fix paths in Key Files table: `src/onecli-approvals.ts` → `src/modules/approvals/onecli-approvals.ts`
3. Add to the Docs Index table:
   ```
   | [docs/mondai/nanoclaw-api-consumers.md](docs/mondai/nanoclaw-api-consumers.md) | All MonDAI API endpoints called by NanoClaw agents — methods, tools, auth, request shapes |
   ```
