# Skill: onboarding-daily-sweep
# Status: Approved
# Description: Deterministic core of the chapter-onboarding daily sweep (flow #6 in onboarding-procedures.md). For every prospect /stalled returns, renders and sends the matching templated email and advances the stage to log contact; marks a prospect unresponsive and notifies admins once their limit is reached instead of sending again. Failed sends and unrecognized records are counted and notified, never silently dropped. Per-record stage/count fields carry `|fallback:` so one malformed record can't abort the whole foreach (skillscript 0.40+ raises on an unresolved condition operand) — everywhere else in this project, raising is left alone deliberately. Incident history: docs/mondai/chapter-onboarding-followup-gap.md.
# Vars: BASE_URL="http://192.168.1.50:8888"
# Returns: FOLLOWUP_SENT_COUNT, FOLLOWUP_FAILED_COUNT, NAG_SENT_COUNT, NAG_FAILED_COUNT, UNRESPONSIVE_COUNT, UNRECOGNIZED_COUNT
# Requires: secret.CM_AGENT_TOKEN_ONBOARDING

get_settings:
    shell(argv=["curl","-s","${BASE_URL}/agent/onboarding/settings","-H","Authorization: Bearer {{secret.CM_AGENT_TOKEN_ONBOARDING}}"]) -> SETTINGS_RAW
    $ json_parse ${SETTINGS_RAW} -> SETTINGS
    $set FOLLOWUP_MAX = ${SETTINGS.data.followup_max_attempts}
    $set NAG_MAX = ${SETTINGS.data.nag_max_attempts}
    $set ADMIN_IDS = ${SETTINGS.data.admin_notify_telegram_ids}

get_stalled:
    shell(argv=["curl","-s","${BASE_URL}/agent/onboarding/stalled","-H","Authorization: Bearer {{secret.CM_AGENT_TOKEN_ONBOARDING}}"]) -> STALLED_RAW
    $ json_parse ${STALLED_RAW} -> STALLED

