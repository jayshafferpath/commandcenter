// Posts a PR to Slack on demand via a Workflow Builder trigger — never on a
// timer, never as a backfill. The workflow owns the channel and formatting;
// this just sends a flat payload. Off entirely when
// SLACK_WORKFLOW_URL_PR_ANNOUNCE is unset.
//
// Idempotency state lives at ~/.commandcenter/slack-posted-prs.json (not
// tmpdir) so it survives reboots. PRs are keyed by URL and never pruned, so
// asking twice for the same PR posts it once.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const STATE_DIR = join(homedir(), ".commandcenter");
const STATE_FILE = join(STATE_DIR, "slack-posted-prs.json");

export function isAnnounceConfigured() {
  return Boolean(process.env.SLACK_WORKFLOW_URL_PR_ANNOUNCE);
}

// A missing file is just "nothing posted yet". Anything else — unreadable,
// corrupt JSON — throws rather than reading as empty, since an empty set
// would let every PR post again.
export function loadPostedUrls() {
  let raw;
  try {
    raw = readFileSync(STATE_FILE, "utf-8");
  } catch (err) {
    if (err.code === "ENOENT") return new Set();
    throw err;
  }
  return new Set(JSON.parse(raw));
}

function writePostedUrls(postedUrls) {
  mkdirSync(STATE_DIR, { recursive: true });
  const tmpFile = `${STATE_FILE}.tmp`;
  writeFileSync(tmpFile, JSON.stringify([...postedUrls]), "utf-8");
  renameSync(tmpFile, STATE_FILE);
}

// `text` matches the existing Slack workflow, which declares only that one
// input (same message jay-claude-plugins' review requests sent). The other
// fields ride along for a workflow that wants to lay the message out itself.
async function postToSlack(webhookUrl, pr) {
  const payload = {
    text: `:pr-review-request: ${pr.title}\n${pr.url}`,
    title: pr.title,
    url: pr.url,
    repo: pr.repo,
    number: String(pr.number),
  };

  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Slack workflow trigger failed (${res.status}): ${text}`);
  }
}

// Guards a double-click (or Pearl and a click racing) from both passing the
// posted-set check before either has recorded the PR.
const inFlight = new Set();

// pr: { url, title, repo, number }. Resolves "posted" or "already_posted";
// throws on a failed POST, leaving the PR unrecorded so asking again retries.
export async function announcePr(pr) {
  const webhookUrl = process.env.SLACK_WORKFLOW_URL_PR_ANNOUNCE;
  if (!webhookUrl) {
    throw new Error("SLACK_WORKFLOW_URL_PR_ANNOUNCE is not set");
  }
  if (inFlight.has(pr.url)) return "already_posted";

  inFlight.add(pr.url);
  try {
    const postedUrls = loadPostedUrls();
    if (postedUrls.has(pr.url)) return "already_posted";

    await postToSlack(webhookUrl, pr);
    postedUrls.add(pr.url);
    writePostedUrls(postedUrls);
    return "posted";
  } finally {
    inFlight.delete(pr.url);
  }
}

export const __test__ = {
  STATE_FILE,
};
