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

## Gmail credentials for the *agent container* — separate from skillscript's own connector below

Gmail auth for the onboarding agent (the container-side `mcp__gmail__*` tools) goes through OneCLI's own vault (`mondai@cryptomondays.io`), independent of skillscript. See `.claude/skills/add-gmail-tool/SKILL.md` for the full procedure (stub credential files, mount allowlist, secret-mode check). One thing not in that skill: if connecting Gmail via OneCLI's web UI fails, OneCLI itself may need an explicit `APP_URL` set in **its own** `.env` (separate from NanoClaw's), with its `docker-compose.yml` changed to use `APP_URL: ${APP_URL}` instead of deriving the URL from `ONECLI_BIND_HOST` — OAuth redirect URIs need an exact, externally-reachable URL, and a bind-host-derived value (often `0.0.0.0`, not reachable by a browser or Google's redirect) breaks the flow.

This section used to say Gmail access was "entirely independent of skillscript." As of 2026-07-28 that's no longer true — skillscript now has its *own* path to Gmail, for a different purpose (deterministic multi-step flows that don't need the agent's own turn to run at all). See the next section.

## Gmail via skillscript's own connector — deterministic sends, no agent turn required

**Why this exists**: flow #4 (save Luma link → go-live email → notify calendar manager → advance to `nagging`) kept failing when left as an agent-driven sequence — redundant tool calls, a skipped notify step, records stuck mid-flow — even after repeated prose fixes in `onboarding-procedures.md`. The fix was to stop describing the sequence in prose and instead build it as an actual skillscript skill: written once, runs the same way every time, no LLM turn in the mechanical part. That requires skillscript itself to be able to send email, which it couldn't before this.

**Mechanism**: a `gmail` connector in `connectors.json`, class `RemoteMcpConnector`, wired to spawn `onecli run --agent <id> -- gmail-mcp` instead of the bare `gmail-mcp` binary. `onecli run` gives *any* command transparent OneCLI credential injection (not something specific to pre-registered agent containers) — this was the actual unlock, found in OneCLI's own docs, and it avoids the more invasive alternative (attaching skillscript's container to whatever Docker network path reaches OneCLI's gateway directly).

```json
"gmail": {
  "class": "RemoteMcpConnector",
  "config": {
    "command": "onecli",
    "args": ["run", "--agent", "<OneCLI agent id — see below>", "--", "gmail-mcp"],
    "framing": "newline",
    "env": {
      "GMAIL_OAUTH_PATH": "/data/gmail-mcp/gcp-oauth.keys.json",
      "GMAIL_CREDENTIALS_PATH": "/data/gmail-mcp/credentials.json"
    }
  }
}
```

In a skill: `$ gmail.send_email to=["x@y.com"] subject="..." body="..." mimeType="text/plain" approved="..." -> R`.

### Setup steps (dev already done; production needs all of these fresh)

