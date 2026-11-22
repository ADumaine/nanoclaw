# Skill: onboarding-dashboard-trigger
# Description: Deterministic handling of the admin-dashboard "chapter onboarding initiated" trigger — the `[SYSTEM: dashboard-chapter-onboarding]` system message NanoClaw's host intercepts before it reaches the LLM agent. Fetches the pipeline record, branches on its stage, and sends the welcome email (via onboarding-send-emails: the API picks recipients and templates, including co-organizers) when the stage is `invited`, or `new`/`referred` (then advances the record to `invited`); on a confirmed send, stamps `last_contact_at` via `POST /agent/onboarding/touch` so the record isn't invisible to the daily sweep. History: docs/mondai/chapter-onboarding-followup-gap.md.
# Vars: PIPELINE_ID, BASE_URL="http://192.168.1.50:8888"
# Returns: OUTCOME, STAGE, REPLY_TEXT
# Requires: secret.CM_AGENT_TOKEN_ONBOARDING
# Status: Approved
get_record:
    shell(argv=["curl","-s","${BASE_URL}/agent/onboarding/get/${PIPELINE_ID}","-H","Authorization: Bearer {{secret.CM_AGENT_TOKEN_ONBOARDING}}"]) -> RECORD_RAW
    $ json_parse ${RECORD_RAW} -> RECORD
    $set STAGE = "${RECORD.data.stage}"
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
        execute_skill(name="onboarding-send-emails", inputs={"PIPELINE_ID": "${PIPELINE_ID}", "PURPOSE": "welcome", "BASE_URL": "${BASE_URL}"}) -> MAIL
        if ${MAIL.PREPARED} != "true":
            $set OUTCOME = "no_recipient"
            $set REPLY_TEXT = "No welcome email sent for ${CHAPTER_NAME}: ${MAIL.ERROR|fallback:\"the API could not prepare the email\"}. Do not retry — set a lead or co-organizer on the chapter first."
        elif ${MAIL.SENT_COUNT} < "1":
            $set OUTCOME = "send_failed"
            $set REPLY_TEXT = "Failed to send welcome email for ${CHAPTER_NAME}: ${MAIL.FAILED}"
        else:
            shell(argv=["curl","-s","-X","POST","${BASE_URL}/agent/onboarding/touch","-H","Authorization: Bearer {{secret.CM_AGENT_TOKEN_ONBOARDING}}","-H","Content-Type: application/json","-d","{\"id\":${PIPELINE_ID|json},\"notes\":\"Welcome email dispatched\"}"]) -> TOUCH_RAW
            $ json_parse ${TOUCH_RAW} -> TOUCH
            $set TOUCH_ERROR = "${TOUCH.error|fallback:\"\"}"
            $set OUTCOME = "sent"
            $set REPLY_TEXT = "Welcome email sent for ${CHAPTER_NAME} to: ${MAIL.SENT_TO}."
            if ${MAIL.FAILED_COUNT} > "0":
                $set OUTCOME = "sent_partial"
                $set REPLY_TEXT = "${REPLY_TEXT} Warning: some recipients failed (${MAIL.FAILED}) — send those manually, do not re-run the trigger or the others will be emailed twice."
            if ${TOUCH_ERROR} != "":
                $set REPLY_TEXT = "${REPLY_TEXT} Warning: failed to stamp contact timestamp (${TOUCH_ERROR}) — flag this record for manual follow-up if no automatic nudge appears later."
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
