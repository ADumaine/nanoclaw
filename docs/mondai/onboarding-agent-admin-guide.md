# Chapter Onboarding Bot — Administrator Guide

The Chapter Onboarding Bot manages the CryptoMondays chapter pipeline end to end: from the first outreach to a prospective chapter lead, through scheduling and calendar setup, to the chapter's first published event. It runs mostly on its own, but you can talk to it directly at any time to check on things or ask it to take action.

## Where to reach it

- **Telegram**: message the bot in the dedicated Onboarding topic in the chapter administrators group.
- **Admin dashboard**: use the chat panel on a chapter's detail page.

Replies always go back to wherever you asked from — a question in Telegram gets a Telegram reply, a question from a chapter's dashboard panel gets a reply there.

## What you can ask it to do

- **Add a new prospect or chapter** to the onboarding pipeline — it creates the record and sends the right welcome email automatically.
- **Move an existing (manual or inactive) chapter into onboarding** — it checks the chapter's current state first and picks the right starting point, including handling a chapter that's being reactivated after going inactive.
- **Handle a prospect's email reply** — normally automatic (see below), but you can also ask it to check for a specific reply directly.
- **Record the outcome of a call** — mark a lead verified, or record a decline.
- **Save a chapter's calendar link and go live** — links the chapter's calendar, sends the go-live email, and notifies the calendar manager.
- **Mark a chapter active** once its first event is published.
- **Run the daily pipeline sweep on demand** — normally automatic, but you can ask it to run one right now (e.g. "run the daily sweep now" or "check for stalled chapters").
- **Send the weekly growth digest on demand** — normally automatic, weekly.
- **Show the full pipeline** — ask it to list current chapters/prospects and their stage.

Just describe what you want in plain language (e.g. "add a new chapter for Springfield," "run the daily sweep now," "what's the status on OB-12345") — it will ask for anything it needs.

## What happens automatically, without anyone asking

Three things run in the background on a fixed schedule:

| Task | Frequency | What it does |
|---|---|---|
| Reply check | Every 5 minutes | Checks the onboarding inbox for prospect replies, matches them to a pipeline record, and takes action (advances the pipeline, sends a scheduling note, or flags for a human) — but only messages you when something actually needs your attention. Silence means there was nothing new. |
| Daily sweep | Once a day | Sends scheduled follow-ups and reminders to prospects who are overdue for contact, marks anyone unresponsive past the limit, and sends you a daily digest summarizing what happened and what needs a human decision. |
| Weekly digest | Once a week | Sends a growth summary to the Champions group. |

**You can ask the bot about these directly** — this isn't just internal plumbing:
- *"Are your scheduled tasks running?"* — it will check and tell you.
- *"Pause the daily sweep"* / *"Pause everything"* — temporarily stops a task without losing its schedule; ask it to resume later.
- *"Cancel the weekly digest"* — removes it entirely (it would need to be set up again from scratch to bring back).
- *"Change the daily sweep to run at 8am instead"* — adjusts the schedule.

## Turning onboarding processing on or off

There's a separate on/off switch for onboarding automation (in the admin dashboard's chapter settings). When it's **off**:

- The bot stops sending emails, advancing pipeline stages, and taking any other automatic action.
- It keeps checking the inbox every 5 minutes as usual, but instead of processing replies, it sets them aside as "Ignored" without acting on them or bothering anyone — nothing is lost, but nothing gets an automatic response either.
- The daily and weekly digests are skipped while it's off.

**When you turn it back on**, anything that came in while it was off is sitting in that "Ignored" set, not in the normal handled queue — the bot won't automatically revisit these to catch up, so someone should check that backlog once processing resumes and decide what needs a manual follow-up. The daily digest will tell you how many are currently sitting there, so you'll always know if there's a backlog to review even if you forget it exists.

## If something seems wrong

If the bot isn't responding, seems stuck, or a scheduled task doesn't seem to be running, ask it directly first ("are you working correctly?" / "check your scheduled tasks") — it can usually tell you its own status. If that doesn't resolve it, contact the technical team.
