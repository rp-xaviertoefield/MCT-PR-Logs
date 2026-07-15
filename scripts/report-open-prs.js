/**
 * report-open-prs.js
 *
 * Finds open, org-wide pull requests authored by members of a given GitHub
 * team that are still waiting on reviewers, and posts a digest to a
 * Microsoft Teams channel via a Power Automate Workflow webhook.
 *
 * Required environment variables:
 *   GITHUB_TOKEN        - PAT (classic) with `repo` + `read:org` scopes.
 *                          Must be able to read the team roster and search
 *                          PRs across every repo in the org (including
 *                          private repos your team works in).
 *   GITHUB_ORG           - e.g. "radpartners"
 *   GITHUB_TEAM_SLUG      - e.g. "devops"
 *   TEAMS_WEBHOOK_URL    - Power Automate Workflow webhook URL from the
 *                          "Send webhook alerts to a channel" template
 *                          (see README). Confirmed via testing that this
 *                          template REQUIRES an Adaptive Card payload —
 *                          plain { "text": "..." } is rejected.
 *
 * Optional:
 *   FALLBACK_USERNAMES   - comma-separated GitHub usernames to use INSTEAD
 *                          of the team API, for when read:org isn't granted
 *                          yet. Example: "alice,bob,carol"
 */

const GITHUB_API = "https://api.github.com";

function must(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return v;
}

async function gh(path, token) {
  const res = await fetch(`${GITHUB_API}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub API ${path} failed: ${res.status} ${body}`);
  }
  return res.json();
}

async function getTeamMembers(org, teamSlug, token) {
  // Paginates /orgs/{org}/teams/{team_slug}/members
  let members = [];
  let page = 1;
  while (true) {
    const batch = await gh(
      `/orgs/${org}/teams/${teamSlug}/members?per_page=100&page=${page}`,
      token
    );
    members = members.concat(batch.map((u) => u.login));
    if (batch.length < 100) break;
    page += 1;
  }
  return members;
}

async function searchOpenPRsByAuthor(org, author, token) {
  // Org-wide search, not limited to any specific repo list.
  let items = [];
  let page = 1;
  while (true) {
    const q = encodeURIComponent(`org:${org} is:pr is:open -is:draft author:${author}`);
    const res = await gh(
      `/search/issues?q=${q}&per_page=100&page=${page}`,
      token
    );
    items = items.concat(res.items);
    if (res.items.length < 100) break;
    page += 1;
  }
  return items;
}

async function getRequestedReviewers(owner, repo, number, token) {
  return gh(
    `/repos/${owner}/${repo}/pulls/${number}/requested_reviewers`,
    token
  );
}

function parseRepoFromIssueUrl(url) {
  // https://api.github.com/repos/{owner}/{repo}/issues/{number}
  const m = url.match(/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)/);
  return { owner: m[1], repo: m[2], number: Number(m[3]) };
}

async function main() {
  const token = must("GITHUB_TOKEN");
  const org = must("GITHUB_ORG");
  const webhookUrl = must("TEAMS_WEBHOOK_URL");
  const teamSlug = process.env.GITHUB_TEAM_SLUG;
  const fallback = process.env.FALLBACK_USERNAMES;

  let members;
  if (fallback && fallback.trim().length > 0) {
    members = fallback.split(",").map((s) => s.trim()).filter(Boolean);
    console.log(`Using FALLBACK_USERNAMES (${members.length} users).`);
  } else if (teamSlug) {
    members = await getTeamMembers(org, teamSlug, token);
    console.log(`Fetched ${members.length} members from team "${teamSlug}".`);
  } else {
    throw new Error(
      "Set either GITHUB_TEAM_SLUG (with a read:org-scoped token) or FALLBACK_USERNAMES."
    );
  }

  if (members.length === 0) {
    console.log("No team members found; nothing to report.");
    return;
  }

  // 1. Org-wide open PRs authored by any team member.
  const perAuthorResults = await Promise.all(
    members.map((u) => searchOpenPRsByAuthor(org, u, token))
  );
  const candidatePRs = perAuthorResults.flat();

  // 2. Keep only PRs that are still waiting on reviewers.
  const waitingPRs = [];
  for (const pr of candidatePRs) {
    const { owner, repo, number } = parseRepoFromIssueUrl(pr.url);
    const reviewers = await getRequestedReviewers(owner, repo, number, token);
    const hasRequestedUsers = (reviewers.users || []).length > 0;
    const hasRequestedTeams = (reviewers.teams || []).length > 0;
    if (hasRequestedUsers || hasRequestedTeams) {
      waitingPRs.push({
        title: pr.title,
        url: pr.html_url,
        author: pr.user.login,
        repo: `${owner}/${repo}`,
        number,
        requestedReviewers: [
          ...(reviewers.users || []).map((u) => u.login),
          ...(reviewers.teams || []).map((t) => `@${owner}/${t.slug}`),
        ],
        createdAt: pr.created_at,
      });
    }
  }

  await postToTeams(webhookUrl, waitingPRs);
}