1. **`docker/Dockerfile`** already has this baked in as of 2026-07-28 — installs `onecli`, `gmail-mcp` (`@gongrzhe/server-gmail-autoauth-mcp@1.1.11`, same pin as the agent container), and `gcompat`. Just rebuild: `docker build -t skillscript:latest -f docker/Dockerfile /mnt/merge/skillscript` (or wherever the upstream checkout lives on that host).
2. **Register (or reuse) a OneCLI agent for skillscript to run as**, on *that host's own* OneCLI instance. Dev reused the existing "Chapter Onboarding" agent (`onecli agents list` to find its `identifier`) rather than provisioning a new one — reasonable for dev, but confirm whether production wants a dedicated agent identity instead. Put the chosen identifier into `connectors.json`'s `args` (the `--agent <id>` value).
3. **Get an account-level OneCLI API key** (`oc_...` format — distinct from an individual agent's own `aoc_...` access token) for *that host's* OneCLI account. `onecli auth api-key` on a host already authenticated shows it; otherwise generate one via the OneCLI dashboard. Put it in a compose-level `.env` (same directory as `docker-compose.yml`, **not** `data/.env` — that file is skillscript's own in-process dotenv load for `SKILLSCRIPT_SECRET_*` skill secrets, invisible to the shell entrypoint that runs before the node process starts) as `ONECLI_API_KEY=oc_...`. See `.env.example`. Never paste the raw value into a chat session — provision it directly on the host.
4. **Stub Gmail credential files** at `/data/gmail-mcp/gcp-oauth.keys.json` + `credentials.json` inside the container (content is literally the string `"onecli-managed"`, not real secrets — `gmail-mcp` just needs the files to exist for its own startup check; real auth happens transparently via the `onecli run` wrapper). The `data/` directory is root-owned (container-side writes) — create these via `docker exec`, not directly from the host user.
5. **`onecli auth login` needs to happen inside the container before any gmail-connector call** — `docker/entrypoint.sh` (inlined into the Dockerfile, since the build context is the upstream checkout and can't `COPY` a file from this deployment folder) does this automatically at container start, reading `ONECLI_API_KEY` from step 3.
6. **Set `~/.onecli/config.json`'s `api-host`** to that host's own OneCLI gateway address, *before* `auth login` — also handled by the entrypoint. **Do not assume dev's value (`http://172.17.0.1:10254`) is correct for production** — that's dev's Docker `docker0` bridge gateway IP specifically. Find production's real value the same way it was found for dev: check `~/.onecli/config.json` on a host where `onecli` already works, or `onecli auth status`/the OneCLI dashboard.

### Known gotchas — don't rediscover these on production

- **`gcompat` is required**, not optional. The `onecli` release binary is a dynamically-linked glibc ELF despite looking like a static Go build. Without `gcompat`, Alpine/musl fails to exec it with a misleading `onecli: not found` — the file is right there; it's onecli's own required dynamic linker that's missing, and the kernel's ENOENT on the missing interpreter surfaces through the shell as "command not found." Already in the Dockerfile; just don't remove it.
- **Set `api-host` via the real `onecli config set api-host <url>` command, never by hand-writing `~/.onecli/config.json`.** This is the actual root cause behind two different-looking failures encountered getting this working, and it's worth being precise about since the symptom (`"invalid API key..."`) points straight at the key, which was never the problem:
  - First symptom: `onecli auth login` failed with `"invalid API key: the server rejected this key"` on CLI `2.7.0` (latest at the time) against a key independently proven valid on the host (host was running CLI `1.7.0`). Diagnosed as a version-skew problem — onecli 2.x genuinely did change its default API base URL and endpoint prefix (`/v1` instead of `/api`, default host moved to the public `api.onecli.sh`) — and "fixed" by pinning to `1.7.0`.
  - That pin was real but the wrong fix. Re-tested later with `2.7.0` again, using `onecli config set api-host <url>` (the actual CLI command) instead of a hand-written `config.json` — **worked immediately, first try, no other change.** The hand-written file happened to match what `1.7.0`'s config reader expected but was silently not honored by `2.7.0`'s (different internal format or location — never fully diagnosed, and doesn't need to be, since the command-based fix is version-safe by construction). Current Dockerfile is pinned to `2.7.0` (still deliberately, not the auto-latest install script — see the Dockerfile's own comment) purely because "current latest" is a reasonable default when there's no reason not to, not because a specific version number matters.
  - **The general lesson, not just the specific fix**: when a tool provides its own command for setting persistent config, use that command, not a hand-authored file matching today's observed format — file formats are the kind of thing that changes silently across versions in ways a command's own interface is built to abstract over.
  - The gateway's own version (`/api/health`, e.g. `1.41.0` on dev) is a completely separate numbering scheme from the CLI's `onecli --help`-reported version — don't try to match them to each other; they're unrelated products.
- `connectors.json` and the Gmail stub credential files are root-owned on the host (bind-mounted, written by the container) — edit via `docker exec`/`docker cp`, not directly as the host user.

### Verification (real send, unlike the render-only check above)

```bash
# 1. Confirm the connector chain works at all (no skill needed yet):
docker exec <dashboard-container> sh -c 'onecli run --agent <id> -- curl -s https://gmail.googleapis.com/gmail/v1/users/me/labels'
# Expect real Gmail label JSON, not a 401/403.

# 2. Write a minimal test skill via the skill_write RPC tool (directly callable over
# /rpc, same as execute_skill — not only usable from inside another skill's body):
curl -s -X POST http://localhost:7878/rpc -H "Content-Type: application/json" -d '{
  "jsonrpc":"2.0","id":1,"method":"tools/call",
  "params":{"name":"skill_write","arguments":{"name":"test-send-email","overwrite":true,"source":
    "# Skill: test-send-email\n# Vars: TO, SUBJECT=\"test\", BODY=\"test\"\n# Status: Approved\n\nsend:\n    $ gmail.send_email to=[\"${TO}\"] subject=\"${SUBJECT}\" body=\"${BODY}\" mimeType=\"text/plain\" approved=\"connector validation\" -> R\n    emit(text=\"${R}\")\n\ndefault: send\n"
  }}
}'

# 3. Execute it for real:
curl -s -X POST http://localhost:7878/rpc -H "Content-Type: application/json" -d '{
  "jsonrpc":"2.0","id":2,"method":"tools/call",
  "params":{"name":"execute_skill","arguments":{"name":"test-send-email","inputs":{"TO":"<a real inbox you can check>"}}}
}'
# Expect a real Gmail message ID in the transcript, and the email to actually arrive.
```

## Egress lockdown compatibility (only relevant if `NANOCLAW_EGRESS_LOCKDOWN=true` on that host)

Skip this whole section if that host doesn't set `NANOCLAW_EGRESS_LOCKDOWN=true`
in NanoClaw's own `.env` — lockdown is opt-in and off by default (see
`docs/SECURITY.md`'s "Egress Lockdown" section for the general mechanism and
the local-Docker-service reachability pattern this section applies).

**Symptom this fixes**: `onboarding_daily_sweep` (or `onboarding_go_live`,
`onboarding_render_template`, `onboarding_advance`) fails with a connection
error, even though `curl http://localhost:7878/rpc` works fine directly on the
host. Under lockdown, the cm-onboarding container's only network route is to
the OneCLI gateway (aliased `host.docker.internal` on the internal
`nanoclaw-egress` network) — `SKILLSCRIPT_RPC_URL`'s `localhost` rewrite was
landing on that gateway, which doesn't listen on `7878`, instead of on
skillscript-dashboard. Root-caused and fixed on dev 2026-08-03 — see
[[project_chapter_onboarding]] memory for the full incident, or the "Reaching
a local Docker-hosted service from a locked-down agent" section of
`docs/SECURITY.md` for the general version of this gotcha.

### Steps to bring this fix to a host that has (or will have) lockdown on

1. **Get the NanoClaw code fix onto that host.** As of this writing the fix
   (`src/container-runner.ts`: `rewriteLocalhostUrl()` takes a target-hostname
   param, `SKILLSCRIPT_EGRESS_HOSTNAME = 'skillscript-dashboard'` used when
   `egressLocked`; `src/egress-lockdown.ts`: reads its three env vars via
   `readEnvFile()` instead of `process.env` — see the `.env`-loading gotcha in
   `docs/SECURITY.md`) exists only as an uncommitted change on the dev host.
   **Commit it to `local/mondai`, push, then on the target host**: `git pull`,
   `pnpm install --frozen-lockfile`, `pnpm run build` (host-only TypeScript —
   no container image rebuild needed), `systemctl --user restart <nanoclaw-unit>`.
2. **Attach `skillscript-dashboard` to the `nanoclaw-egress` network,
   persisted in that host's own `skillscript-cm/docker-compose.yml`** (this
   folder is a manual per-host deployment, not git-tracked — see the top of
   this doc):
   ```yaml
   services:
     dashboard:
       # ...existing config...
       networks:
         - default
         - nanoclaw-egress
   networks:
     default: {}
     nanoclaw-egress:
       external: true
   ```
   Apply with `docker compose up -d dashboard`. The `nanoclaw-egress` network
   must already exist on that host before this runs — it's created by
   NanoClaw itself the first time it spawns a container under lockdown, so
   bring NanoClaw up (with lockdown already enabled) before bringing
   skillscript-cm's compose up if starting both fresh.
3. **Verify**, from a throwaway container on that same network (not from the
   host directly — the point is confirming what the *agent container* can
   reach):
   ```bash
   docker run --rm --network nanoclaw-egress curlimages/curl:latest \
     curl -s -m 5 -o /dev/null -w '%{http_code}\n' http://skillscript-dashboard:7878/rpc
   # Expect 405 (Method Not Allowed — the RPC endpoint is POST-only, so a
   # bare GET reaching it at all confirms the network path works).
   ```
4. **Confirm end-to-end** by triggering `onboarding_daily_sweep` for real (or
   any skillscript-backed tool) and checking it completes without a
   connection error — do this with the operator present, since the sweep has
   real side effects (sends, stage advances) on genuine pipeline records.

If `skillscript-dashboard` isn't the container's actual name on some host
(check with `docker ps`), substitute the real name in both the compose
`networks:` block and `SKILLSCRIPT_EGRESS_HOSTNAME` in
`src/container-runner.ts` — they must match.

## Quick end-to-end verification

Once running, this confirms the whole chain without sending a real email (render is read-only):
```bash
curl -s -X POST "http://localhost:7878/rpc" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"execute_skill","arguments":{"name":"onboarding-render-email","inputs":{"TEMPLATE":"Chapter Welcome","EMAIL":"<a-real-prospect-email-in-the-pipeline>","BASE_URL":"<your-CM_API_BASE_URL>"}}}}'
```
Expect `final_vars.SUBJECT`/`HTML_BODY`/`RECIPIENT` populated. Current valid template names (must match exactly, including the em-dash on two of them) are documented in `groups/cm-onboarding/onboarding-procedures.md`'s "Email templates" section.
