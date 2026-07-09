# MCT-PR-Logs

Daily digest of open PRs from DevOps team members that are still waiting
on a reviewer, posted to a Microsoft Teams channel — across **every repo
in the org** (not limited to a fixed repo list).

> **Status:** this is Xavier's personal build/test repo. Once verified
> working (see testing checklist below), the two files here get copied
> as-is into a team-owned repo and pointed at the real "Open PR's" public
> channel instead of the personal test channel. See DISOPS-7646 for the
> full history/design decisions.

## What it does

1. Looks up the members of the `devops` GitHub team (org-wide).
2. Searches GitHub org-wide for open PRs authored by those members.
3. For each PR, checks whether it still has requested reviewers pending.
4. Posts the filtered list to a Microsoft Teams channel via a Power
   Automate Workflow webhook.

## A note on Teams webhooks

Microsoft has retired the old-style "Office 365 Connector" incoming
webhooks that Teams used to support. The current, supported way to receive
a webhook into a Teams channel is a **Power Automate Workflow** — it
serves the same purpose (an external app POSTs JSON, a message shows up in
the channel) but is set up inside Teams/Power Automate rather than through
an "app" the way Slack does it. Private and public channels are both
supported.

## One-time setup

### 1. Create/identify the Teams channel
For testing: a personal channel (e.g. "Daily PR Reports testing/tweaking").
For production: the real "Open PR's" channel.

### 2. Create a Power Automate Workflow webhook for that channel
- In Teams, go to the channel → **More options (···)** → **Workflows**.
- Search for the template **"Post to a channel when a webhook request is
  received"** (for a DM/self-chat instead, use **"Post to a chat when a
  webhook request is received"**).
- Select the Team and channel (or chat).
- When prompted for a sample JSON payload (to define the schema), paste:
```json
  { "text": "sample message" }
```
- Save. Copy the generated webhook URL — this is what the script posts to.

### 3. Generate a GitHub PAT with the right scopes
Go to GitHub → Settings → Developer settings → Personal access tokens
(classic is simplest) → generate one with:
- `repo` (to search PRs across private repos)
- `read:org` (to read team membership)

### 4. Add repo secrets
Settings → Secrets and variables → Actions:
- `ORG_PAT` = the PAT from step 3
- `TEAMS_WEBHOOK_URL` = the webhook URL from step 2

### 5. Test it
Go to the Actions tab → "Open PR Report to Teams" → **Run workflow** (the
`workflow_dispatch` trigger lets you fire it on demand instead of waiting
for the cron).

## Testing checklist (recommended order, safest/most private first)

1. curl the webhook URL directly with a sample `{"text": "..."}` payload —
   fastest way to check message formatting before running the Action at all.
2. Point the webhook at a DM/chat to yourself first (not a channel).
3. Manually run the GitHub Action (`workflow_dispatch`) against that
   self-DM webhook — validates the full pipeline end-to-end.
4. Swap `TEAMS_WEBHOOK_URL` to the real target channel and run once more
   manually to confirm.
5. Only then enable the `schedule` cron trigger.

## If read:org isn't available yet

You can skip the team lookup entirely and just hardcode usernames as a
stopgap. In the workflow file, comment out `GITHUB_TEAM_SLUG` and uncomment
`FALLBACK_USERNAMES: "user1,user2,user3"` with your team's GitHub logins.
Swap back to `GITHUB_TEAM_SLUG` once the PAT has `read:org`.

## Tuning

- **Schedule**: edit the `cron` line in the workflow (currently 8am Mon–Fri,
  US Central — cron is always UTC, so adjust for your timezone/DST).
- **"Stale" flag**: PRs open ≥ 3 days get a ⚠️ *stale* tag in the message.
  Change the `age >= 3` check in `report-open-prs.js` to adjust.
- **Grouping**: messages are grouped by repo. Adjust `postToTeams()` if
  you'd rather group by author.
- **Message format**: the script sends plain markdown text. If you want
  richer formatting (cards, buttons, colors), you can upgrade the workflow
  step in Power Automate to render an Adaptive Card instead of plain text —
  the script's `sendTeamsMessage()` payload shape would need to change to
  match whatever schema the Adaptive Card action expects.

## Porting to the team repo

Once testing passes, copy these two files as-is into the team repo:
