# Remove Webapp Channel

Reverses the `/add-webapp` install. Stop NanoClaw first so the adapter isn't in use.

## Steps

### 1. Remove the adapter file

```bash
rm src/channels/webapp.ts
```

### 2. Remove the barrel import

Remove this line from `src/channels/index.ts`:

```typescript
// webapp (native HTTP bridge for custom web frontends)
import './webapp.js';
```

### 3. Remove messaging groups (optional)

If you no longer need the messaging groups:

```bash
ncl messaging-groups list   # find webapp messaging group IDs
ncl messaging-groups delete --id <mg-id>
```

Wirings are deleted automatically when the messaging group is deleted.

### 4. Remove env vars (optional)

Remove from `.env`: `WEBAPP_SHARED_SECRET`, `WEBAPP_CALLBACK_URL`, `WEBAPP_PORT`, `WEBAPP_BIND_HOST`, any `WEBAPP_CALLBACK_URL_*` entries.

### 5. Build

```bash
pnpm run build
```

### 6. Restart NanoClaw

```bash
systemctl --user restart nanoclaw   # Linux
# launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
```
