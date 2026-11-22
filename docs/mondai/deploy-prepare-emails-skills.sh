#!/usr/bin/env bash
# Deploy the prepare-emails skills to a skillscript store. Run ON the host whose store you are updating.
# Skills (sources in docs/mondai/skillscripts/): onboarding-send-emails (new), onboarding-dashboard-trigger,
# onboarding-go-live, onboarding-daily-sweep. The new skill is written first so the others lint clean.
# Default is a dry run (shows what would change). Pass APPLY=1 to write.
# Rollback: the store keeps prior versions (*.versions.jsonl); skill_write the old body again.
set -euo pipefail
RPC="${SKILLSCRIPT_RPC_URL:-http://localhost:7878/rpc}"
DIR="$(cd "$(dirname "$0")/skillscripts" && pwd)"
python3 - "$RPC" "$DIR" "${APPLY:-0}" <<'PY'
import hashlib, json, os, sys, urllib.request
rpc, d, apply = sys.argv[1], sys.argv[2], sys.argv[3] == "1"
def call(name, args):
    req = urllib.request.Request(rpc, json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/call",
        "params": {"name": name, "arguments": args}}).encode(), {"content-type": "application/json"})
    out = json.load(urllib.request.urlopen(req, timeout=60))
    if "error" in out: sys.exit("RPC error: %s" % out["error"])
    return json.loads(out["result"]["content"][0]["text"])
order = ["onboarding-send-emails", "onboarding-dashboard-trigger", "onboarding-go-live", "onboarding-daily-sweep"]
for name in order:
    src = open(os.path.join(d, name + ".skill.md")).read()
    try:
        cur = call("skill_read", {"name": name})["source"]
    except SystemExit:
        cur = None
    state = "NEW" if cur is None else ("unchanged" if cur == src else "CHANGED")
    print("%-34s %s" % (name, state))
    if state == "unchanged" or not apply: continue
    lint = call("lint_skill", {"source": src})
    if not lint.get("passes_tier_1"):
        sys.exit("lint failed for %s: %s" % (name, json.dumps(lint)[:800]))
    call("skill_write", {"name": name, "source": src, "overwrite": True})
    back = call("skill_read", {"name": name})
    if back["source"] != src: sys.exit("read-back differs for " + name)
    print("   written, version", back["version"])
print("done" if apply else "dry run - set APPLY=1 to write")
PY
