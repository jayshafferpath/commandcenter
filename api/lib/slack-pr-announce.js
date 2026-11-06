// Posts each authored PR to Slack exactly once via a Workflow Builder
// trigger. The workflow owns the channel and formatting; this just sends a
// flat payload. Off entirely when SLACK_WORKFLOW_URL_PR_ANNOUNCE is unset.
//
// Idempotency state lives at ~/.commandcenter/slack-posted-prs.json (not
// tmpdir) so it survives reboots. PRs are keyed by URL and never pruned once
// posted — a closed/merged PR's key stays in the set forever, which is also
// what makes "never repost" trivially true across restarts.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { searchMyPrs } from "./pr.js";

const STATE_DIR = join(homedir(), ".commandcenter");
const STATE_FILE = join(STATE_DIR, "slack-posted-prs.json");
const POLL_INTERVAL_MS = 5 * 60 * 1000;

// Pure: given the currently open authored PRs and the set of URLs already
// posted, return the PRs that should be posted now. A draft is skipped every
// poll until it's no longer a draft, at which point it's new to `postedUrls`
// and gets posted — once.
export function selectPrsToAnnounce(prs, postedUrls) {
  return prs.filter((pr) => !pr.isDraft && !postedUrls.has(pr.url));
}

// null distinguishes "no state file yet" (first run — seed, don't post)
// from "state file exists but is empty".
function loadPostedState() {
  try {
    const raw = readFileSync(STATE_FILE, "utf-8");
    return new Set(JSON.parse(raw));
  } catch {
    return null;
  }
}

function writePostedState(postedUrls) {
  mkdirSync(STATE_DIR, { recursive: true });
  const tmpFile = `${STATE_FILE}.tmp`;
  writeFileSync(tmpFile, JSON.stringify([...postedUrls]), "utf-8");
  renameSync(tmpFile, STATE_FILE);
}

// One PR recorded and persisted at a time, immediately after its own POST
// succeeds — so a crash mid-batch can't repost whatever already went out.
function recordPosted(postedUrls, url) {
  postedUrls.add(url);
  writePostedState(postedUrls);
}

async function postToSlack(webhookUrl, pr) {
  const payload = {
    title: pr.title,
    url: pr.url,
    repo: pr.repository?.nameWithOwner || "",
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

let running = false;

// One poll pass: seed-on-first-run, or post anything new. Guards against
// overlapping runs the same way pollRunningJobs's setInterval does — this
// just needs its own flag since there's no job registry to check.
export async function pollPrAnnouncements({ log } = {}) {
  const webhookUrl = process.env.SLACK_WORKFLOW_URL_PR_ANNOUNCE;
  if (!webhookUrl) return;

  if (running) return;
  running = true;

  try {
    const prs = searchMyPrs({ role: "author" });
    let postedUrls = loadPostedState();

    if (postedUrls === null) {
      // Turning the feature on shouldn't blast the whole backlog into
      // Slack — mark everything currently open (drafts included) as
      // already-seen and post nothing this pass.
      postedUrls = new Set(prs.map((pr) => pr.url));
      writePostedState(postedUrls);
      log?.info(
        `Slack PR announcements: seeded ${postedUrls.size} existing open PR(s), posted none`,
      );
      return;
    }

    for (const pr of selectPrsToAnnounce(prs, postedUrls)) {
      try {
        await postToSlack(webhookUrl, pr);
        recordPosted(postedUrls, pr.url);
        log?.info(`Slack PR announcement posted: ${pr.url}`);
      } catch (err) {
        log?.error(`Slack PR announcement failed for ${pr.url}: ${err.message}`);
      }
    }
  } finally {
    running = false;
  }
}

export function startPrAnnouncementPoll({ log } = {}) {
  pollPrAnnouncements({ log });
  setInterval(() => pollPrAnnouncements({ log }), POLL_INTERVAL_MS);
}

export const __test__ = {
  STATE_FILE,
  loadPostedState,
  writePostedState,
  postToSlack,
};
