#!/usr/bin/env bash
# Deploy the onboarding-dashboard-trigger `new`/`referred` branch to a skillscript store.
# Run ON the host whose store you are updating (talks to http://localhost:7878/rpc).
#
# Before overwriting, it reads the skill currently in the store and aborts unless
# that body is the known previous version (sha256 593cc49573aeca28066ec10f89016ab1c83b468a77be08ca27887854f56fe64e), so a prod-only edit
# is never clobbered silently. Set FORCE=1 to override after reviewing the diff.
# Expected resulting version on dev (rehearsed 2026-11-17): f3d39588f364
# Rollback: `*.versions.jsonl` keeps the prior version; re-run skill_write with the old body.
set -euo pipefail
RPC="${SKILLSCRIPT_RPC_URL:-http://localhost:7878/rpc}"
OLD_SHA="593cc49573aeca28066ec10f89016ab1c83b468a77be08ca27887854f56fe64e"
SRC_FILE="$(mktemp)"
trap 'rm -f "$SRC_FILE"' EXIT
cat > "$SRC_FILE" <<'SKILL_EOF'
# Skill: onboarding-dashboard-trigger
# Description: Deterministic handling of the admin-dashboard "chapter onboarding initiated" trigger — the `[SYSTEM: dashboard-chapter-onboarding]` system message NanoClaw's host intercepts before it reaches the LLM agent. Fetches the pipeline record, branches on its stage, and sends the welcome email when the stage is `invited`, or `new`/`referred` (then advances the record to `invited`); on a confirmed send, stamps `last_contact_at` via `POST /agent/onboarding/touch` so the record isn't invisible to the daily sweep. History: docs/mondai/chapter-onboarding-followup-gap.md.
# Vars: PIPELINE_ID, BASE_URL="http://192.168.1.50:8888"
# Returns: OUTCOME, STAGE, REPLY_TEXT
# Requires: secret.CM_AGENT_TOKEN_ONBOARDING
# Status: Approved
get_record:
    shell(argv=["curl","-s","${BASE_URL}/agent/onboarding/get/${PIPELINE_ID}","-H","Authorization: Bearer {{secret.CM_AGENT_TOKEN_ONBOARDING}}"]) -> RECORD_RAW
    $ json_parse ${RECORD_RAW} -> RECORD
    $set STAGE = "${RECORD.data.stage}"
    $set PROFILE_STATE = "${RECORD.data.profile_state|fallback:\"unregistered\"}"
    $set PROSPECT_EMAIL = "${RECORD.data.prospect_email}"
    $set CHAPTER_NAME = "${RECORD.data.chapters.name|fallback:\"this chapter\"}"
    $set STAGE_NOTES = "${RECORD.data.stage_notes|fallback:\"no notes on file\"}"

normalize:
    needs: get_record
    $set NEEDS_ADVANCE = "no"
    if ${STAGE} == "new":
        $set NEEDS_ADVANCE = "yes"
        $set STAGE = "invited"
    elif ${STAGE} == "referred":
        $set NEEDS_ADVANCE = "yes"
        $set STAGE = "invited"

