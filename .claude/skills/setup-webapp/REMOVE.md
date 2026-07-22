# Remove Webapp Setup

Reverses a `/setup-webapp` run for a specific `app_id`. Does not remove the adapter code itself — run `/add-webapp`'s `REMOVE.md` for that.

## Steps

### 1. Find the messaging group

```bash
pnpm exec tsx scripts/q.ts data/v2.db \
  "SELECT id, name FROM messaging_groups WHERE platform_id='webapp:<app_id>'"
```

### 2. Delete the wiring

```bash
pnpm exec tsx scripts/q.ts data/v2.db \
  "SELECT id FROM messaging_group_agents WHERE messaging_group_id='<mg-id>'"
ncl wirings delete --id <wiring-id>
```

### 3. Delete the messaging group

```bash
ncl messaging-groups delete --id <mg-id>
```

### 4. Remove per-app callback override (if any)

Remove the `WEBAPP_CALLBACK_URL_<app_id>=...` line from `.env`, then sync:

```bash
mkdir -p data/env && cp .env data/env/env
```

### 5. Restart NanoClaw

```bash
systemctl --user restart nanoclaw   # Linux
# launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
```