function daysOpen(createdAt) {
  const ms = Date.now() - new Date(createdAt).getTime();
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

/**
 * Threshold (days) separating "Needs attention" (shown expanded) from
 * "Backlog" (collapsed behind a toggle button). PRs opened before this
 * many days ago are backlog.
 */
const BACKLOG_THRESHOLD_DAYS = 14;

/**
 * Builds the repeated "repo header + PR list" body elements for a given
 * set of PRs. Shared between the "Needs attention" and "Backlog" sections
 * so both render identically.
 */
function buildRepoSections(prs) {
  const byRepo = {};
  for (const pr of prs) {
    byRepo[pr.repo] = byRepo[pr.repo] || [];
    byRepo[pr.repo].push(pr);
  }

  const elements = [];
  for (const [repo, repoPRs] of Object.entries(byRepo)) {
    elements.push({ type: "TextBlock", text: repo, weight: "Bolder", spacing: "Medium", wrap: true });
    for (const pr of repoPRs) {
      const age = daysOpen(pr.createdAt);
      const ageFlag = age >= BACKLOG_THRESHOLD_DAYS ? "  ⚠️ **stale**" : "";
      const reviewers = pr.requestedReviewers.join(", ") || "unassigned";
      elements.push({
        type: "TextBlock",
        text: `[#${pr.number} ${pr.title}](${pr.url})`,
        wrap: true,
      });
      elements.push({
        type: "TextBlock",
        text: `by ${pr.author} • waiting on ${reviewers} • open ${age}d${ageFlag}`,
        isSubtle: true,
        size: "Small",
        wrap: true,
        spacing: "None",
      });
    }
  }
  return elements;
}

/**
 * Builds an Adaptive Card and posts it to the Power Automate Workflow
 * webhook ("Send webhook alerts to a channel" template). This template
 * requires every payload to be wrapped in the fixed
 * { type: "message", attachments: [...] } envelope with an Adaptive Card
 * (or message card) as the attachment content — plain { text: "..." }
 * payloads are rejected by this template.
 */
async function postToTeams(webhookUrl, prs) {
  const today = new Date().toISOString().slice(0, 10);

  if (prs.length === 0) {
    await sendTeamsMessage(
      webhookUrl,
      buildCard([
        { type: "TextBlock", text: `✅ Open PR Report — ${today}`, weight: "Bolder", size: "Medium", wrap: true },
        { type: "TextBlock", text: "No open PRs from the team are currently waiting on reviewers.", wrap: true },
      ])
    );
    return;
  }

  const repoCount = new Set(prs.map((pr) => pr.repo)).size;
  const needsAttention = prs.filter((pr) => daysOpen(pr.createdAt) < BACKLOG_THRESHOLD_DAYS);
  const backlog = prs.filter((pr) => daysOpen(pr.createdAt) >= BACKLOG_THRESHOLD_DAYS);

  const body = [
    { type: "TextBlock", text: `Open PRs waiting on review — ${today}`, weight: "Bolder", size: "Medium", wrap: true },
    {
      type: "TextBlock",
      text: `${prs.length} open PR${prs.length === 1 ? "" : "s"} across ${repoCount} repo${repoCount === 1 ? "" : "s"}${backlog.length > 0 ? ` • ${backlog.length} in backlog (⚠️ open ≥${BACKLOG_THRESHOLD_DAYS}d)` : ""}`,
      weight: "Bolder",
      wrap: true,
      spacing: "Small",
    },
  ];

  body.push({ type: "TextBlock", text: `🔔 Needs attention (opened < ${BACKLOG_THRESHOLD_DAYS} days ago)`, weight: "Bolder", spacing: "Medium", wrap: true });
  if (needsAttention.length === 0) {
    body.push({ type: "TextBlock", text: "Nothing new — everything below is longer-standing backlog.", isSubtle: true, wrap: true });
  } else {
    body.push(...buildRepoSections(needsAttention));
  }

  if (backlog.length > 0) {
    body.push({
      type: "ActionSet",
      spacing: "Medium",
      actions: [
        {
          type: "Action.ToggleVisibility",
          title: `Show ${backlog.length} backlog PR${backlog.length === 1 ? "" : "s"} (⚠️ open ≥${BACKLOG_THRESHOLD_DAYS}d)`,
          targetElements: ["backlogSection"],
        },
      ],
    });
    body.push({
      type: "Container",
      id: "backlogSection",
      isVisible: false,
      spacing: "Small",
      items: [
        { type: "TextBlock", text: "⚠️ Backlog", weight: "Bolder", wrap: true },
        ...buildRepoSections(backlog),
      ],
    });
  }

  await sendTeamsMessage(webhookUrl, buildCard(body));
}

function buildCard(bodyElements) {
  return {
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        content: {
          type: "AdaptiveCard",
          $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
          version: "1.4",
          body: bodyElements,
        },
      },
    ],
  };
}

async function sendTeamsMessage(webhookUrl, payload) {
  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Teams webhook failed: ${res.status} ${body}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