branch:
    needs: normalize
    if ${STAGE} == "invited":
        $set TEMPLATE = "Chapter Welcome"
        if ${PROFILE_STATE} == "registered":
            $set TEMPLATE = "Chapter Welcome — Member"
        execute_skill(name="onboarding-render-email", inputs={"PIPELINE_ID": "${PIPELINE_ID}", "TEMPLATE": "${TEMPLATE}", "EMAIL": "${PROSPECT_EMAIL}", "BASE_URL": "${BASE_URL}"}) -> RENDERED
        $ gmail.send_email to=${RENDERED.RECIPIENT} subject=${RENDERED.SUBJECT|json} body=${RENDERED.HTML_BODY|json} mimeType="text/html" approved="onboarding dashboard-triggered welcome email" -> SEND
        if ${SEND|contains:"Error:"}:
            $set OUTCOME = "send_failed"
            $set REPLY_TEXT = "Failed to send welcome email to ${RENDERED.RECIPIENT} for ${CHAPTER_NAME}: ${SEND}"
        else:
            shell(argv=["curl","-s","-X","POST","${BASE_URL}/agent/onboarding/touch","-H","Authorization: Bearer {{secret.CM_AGENT_TOKEN_ONBOARDING}}","-H","Content-Type: application/json","-d","{\"id\":${PIPELINE_ID|json},\"notes\":\"Welcome email dispatched\"}"]) -> TOUCH_RAW
            $ json_parse ${TOUCH_RAW} -> TOUCH
            $set TOUCH_ERROR = "${TOUCH.error|fallback:\"\"}"
            $set OUTCOME = "sent"
            if ${TOUCH_ERROR} != "":
                $set REPLY_TEXT = "Welcome email sent to ${RENDERED.RECIPIENT} for ${CHAPTER_NAME}. Warning: failed to stamp contact timestamp (${TOUCH_ERROR}) — flag this record for manual follow-up if no automatic nudge appears later."
            else:
                $set REPLY_TEXT = "Welcome email sent to ${RENDERED.RECIPIENT} for ${CHAPTER_NAME}."
            if ${NEEDS_ADVANCE} == "yes":
                execute_skill(name="onboarding-advance", inputs={"ID": "${PIPELINE_ID}", "STAGE": "invited", "NOTES": "Welcome email dispatched", "BASE_URL": "${BASE_URL}"}) -> ADVANCED
                if ${ADVANCED.SUCCESS} != "true":
                    $set OUTCOME = "sent_advance_failed"
                    $set REPLY_TEXT = "${REPLY_TEXT} Warning: the stage could not be advanced to invited (${ADVANCED.RAW_RESPONSE}) — the record is still at its previous stage, so do not re-run the trigger or the welcome will be sent twice."
    elif ${STAGE} == "needs_attention":
        $set OUTCOME = "needs_attention"
        $set REPLY_TEXT = "${CHAPTER_NAME} is flagged needs_attention: ${STAGE_NOTES}. No action taken — already surfaced for admin review."
    else:
        $set OUTCOME = "reported"
        $set REPLY_TEXT = "${CHAPTER_NAME} is at stage \"${STAGE}\" — no automatic action defined for this stage from the dashboard trigger."
    emit(text="${REPLY_TEXT}")

default: branch
SKILL_EOF
python3 - "$RPC" "$SRC_FILE" "$OLD_SHA" <<'PY'
import hashlib, json, os, sys, urllib.request
rpc, src_file, old_sha = sys.argv[1:4]
new_src = open(src_file).read()
def call(name, args):
    req = urllib.request.Request(rpc, json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/call",
        "params": {"name": name, "arguments": args}}).encode(), {"content-type": "application/json"})
    out = json.load(urllib.request.urlopen(req, timeout=60))
    if "error" in out: sys.exit("RPC error: %s" % out["error"])
    return json.loads(out["result"]["content"][0]["text"])
cur = call("skill_read", {"name": "onboarding-dashboard-trigger"})
cur_sha = hashlib.sha256(cur["source"].encode()).hexdigest()
print("current version:", cur["version"], "sha256:", cur_sha)
if cur["source"] == new_src:
    sys.exit("already up to date - nothing to do")
if cur_sha != old_sha and os.environ.get("FORCE") != "1":
    sys.exit("current body is NOT the expected previous version - review it, then re-run with FORCE=1")
lint = call("lint_skill", {"source": new_src})
if not lint.get("passes_tier_1") or not lint.get("passes_tier_2"):
    sys.exit("lint failed: %s" % json.dumps(lint)[:800])
res = call("skill_write", {"name": "onboarding-dashboard-trigger", "source": new_src, "overwrite": True})
back = call("skill_read", {"name": "onboarding-dashboard-trigger"})
print("written. version now:", back["version"], "status:", back["status"], "(dev rehearsal: f3d39588f364)")
if back["source"] != new_src: sys.exit("read-back body differs from what was written")
print("OK")
PY
