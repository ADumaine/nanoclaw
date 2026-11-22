# Skill: onboarding-send-emails
# Status: Approved
# Description: Prepare and send every onboarding email for one purpose (welcome, follow_up, go_live, nag) via cm-data-api POST /agent/onboarding/prepare-emails. The API picks the recipients (lead and, for welcome/go_live, co-organizers) and each person's template, and returns one rendered email per person; this skill sends them all. Callers must not choose templates or build recipient lists. PREPARED is "false" when the API refuses (409 = nobody can receive this email) — do not retry. Co-organizers are separate emails, so one failure does not block the others.
# Vars: PIPELINE_ID, PURPOSE, BASE_URL="http://192.168.1.50:8888"
# Returns: PREPARED, ERROR, SENT_COUNT, FAILED_COUNT, SENT_TO, FAILED
# Requires: secret.CM_AGENT_TOKEN_ONBOARDING

prepare:
    shell(argv=["curl","-s","-X","POST","${BASE_URL}/agent/onboarding/prepare-emails","-H","Authorization: Bearer {{secret.CM_AGENT_TOKEN_ONBOARDING}}","-H","Content-Type: application/json","-d","{\"pipelineId\":${PIPELINE_ID|json},\"purpose\":${PURPOSE|json}}"]) -> RAW
    $ json_parse ${RAW} -> PREP
    $set PREPARED = "${PREP.success|fallback:\"false\"}"
    $set ERROR = "${PREP.error|fallback:\"\"}"

send:
    needs: prepare
    $set SENT_TO = []
    $set FAILED = []
    if ${PREPARED} == "true":
        foreach E in ${PREP.data.emails}:
            $ gmail.send_email to=${E.recipient} subject=${E.subject|json} body=${E.htmlBody|json} mimeType="text/html" approved="onboarding email (prepare-emails)" -> SEND
            if ${SEND|contains:"Error:"}:
                $append FAILED "${E.to}: ${SEND}"
            else:
                $append SENT_TO ${E.to}
    $set SENT_COUNT = ${SENT_TO|length}
    $set FAILED_COUNT = ${FAILED|length}
    emit(text="prepared=${PREPARED} sent=${SENT_COUNT} failed=${FAILED_COUNT} ${ERROR}")

default: send
