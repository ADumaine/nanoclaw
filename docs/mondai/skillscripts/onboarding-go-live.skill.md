# Skill: onboarding-go-live
# Description: Full "save Luma link and go live" sequence as one atomic deterministic action. Call once a chapter is verified and the admin has provided the Luma calendar URL. Links the Luma calendar, sends the go-live email to the prospect (and co-leads), notifies the calendar manager via whichever of Telegram/email is configured (both independently), and advances the record to nagging — all in one call, regardless of whether the calendar-manager notify succeeded.
# Vars: ID, CALENDAR_URL, BASE_URL="http://192.168.1.50:8888"
# Returns: LUMA_LINKED, GOLIVE_EMAIL_SENT, CAL_MGR_TELEGRAM_NOTIFIED, CAL_MGR_EMAIL_NOTIFIED, FINAL_STAGE
# Requires: secret.CM_AGENT_TOKEN_ONBOARDING
# Status: Approved
get_record:
    shell(argv=["curl","-s","${BASE_URL}/agent/onboarding/get/${ID}","-H","Authorization: Bearer {{secret.CM_AGENT_TOKEN_ONBOARDING}}"]) -> RECORD_RAW
    $ json_parse ${RECORD_RAW} -> RECORD
    $set CHAPTER_NAME = "${RECORD.data.chapters.name}"

link_luma:
    needs: get_record
    shell(argv=["curl","-s","-X","POST","${BASE_URL}/agent/onboarding/link-luma","-H","Authorization: Bearer {{secret.CM_AGENT_TOKEN_ONBOARDING}}","-H","Content-Type: application/json","-d","{\"id\":${ID|json},\"calendar_url\":${CALENDAR_URL|json}}"]) -> LUMA_RAW
    $ json_parse ${LUMA_RAW} -> LUMA
    $set LUMA_LINKED = "${LUMA.success}"

render_and_send_golive:
    needs: link_luma
    execute_skill(name="onboarding-send-emails", inputs={"PIPELINE_ID": "${ID}", "PURPOSE": "go_live", "BASE_URL": "${BASE_URL}"}) -> MAIL
    if ${MAIL.PREPARED} != "true":
        $set GOLIVE_EMAIL_SENT = "false"
    elif ${MAIL.SENT_COUNT} < "1":
        $set GOLIVE_EMAIL_SENT = "false"
    elif ${MAIL.FAILED_COUNT} > "0":
        $set GOLIVE_EMAIL_SENT = "partial: sent to ${MAIL.SENT_TO}; FAILED ${MAIL.FAILED}"
    else:
        $set GOLIVE_EMAIL_SENT = "true"

notify_cal_mgr:
    needs: render_and_send_golive
    $set CAL_MGR_MESSAGE = "New chapter needs graphics/customization: ${CHAPTER_NAME}. Luma calendar: ${CALENDAR_URL}"
    shell(argv=["curl","-s","${BASE_URL}/agent/onboarding/settings","-H","Authorization: Bearer {{secret.CM_AGENT_TOKEN_ONBOARDING}}"]) -> SETTINGS_RAW
    $ json_parse ${SETTINGS_RAW} -> SETTINGS
    $set TELEGRAM_ID = "${SETTINGS.data.cal_mgr_telegram_id|fallback:\"\"}"
    $set CAL_MGR_EMAIL = "${SETTINGS.data.cal_mgr_email|fallback:\"\"}"
    $set CAL_MGR_TELEGRAM_NOTIFIED = "false"
    $set CAL_MGR_EMAIL_NOTIFIED = "false"
    if ${TELEGRAM_ID} != "":
        shell(argv=["curl","-s","-X","POST","${BASE_URL}/agent/onboarding/notify-telegram","-H","Authorization: Bearer {{secret.CM_AGENT_TOKEN_ONBOARDING}}","-H","Content-Type: application/json","-d","{\"telegram_id\":${TELEGRAM_ID|json},\"text\":${CAL_MGR_MESSAGE|json}}"]) -> TG_RAW
        $set CAL_MGR_TELEGRAM_NOTIFIED = "true"
    if ${CAL_MGR_EMAIL} != "":
        $ gmail.send_email to=["${CAL_MGR_EMAIL}"] subject="New chapter needs graphics: ${CHAPTER_NAME}" body="${CAL_MGR_MESSAGE}" mimeType="text/plain" approved="calendar manager go-live notification" -> CAL_MGR_EMAIL_RESULT
        if not ${CAL_MGR_EMAIL_RESULT|contains:"Error:"}:
            $set CAL_MGR_EMAIL_NOTIFIED = "true"

advance:
    needs: notify_cal_mgr
    execute_skill(name="onboarding-advance", inputs={"ID": "${ID}", "STAGE": "nagging", "NOTES": "Luma linked, go-live email sent, calendar manager notified", "BASE_URL": "${BASE_URL}"}) -> ADV
    $set FINAL_STAGE = "${ADV.NEW_STAGE}"
    emit(text="Luma linked: ${LUMA_LINKED}. Go-live email sent: ${GOLIVE_EMAIL_SENT}. Calendar manager notified — telegram: ${CAL_MGR_TELEGRAM_NOTIFIED}, email: ${CAL_MGR_EMAIL_NOTIFIED}. Final stage: ${FINAL_STAGE}.")

default: advance
