# Open PR Report → Microsoft Teams

Posts a daily digest to a Microsoft Teams channel of open PRs, authored by
your DevOps team, that are still waiting on a reviewer — across **every
repo in the org** (not limited to a fixed repo list).

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
an "app" the way Slack does it. Private channels are supported.

## One-time setup (you'll need to do these — I don't have Teams/org-admin access)

### 1. Create the Teams channel
Create a **private** channel called `Open PR's` in the relevant Team.

### 2. Create a Power Automate Workflow webhook for that channel
- In Teams, go to **View more apps** (left sidebar) → **Workflows** → **Create** (or via the channel's **···** → **Workflows**).
- Search `webhook` and select **"Send webhook alerts to a channel"** (the exact template name shown in-app — search the single word `webhook` if the full phrase doesn't match).
- Select the Team and the `Open PR's` channel.
- Save. Click **Copy webhook link** to get the URL — this is what the script posts to.

> **Confirmed by testing:** this template requires every payload to be an
> **Adaptive Card** (or message card) wrapped in the standard
> `{ type: "message", attachments: [...] }` envelope. A plain
> `{ "text": "..." }` payload is rejected. `report-open-prs.js` already
> builds this envelope for you — nothing to configure on the payload shape.

### 3. Generate a GitHub PAT with the right scopes
Go to GitHub → Settings → Developer settings → Personal access tokens
(classic is simplest) → generate one with:
- `repo` (to search PRs across private repos)
- `read:org` (to read team membership)

> Note: I attempted this from my side and got `Resource not accessible by
> integration` when reading the `devops` team — the connector I'm using
> doesn't have `read:org`. A PAT you generate yourself and drop in as a
> repo secret sidesteps that; it doesn't depend on my connector's scopes.

### 4. Add repo secrets
In the repo you place this workflow in (Settings → Secrets and variables → Actions):
- `ORG_PAT` = the PAT from step 3
- `TEAMS_WEBHOOK_URL` = the webhook URL from step 2

### 5. Drop these two files into that repo
```
.github/workflows/open-pr-report.yml
scripts/report-open-prs.js
```

### 6. Test it
Go to the Actions tab → "Open PR Report to Teams" → **Run workflow** (the
`workflow_dispatch` trigger lets you fire it on demand instead of waiting
for the cron).

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
- **Message format**: the script builds an Adaptive Card (`buildCard()` in
  `report-open-prs.js`) — required by the "Send webhook alerts to a
  channel" template. Add fields, colors, or Adaptive Card elements
  (Columns, FactSet, etc.) inside `buildCard()`'s `body` array to change
  the layout.
