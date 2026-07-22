# Chapter Onboarding — skillscript-runtime setup

`cm-onboarding`'s `onboarding_render_template` and `onboarding_advance` MCP tools route through a separate [skillscript-runtime](https://github.com/sshwarts/skillscript) deployment when `SKILLSCRIPT_RPC_URL` is set (falls back to calling the CM API directly if unset — see `container/agent-runner/src/mcp-tools/onboarding.ts`). This is deterministic parse/dispatch for the two steps where the agent kept fabricating or mishandling content — see `docs/mondai/chapter-onboarding-mcp-server.md` for why.

This is **not part of the NanoClaw repo** — it's a separate local deployment folder (conventionally `skillscript-cm/` next to the NanoClaw checkout) that never gets git-pulled. Every server running `cm-onboarding` with `SKILLSCRIPT_RPC_URL` set needs its own copy of this setup, done by hand.

## What lives where

- **Upstream skillscript source** — a normal public git repo, `https://github.com/sshwarts/skillscript.git`. Clone it fresh on any new host; nothing local to transfer.
- **`skillscript-cm/`** (your deployment folder, name it whatever) — `docker-compose.yml`, `docker/Dockerfile` (a CryptoMondays-specific variant of upstream's root Dockerfile — see its own header comment), and `data/` (skills, config, secrets — the actual mutable state).

## First-time setup on a new host

### 1. Clone upstream and copy the deployment folder over

Clone `github.com/sshwarts/skillscript` fresh. Copy `docker-compose.yml` and `docker/Dockerfile` from an existing deployment (or recreate from this doc + the Dockerfile's own comments if starting fully fresh).

### 2. Build the image — three gotchas, all now fixed in `docker/Dockerfile` / `docker-compose.yml`, but worth knowing if debugging a fresh build failure

Build command (from the Dockerfile's own header comment):
```bash
docker build --pull -t skillscript:latest -f <skillscript-cm-path>/docker/Dockerfile <upstream-skillscript-checkout-path>
```
`--pull` and the exact `-f`/context split both matter:

- **Dockerfile must be this custom one, context must be the upstream checkout.** Building via `docker compose up --build` (the compose file's build section is deliberately commented out) or from the wrong context will silently produce an image without curl — see next point.
- **`apk add --no-cache curl` in the runtime stage.** Upstream's own Dockerfile targets a distroless final image (no shell, no package manager at all) — `shell(argv=["curl",...])` skills (the render/advance skills both use this) can never work against it. This custom Dockerfile swaps the runtime stage to `node:${NODE_VERSION}-alpine` specifically to add curl. Verify after any build: `docker exec skillscript-dashboard curl --version`.
- **corepack key-mismatch.** `corepack prepare pnpm@11.0.8 --activate` can fail with `Internal Error: Cannot find matching keyid` — the corepack version bundled with the base image can carry a stale signing-key list vs. what npm's registry currently signs pnpm releases with. Fixed by running `npm install -g corepack@latest` immediately before `corepack enable` (updates the key database rather than disabling verification).
- **Stale cached base image.** After the corepack fix, a *different* error can surface: `pnpm@11.0.8` requiring a newer Node patch than what's actually in a stale local `node:22-alpine` tag. `--pull` forces Docker to fetch the current image rather than reusing an old cached one — this is why `--pull` is in the build command above.

### 3. Start it

```bash
cd skillscript-cm && docker compose up -d
```
Dashboard should be reachable at `http://<host>:7878`.

### 4. Run `init`

```bash
docker compose run --rm tools init
```
If this fails with `exec: "/nodejs/bin/node": stat /nodejs/bin/node: no such file or directory` — the `tools` service's `entrypoint:` in `docker-compose.yml` still has upstream's distroless-image node path. Fix: `entrypoint: ["node", "/app/dist/cli.js"]` (node is on PATH in the alpine-based runtime stage, at `/usr/local/bin/node`, not `/nodejs/bin/node`). This should already be fixed in any deployment folder copied after 2026-07-20 — if you're debugging an older copy, apply this fix.

### 5. Set the onboarding skills' secret

`onboarding-render-email.skill.md` and `onboarding-advance.skill.md` both declare `Requires: secret.CM_AGENT_TOKEN_ONBOARDING`. Set it in `data/.env` (not committed anywhere — get the value from the API team, and note this is a *different* variable name than NanoClaw's own copy of the same conceptual token):
```
SKILLSCRIPT_SECRET_CM_AGENT_TOKEN_ONBOARDING=<token>
```
The matching NanoClaw-side var is `CM_AGENT_TOKEN_cm-onboarding` in NanoClaw's own `.env` — both need the same real value, in two different places, under two different names. Easy to set one and forget the other.

### 6. Copy the onboarding skill files

From an existing deployment's `data/skills/`, copy just:
- `onboarding-render-email.skill.md` + `.versions.jsonl`
- `onboarding-advance.skill.md` + `.versions.jsonl`
- `chapter-onboarding-log.skill.md` + `.versions.jsonl` (not currently called by `onboarding.ts`, but onboarding-domain and cheap to bring along)

Skip the upstream template's example skills (`hello-world.*`, `skill-store-roundtrip.*`, `data-store-roundtrip.*`) and don't copy `data.db`/`config.toml`/`connectors.json` — those are either local execution-trace state or environment-specific, and should be left to initialize fresh.

**The two hardcoded `BASE_URL="http://192.168.1.50:8888"` defaults in the skill files are intentionally not edited per-deployment** — `onboarding.ts` passes the correct `BASE_URL` (from its own `CM_API_BASE_URL`) as an explicit `execute_skill` input on every real call, overriding the skill's default. Confirmed in code (`container/agent-runner/src/mcp-tools/onboarding.ts`, both `execute_skill` call sites), not just trusted from the skill files' own comments.

### 7. Point NanoClaw at it

Set `SKILLSCRIPT_RPC_URL` in NanoClaw's `.env`, e.g. `http://<host>:7878/rpc`.

## Gmail credentials — separate from all of the above

Gmail auth for the onboarding agent goes through OneCLI's own vault (`mondai@cryptomondays.io`), entirely independent of skillscript. See `.claude/skills/add-gmail-tool/SKILL.md` for the full procedure (stub credential files, mount allowlist, secret-mode check). One thing not in that skill: if connecting Gmail via OneCLI's web UI fails, OneCLI itself may need an explicit `APP_URL` set in **its own** `.env` (separate from NanoClaw's), with its `docker-compose.yml` changed to use `APP_URL: ${APP_URL}` instead of deriving the URL from `ONECLI_BIND_HOST` — OAuth redirect URIs need an exact, externally-reachable URL, and a bind-host-derived value (often `0.0.0.0`, not reachable by a browser or Google's redirect) breaks the flow.

## Quick end-to-end verification

Once running, this confirms the whole chain without sending a real email (render is read-only):
```bash
curl -s -X POST "http://localhost:7878/rpc" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"execute_skill","arguments":{"name":"onboarding-render-email","inputs":{"TEMPLATE":"Chapter Welcome","EMAIL":"<a-real-prospect-email-in-the-pipeline>","BASE_URL":"<your-CM_API_BASE_URL>"}}}}'
```
Expect `final_vars.SUBJECT`/`HTML_BODY`/`RECIPIENT` populated. Current valid template names (must match exactly, including the em-dash on two of them) are documented in `groups/cm-onboarding/onboarding-procedures.md`'s "Email templates" section.