process:
    needs: get_settings, get_stalled
    $set FOLLOWUP_SENT = []
    $set FOLLOWUP_FAILED = []
    $set NAG_SENT = []
    $set NAG_FAILED = []
    $set UNRESPONSIVE = []
    $set UNRECOGNIZED = []
    foreach R in ${STALLED.data}:
        if (${R.stage|fallback:"__missing__"} == "invited" or ${R.stage|fallback:"__missing__"} == "following_up") and ${R.follow_up_count|fallback:"-1"} < ${FOLLOWUP_MAX}:
            execute_skill(name="onboarding-send-emails", inputs={"PIPELINE_ID": "${R.id}", "PURPOSE": "follow_up", "BASE_URL": "${BASE_URL}"}) -> MAIL
            if ${MAIL.SENT_COUNT} < "1":
                $append FOLLOWUP_FAILED "${R.prospect_name}: ${MAIL.ERROR} ${MAIL.FAILED}"
                execute_skill(name="onboarding-notify-admins", inputs={"ADMIN_IDS": ${ADMIN_IDS}, "TEXT": "Daily sweep: follow-up send FAILED for ${R.prospect_name} (${R.prospect_email}): ${MAIL.ERROR} ${MAIL.FAILED}", "BASE_URL": "${BASE_URL}"}) -> NOTIFY_FOLLOWUP_FAIL
            else:
                execute_skill(name="onboarding-advance", inputs={"ID": "${R.id}", "STAGE": "following_up", "NOTES": "Automated follow-up sent (daily sweep)", "BASE_URL": "${BASE_URL}"}) -> ADV
                $append FOLLOWUP_SENT ${R.id}
        elif ${R.stage|fallback:"__missing__"} == "invited" or ${R.stage|fallback:"__missing__"} == "following_up":
            shell(argv=["curl","-s","-X","POST","${BASE_URL}/agent/onboarding/mark-unresponsive","-H","Authorization: Bearer {{secret.CM_AGENT_TOKEN_ONBOARDING}}","-H","Content-Type: application/json","-d","{\"id\":${R.id|json}}"]) -> MARK_RAW
            execute_skill(name="onboarding-notify-admins", inputs={"ADMIN_IDS": ${ADMIN_IDS}, "TEXT": "Marked unresponsive: ${R.prospect_name} (${R.prospect_email}) — reached the follow-up limit.", "BASE_URL": "${BASE_URL}"}) -> NOTIFY1
            $append UNRESPONSIVE ${R.id}
        elif ${R.stage|fallback:"__missing__"} == "nagging" and ${R.nagging_count|fallback:"-1"} < ${NAG_MAX}:
            execute_skill(name="onboarding-send-emails", inputs={"PIPELINE_ID": "${R.id}", "PURPOSE": "nag", "BASE_URL": "${BASE_URL}"}) -> MAIL2
            if ${MAIL2.SENT_COUNT} < "1":
                $append NAG_FAILED "${R.prospect_name}: ${MAIL2.ERROR} ${MAIL2.FAILED}"
                execute_skill(name="onboarding-notify-admins", inputs={"ADMIN_IDS": ${ADMIN_IDS}, "TEXT": "Daily sweep: nag send FAILED for ${R.prospect_name} (${R.prospect_email}): ${MAIL2.ERROR} ${MAIL2.FAILED}", "BASE_URL": "${BASE_URL}"}) -> NOTIFY_NAG_FAIL
            else:
                execute_skill(name="onboarding-advance", inputs={"ID": "${R.id}", "STAGE": "nagging", "NOTES": "Automated nag sent (daily sweep)", "BASE_URL": "${BASE_URL}"}) -> ADV2
                $append NAG_SENT ${R.id}
        elif ${R.stage|fallback:"__missing__"} == "nagging":
            shell(argv=["curl","-s","-X","POST","${BASE_URL}/agent/onboarding/mark-unresponsive","-H","Authorization: Bearer {{secret.CM_AGENT_TOKEN_ONBOARDING}}","-H","Content-Type: application/json","-d","{\"id\":${R.id|json}}"]) -> MARK_RAW2
            execute_skill(name="onboarding-notify-admins", inputs={"ADMIN_IDS": ${ADMIN_IDS}, "TEXT": "Marked unresponsive: ${R.prospect_name} (${R.prospect_email}) — reached the nag limit without a first published event.", "BASE_URL": "${BASE_URL}"}) -> NOTIFY2
            $append UNRESPONSIVE ${R.id}
        else:
            $append UNRECOGNIZED "${R.prospect_email|fallback:\"unknown\"}: stage=${R.stage|fallback:\"MISSING\"}"
            execute_skill(name="onboarding-notify-admins", inputs={"ADMIN_IDS": ${ADMIN_IDS}, "TEXT": "Daily sweep: record matched no known branch (new stage, dropped field, or bad data) — id=${R.id|fallback:\"MISSING\"} email=${R.prospect_email|fallback:\"MISSING\"} stage=${R.stage|fallback:\"MISSING\"}", "BASE_URL": "${BASE_URL}"}) -> NOTIFY_UNRECOGNIZED
    $set FOLLOWUP_SENT_COUNT = ${FOLLOWUP_SENT|length}
    $set FOLLOWUP_FAILED_COUNT = ${FOLLOWUP_FAILED|length}
    $set NAG_SENT_COUNT = ${NAG_SENT|length}
    $set NAG_FAILED_COUNT = ${NAG_FAILED|length}
    $set UNRESPONSIVE_COUNT = ${UNRESPONSIVE|length}
    $set UNRECOGNIZED_COUNT = ${UNRECOGNIZED|length}
    emit(text="Daily sweep: ${FOLLOWUP_SENT_COUNT} follow-up(s) sent, ${FOLLOWUP_FAILED_COUNT} follow-up(s) FAILED, ${NAG_SENT_COUNT} nag(s) sent, ${NAG_FAILED_COUNT} nag(s) FAILED, ${UNRESPONSIVE_COUNT} marked unresponsive, ${UNRECOGNIZED_COUNT} unrecognized.")

default: process
