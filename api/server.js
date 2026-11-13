import "./lib/load-env.js";

import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import cors from "@fastify/cors";
import {
  searchIssues,
  getIssue,
  createIssue,
  getCurrentUser,
  transitionForEvent,
} from "./lib/jira.js";
import { isPrUrl, searchMyPrs, viewPr } from "./lib/pr.js";
import { adfToPlainText } from "./lib/adf.js";
import {
  closeJob,
  findRunningJobForReview,
  findRunningJobForTicket,
  getJob,
  listJobs,
  openInIterm,
  serializeJob,
  startCommandJob,
} from "./run-command.js";
import { brainInstructions, canvasPathFor, ensureBrainDir, readBrain } from "./brain.js";
import { openPearl, PEARL_NAME, readSoul, refreshPearl, writeSoul } from "./pearl.js";
import {
  ackCommand,
  clearCommand,
  connectVscode,
  getVscodeStatus,
  matchWalkthroughForRepo,
  moveCommand,
  VscodeNotConnectedError,
  VscodeRepoMismatchError,
  VscodeUnknownReviewError,
  waitForCommand,
} from "./vscode.js";
import { repoNotFoundError, resolveRepoRoot } from "./lib/util.js";
import { loadDevRoot, getJiraAuth } from "./lib/config.js";
import { announcePr, isAnnounceConfigured, loadPostedUrls } from "./lib/slack-pr-announce.js";
import { createMemory, findMemoryBin, MemoryError, MemoryExistsError, MemoryNotFoundError } from "./lib/pearl-memory.js";
import {
  abandonReview,
  addComment,
  completeRound,
  confirmChecklistItem,
  dispatchWalkthrough,
  getRound,
  getSession,
  listComments,
  listReviews,
  nextRound,
  resolveComment,
  setRoundGroups,
  startReview,
} from "./review.js";
import { hush as hushVoice, isValidVoiceId, speak as speakVoice, voiceInstructions } from "./voice.js";

// Personal todos are Jira issues too — a different label, not a different
// system. Kept configurable rather than hardcoded since the project/label
// are deployment-specific, same spirit as JIRA_DOMAIN etc.
// No default — unlike ISSUE_TYPE/LABEL, a project key is specific to one
// person's Jira instance, so guessing one would create issues in a project
// the operator never chose.
const TODO_PROJECT_KEY = process.env.TODO_PROJECT_KEY || "";
const TODO_ISSUE_TYPE = process.env.TODO_ISSUE_TYPE || "Task";
const TODO_LABEL = process.env.TODO_LABEL || "Todo";

const REVIEW_ROLES = ["walkthrough", "changes"];

// Cached for the process lifetime — it's the same account on every request.
let currentUserAccountId = null;
async function resolveCurrentUserAccountId() {
  if (currentUserAccountId) return currentUserAccountId;
  const me = await getCurrentUser();
  currentUserAccountId = me.accountId;
  return currentUserAccountId;
}

const DEV_ROOT = loadDevRoot();
const JIRA_DOMAIN = getJiraAuth()?.domain || null;
// Pearl's cwd: one level up from api/ is this repo's root, which also holds
// SOUL.md (readSoul/writeSoul resolve relative to it).
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const app = Fastify({ logger: true });

await app.register(cors, { origin: true });

const TICKET_FIELDS = [
  "key",
  "summary",
  "status",
  "labels",
  "issuelinks",
  "parent",
  "issuetype",
  "updated",
  "duedate",
];

function blockedByKeys(issuelinks) {
  return (issuelinks || [])
    .filter((l) => l.type?.inward === "is blocked by" && l.inwardIssue)
    .map((l) => l.inwardIssue.key);
}

function blocksKeys(issuelinks) {
  return (issuelinks || [])
    .filter((l) => l.type?.outward === "blocks" && l.outwardIssue)
    .map((l) => l.outwardIssue.key);
}

// Every open ticket assigned to you — plain Jira facts, no inferred
// workflow state. TODO_LABEL is excluded so the Todos column's own issues
// (same account, also assigned to you) don't double up here — written as
// "(labels is EMPTY OR labels != X)" rather than a bare "labels != X"
// because Jira's negated multi-value comparisons silently drop every issue
// with no labels set at all, which is most of them.
async function buildSnapshot() {
  const issues = await searchIssues(
    `assignee = currentUser() AND statusCategory != Done AND (labels is EMPTY OR labels != "${TODO_LABEL}")`,
    TICKET_FIELDS,
  );

  const tickets = issues
    .filter((i) => (i.fields.issuetype?.hierarchyLevel ?? 0) < 1)
    .map((issue) => {
      const fields = issue.fields;
      // Lets a ticket row jump straight to its own live session instead of
      // only knowing a dispatch is possible — the running job this ticket
      // already has, if any, keyed by the same ticketKey the dispatch route
      // tags the job with.
      const activeJob = findRunningJobForTicket(issue.key);
      return {
        key: issue.key,
        summary: fields.summary,
        statusName: fields.status?.name || null,
        labels: fields.labels || [],
        issueType: fields.issuetype?.name || null,
        isSubtask: fields.issuetype?.subtask === true,
        blockedBy: blockedByKeys(fields.issuelinks),
        blocks: blocksKeys(fields.issuelinks),
        dueDate: fields.duedate || null,
        activeJobId: activeJob?.id || null,
      };
    });

  return { tickets };
}

app.get("/api/tickets", async () => {
  const { tickets } = await buildSnapshot();

  return {
    jiraBaseUrl: JIRA_DOMAIN ? `https://${JIRA_DOMAIN}/browse` : null,
    tickets,
    pearlName: PEARL_NAME,
  };
});

// Just the facts for a single ticket — no inferred workflow state, no
// checklist/plan/activity-log reading. PR info across all repos is its own
// dedicated column (PrColumn), not preloaded here.
//
// Shared by the GET route below and /api/dispatch: a dispatched agent gets
// exactly what a human sees expanding the ticket in TicketDetail, not a
// thinner hand-rolled summary.
async function getTicketDetail(key) {
  const issue = await getIssue(key);
  const fields = issue.fields;

  const parent = fields.parent;
  const isSubtask = ["Sub-task", "Subtask"].includes(fields.issuetype?.name || "");
  const stack = isSubtask && parent
    ? { key: parent.key, summary: parent.fields?.summary || "" }
    : null;

  return {
    key,
    summary: fields.summary,
    status: fields.status?.name || "Unknown",
    labels: fields.labels || [],
    stack,
    blockedBy: blockedByKeys(fields.issuelinks),
    blocks: blocksKeys(fields.issuelinks),
    dueDate: fields.duedate || null,
    description: adfToPlainText(fields.description),
  };
}

app.get("/api/tickets/:key", async (request) => getTicketDetail(request.params.key));

app.get("/api/jobs", async () => ({
  // startedAt is null for a session adopted with no meta file on disk —
  // sorts last (oldest) rather than crashing the whole list on a bare
  // `.localeCompare` call against null.
  jobs: listJobs()
    .map((job) => serializeJob(job))
    .sort((a, b) => (b.startedAt || "").localeCompare(a.startedAt || "")),
}));

app.get("/api/jobs/:id", async (request, reply) => {
  const job = getJob(request.params.id);
  if (!job) {
    reply.code(404);
    return { ok: false, error: "Unknown job" };
  }
  return { ok: true, job: serializeJob(job, { includeLog: true }) };
});

// Brain View's current canvas — polled by the dashboard while its page is
// open. 404s the same way a missing job does, both when the job itself is
// unknown and when the job predates every dispatch getting a brain dir.
app.get("/api/jobs/:id/brain", async (request, reply) => {
  const job = getJob(request.params.id);
  if (!job) {
    reply.code(404);
    return { ok: false, error: "Unknown job" };
  }
  const brain = readBrain(job.id);
  if (!brain) {
    reply.code(404);
    return { ok: false, error: "This job has no brain canvas" };
  }
  return { ok: true, ...brain };
});

// Pair Pal (vscode-extension/): the agent's own presence in Jay's editor,
// one state file per review id (same ~/.commandcenter/review/<id>/ review.js
// already owns) — see .plans/vscode-walkthrough-bridge.md Phase A. 404s on
// an unknown review (connect) or an id that's never connected (every other
// route), the same way the job routes above 404 on an unknown job.

// Polled by the extension (when commandCenter.sessionId isn't set) to find
// which review to connect to: the single review whose walkthrough is in
// progress for the workspace it has open. Several at once for one repo is
// logged and answered as no match — see matchWalkthroughForRepo.
app.get("/api/vscode/discover", async (request, reply) => {
  const { repo } = request.query ?? {};
  if (!repo) {
    reply.code(400);
    return { ok: false, error: "repo query param is required" };
  }
  const { match, ambiguous } = matchWalkthroughForRepo(listReviews(), repo);
  if (ambiguous.length > 0) {
    request.log.warn({ repo, reviewIds: ambiguous }, "Pair Pal discovery: multiple walkthroughs in progress for this repo, connecting to none");
  }
  if (!match) return { ok: true, match: null, ambiguous };
  const job = findRunningJobForReview(match.id, "walkthrough");
  return {
    ok: true,
    match: { reviewId: match.id, repo: match.repo, round: match.currentRound, jobId: job?.id ?? null },
    ambiguous,
  };
});

// Cheap and read-only — no 404 for "not connected yet," so the walkthrough
// skill can poll this right after opening the repo folder in VS Code
// without treating every miss as an error to catch.
app.get("/api/vscode/:id/status", async (request, reply) => {
  return { ok: true, ...getVscodeStatus(request.params.id) };
});

app.post("/api/vscode/:id/connect", async (request, reply) => {
  const { repo } = request.body ?? {};
  if (!repo) {
    reply.code(400);
    return { ok: false, error: "repo is required" };
  }
  try {
    const state = connectVscode(request.params.id, repo);
    return { ok: true, connectedAt: state.connectedAt };
  } catch (err) {
    if (err instanceof VscodeRepoMismatchError) {
      reply.code(409);
      return { ok: false, error: err.message };
    }
    if (err instanceof VscodeUnknownReviewError) {
      reply.code(404);
      return { ok: false, error: err.message };
    }
    throw err;
  }
});

// Long poll: Fastify just holds the response open (see vscode.js's
// waitForCommand) until a new move/clear lands or ~25s passes, then the
// extension immediately reissues it — near-instant delivery without a
// websocket.
app.get("/api/vscode/:id/commands", async (request, reply) => {
  try {
    const state = await waitForCommand(request.params.id);
    return { pendingCommand: state.pendingCommand };
  } catch (err) {
    if (err instanceof VscodeNotConnectedError) {
      reply.code(404);
      return { ok: false, error: err.message };
    }
    throw err;
  }
});

// Guarded by cmdId server-side (see ackCommand) so acking a command that's
// already been superseded by a newer move/clear is a no-op, not an error.
app.post("/api/vscode/:id/commands/:cmdId/ack", async (request, reply) => {
  try {
    const state = ackCommand(request.params.id, request.params.cmdId);
    return { ok: true, pendingCommand: state.pendingCommand };
  } catch (err) {
    if (err instanceof VscodeNotConnectedError) {
      reply.code(404);
      return { ok: false, error: err.message };
    }
    throw err;
  }
});

// Replaces the old reveal/highlight verbs — "jump to this element" and
// "point at this block" are the same action. label defaults to the
// session's agent name rather than a generic "Command Center" tag.
app.post("/api/vscode/:id/move", async (request, reply) => {
  const { file, startLine } = request.body ?? {};
  if (!file || !startLine) {
    reply.code(400);
    return { ok: false, error: "file and startLine are required" };
  }
  try {
    const state = moveCommand(request.params.id, {
      ...request.body,
      label: request.body.label || PEARL_NAME,
    });
    return { ok: true, pendingCommand: state.pendingCommand };
  } catch (err) {
    if (err instanceof VscodeNotConnectedError) {
      reply.code(404);
      return { ok: false, error: err.message };
    }
    throw err;
  }
});

// Removes the agent's decorations entirely — called when a round completes
// or a walkthrough job ends, so the presence marker doesn't linger.
app.post("/api/vscode/:id/clear", async (request, reply) => {
  try {
    const state = clearCommand(request.params.id);
    return { ok: true, pendingCommand: state.pendingCommand };
  } catch (err) {
    if (err instanceof VscodeNotConnectedError) {
      reply.code(404);
      return { ok: false, error: err.message };
    }
    throw err;
  }
});

// Opens a real iTerm2 window on this machine, attached to the job's tmux
// session. Only meaningful when the browser and the dashboard server are on
// the same Mac — same trust model as the rest of this app.
app.post("/api/jobs/:id/open-terminal", async (request, reply) => {
  const result = openInIterm(request.params.id);
  if (!result.ok) reply.code(400);
  return result;
});

// Closes a session: kills its tmux session if still live, then drops it
// from the job list entirely.
app.post("/api/jobs/:id/close", async (request, reply) => {
  const job = getJob(request.params.id);
  if (!job) {
    reply.code(404);
    return { ok: false, error: "Unknown job" };
  }
  const result = closeJob(request.params.id);
  if (!result.ok) reply.code(400);
  return result;
});

// Every open GitHub PR you authored or are assigned on, across every repo —
// not just ones tied to a Jira ticket. `gh search prs` hits GitHub directly,
// so this needs no DEV_ROOT or local clone.
app.get("/api/prs", async () => {
  try {
    const authored = searchMyPrs({ role: "author" });
    const assigned = searchMyPrs({ role: "assignee" });

    const byUrl = new Map();
    for (const pr of authored) byUrl.set(pr.url, { pr, roles: ["author"] });
    for (const pr of assigned) {
      const existing = byUrl.get(pr.url);
      if (existing) existing.roles.push("assignee");
      else byUrl.set(pr.url, { pr, roles: ["assignee"] });
    }

    const postedUrls = isAnnounceConfigured() ? loadPostedUrls() : new Set();
    const prs = [...byUrl.values()].map(({ pr, roles }) => ({
      repo: pr.repository?.nameWithOwner || null,
      number: pr.number,
      title: pr.title,
      url: pr.url,
      isDraft: pr.isDraft,
      updatedAt: pr.updatedAt,
      roles,
      isAnnounced: postedUrls.has(pr.url),
    }));

    return { ok: true, prs, announceEnabled: isAnnounceConfigured() };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Posts one PR to the Slack announce workflow, on demand only. Safe to call
// twice: a PR already posted comes back alreadyPosted without a second post.
app.post("/api/prs/announce", async (request, reply) => {
  const { url } = request.body || {};
  if (!isPrUrl(url)) {
    reply.code(400);
    return { ok: false, error: "url must be a GitHub PR URL (https://github.com/owner/repo/pull/N)" };
  }
  if (!isAnnounceConfigured()) {
    reply.code(400);
    return { ok: false, error: "SLACK_WORKFLOW_URL_PR_ANNOUNCE is not set" };
  }

  const pr = viewPr(url);
  if (!pr) {
    reply.code(404);
    return { ok: false, error: `Couldn't load ${url} via gh` };
  }

  try {
    const result = await announcePr(pr);
    request.log.info(`Slack PR announce ${result}: ${url}`);
    return { ok: true, alreadyPosted: result === "already_posted" };
  } catch (err) {
    request.log.error(err, `Slack PR announce failed: ${url}`);
    reply.code(502);
    return { ok: false, error: err.message };
  }
});

// Personal todos: Jira issues carrying TODO_LABEL, distinct from the
// ClaudeWork tickets the Tickets column shows. Same Jira account as
// everything else, so this degrades to "not configured" only when Jira
// itself isn't, rather than needing a second credential.
app.get("/api/todos", async () => {
  if (!getJiraAuth()) {
    return { ok: false, error: "Jira is not configured" };
  }
  try {
    const issues = await searchIssues(
      `labels = "${TODO_LABEL}" AND assignee = currentUser() AND statusCategory != Done`,
      ["summary", "status", "labels", "duedate"],
    );
    const tasks = issues.map((issue) => ({
      key: issue.key,
      summary: issue.fields.summary,
      dueDate: issue.fields.duedate || null,
    }));
    return { ok: true, tasks };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

app.post("/api/todos", async (request, reply) => {
  if (!TODO_PROJECT_KEY) {
    reply.code(400);
    return { ok: false, error: "TODO_PROJECT_KEY is not set. Set it in .env to the Jira project key todos should be created in." };
  }
  const { summary, description, dueDate } = request.body || {};
  if (!summary) {
    reply.code(400);
    return { ok: false, error: "summary is required" };
  }
  if (dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {
    reply.code(400);
    return { ok: false, error: "dueDate must be YYYY-MM-DD" };
  }
  try {
    const assigneeAccountId = await resolveCurrentUserAccountId();
    const issue = await createIssue({
      projectKey: TODO_PROJECT_KEY,
      issueTypeName: TODO_ISSUE_TYPE,
      summary,
      description,
      labels: [TODO_LABEL],
      assigneeAccountId,
      dueDate,
    });
    return { ok: true, task: { key: issue.key, summary, dueDate: dueDate || null } };
  } catch (err) {
    reply.code(400);
    return { ok: false, error: err.message };
  }
});

app.post("/api/todos/:key/complete", async (request, reply) => {
  try {
    await transitionForEvent(request.params.key, "done");
    return { ok: true };
  } catch (err) {
    reply.code(400);
    return { ok: false, error: err.message };
  }
});

// Pearl's memory (see api/lib/pearl-memory.js). The binary is looked up per
// request so installing it doesn't need an API restart; the instance is
// cached per binary so every write shares one queue.
const MEMORY_LIMITS = { query: 500, title: 120, content: 20_000, identifier: 300, results: 25, listPage: 1000, listLimit: 100 };
let memoryInstance = null;

function getMemory() {
  const bin = findMemoryBin();
  if (!bin) return null;
  if (memoryInstance?.bin !== bin) memoryInstance = { bin, memory: createMemory({ bin }) };
  return memoryInstance.memory;
}

function memoryUnavailable(reply) {
  reply.code(503);
  return { ok: false, error: "Pearl's memory isn't installed. Run ./install.sh --memory." };
}

function memoryFailure(request, reply, err) {
  if (err instanceof MemoryExistsError) {
    reply.code(409);
    return { ok: false, error: err.message };
  }
  if (err instanceof MemoryNotFoundError) {
    reply.code(404);
    return { ok: false, error: err.message };
  }
  request.log.error(err, "Pearl memory call failed");
  reply.code(err instanceof MemoryError ? 502 : 500);
  return { ok: false, error: err.message };
}

function isBoundedString(value, max) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max;
}

app.get("/api/memory/search", async (request, reply) => {
  const { q, limit = "5" } = request.query || {};
  if (!isBoundedString(q, MEMORY_LIMITS.query)) {
    reply.code(400);
    return { ok: false, error: `q is required (at most ${MEMORY_LIMITS.query} characters)` };
  }
  const count = Number.parseInt(limit, 10);
  if (!Number.isInteger(count) || count < 1 || count > MEMORY_LIMITS.results) {
    reply.code(400);
    return { ok: false, error: `limit must be between 1 and ${MEMORY_LIMITS.results}` };
  }

  const memory = getMemory();
  if (!memory) return memoryUnavailable(reply);
  try {
    return { ok: true, results: await memory.search({ query: q, limit: count }) };
  } catch (err) {
    return memoryFailure(request, reply, err);
  }
});

app.get("/api/memory/note", async (request, reply) => {
  const { id } = request.query || {};
  if (!isBoundedString(id, MEMORY_LIMITS.identifier)) {
    reply.code(400);
    return { ok: false, error: "id is required — a permalink from search results" };
  }

  const memory = getMemory();
  if (!memory) return memoryUnavailable(reply);
  try {
    return { ok: true, note: await memory.read({ identifier: id }) };
  } catch (err) {
    return memoryFailure(request, reply, err);
  }
});

app.post("/api/memory", async (request, reply) => {
  const { title, content, overwrite = false } = request.body || {};
  if (!isBoundedString(title, MEMORY_LIMITS.title)) {
    reply.code(400);
    return { ok: false, error: `title is required (at most ${MEMORY_LIMITS.title} characters)` };
  }
  if (!isBoundedString(content, MEMORY_LIMITS.content)) {
    reply.code(400);
    return { ok: false, error: `content is required (at most ${MEMORY_LIMITS.content} characters)` };
  }
  if (typeof overwrite !== "boolean") {
    reply.code(400);
    return { ok: false, error: "overwrite must be true or false" };
  }

  const memory = getMemory();
  if (!memory) return memoryUnavailable(reply);
  try {
    return { ok: true, ...(await memory.write({ title, content, overwrite })) };
  } catch (err) {
    return memoryFailure(request, reply, err);
  }
});

app.get("/api/memory/notes", async (request, reply) => {
  const { page = "1", limit = "20" } = request.query || {};
  const pageNum = Number.parseInt(page, 10);
  if (!Number.isInteger(pageNum) || pageNum < 1 || pageNum > MEMORY_LIMITS.listPage) {
    reply.code(400);
    return { ok: false, error: `page must be between 1 and ${MEMORY_LIMITS.listPage}` };
  }
  const limitNum = Number.parseInt(limit, 10);
  if (!Number.isInteger(limitNum) || limitNum < 1 || limitNum > MEMORY_LIMITS.listLimit) {
    reply.code(400);
    return { ok: false, error: `limit must be between 1 and ${MEMORY_LIMITS.listLimit}` };
  }

  const memory = getMemory();
  if (!memory) return memoryUnavailable(reply);
  try {
    return { ok: true, ...(await memory.list({ page: pageNum, limit: limitNum })) };
  } catch (err) {
    return memoryFailure(request, reply, err);
  }
});

app.put("/api/memory/note", async (request, reply) => {
  const { id } = request.query || {};
  if (!isBoundedString(id, MEMORY_LIMITS.identifier)) {
    reply.code(400);
    return { ok: false, error: "id is required — a permalink from search results" };
  }
  const { content } = request.body || {};
  if (!isBoundedString(content, MEMORY_LIMITS.content)) {
    reply.code(400);
    return { ok: false, error: `content is required (at most ${MEMORY_LIMITS.content} characters)` };
  }

  const memory = getMemory();
  if (!memory) return memoryUnavailable(reply);
  try {
    return { ok: true, ...(await memory.update({ identifier: id, content })) };
  } catch (err) {
    return memoryFailure(request, reply, err);
  }
});

app.delete("/api/memory/note", async (request, reply) => {
  const { id } = request.query || {};
  if (!isBoundedString(id, MEMORY_LIMITS.identifier)) {
    reply.code(400);
    return { ok: false, error: "id is required — a permalink from search results" };
  }

  const memory = getMemory();
  if (!memory) return memoryUnavailable(reply);
  try {
    return { ok: true, ...(await memory.remove({ identifier: id })) };
  } catch (err) {
    return memoryFailure(request, reply, err);
  }
});

// Dispatch a free-form agent, scoped to whatever is focused (a ticket, or
// nothing). Gated the same way as the rest of the dashboard's write actions.
app.post("/api/dispatch", async (request, reply) => {
  const { prompt, context, mode } = request.body || {};
  if (!prompt) {
    reply.code(400);
    return { ok: false, error: "prompt is required" };
  }
  if (mode && mode !== "headless" && mode !== "interactive") {
    reply.code(400);
    return { ok: false, error: 'mode must be "headless" or "interactive"' };
  }

  const type = context?.type || "none";
  let cwd = DEV_ROOT;
  let ticketKey = null;
  let composedPrompt = prompt;
  // A session card has no expand/log view, so this is the only thing that
  // identifies it at a glance — a ticket's own summary, or (for a general
  // dispatch) the first line of what was actually asked for.
  let title = prompt.split("\n")[0].slice(0, 70);

  if (type === "ticket") {
    const key = context?.key;
    let detail;
    try {
      detail = await getTicketDetail(key);
    } catch (err) {
      reply.code(400);
      return { ok: false, error: `Unknown ticket ${key}: ${err.message}` };
    }

    // Parent labels aren't on `detail` (getTicketDetail only keeps
    // key/summary for `stack`), so a subtask whose repo lives on its parent
    // needs a second fetch here, kept out of resolveRepoRoot itself.
    let parentLabels = [];
    if (detail.stack) {
      const parent = await getIssue(detail.stack.key);
      parentLabels = parent.fields?.labels || [];
    }

    const { root, name, source } = resolveRepoRoot(DEV_ROOT, {
      labels: detail.labels,
      parentLabels,
      description: detail.description,
    });

    let repoNote = null;
    if (name && !root) {
      reply.code(400);
      return { ok: false, error: repoNotFoundError(name, source, DEV_ROOT) };
    }
    if (!name) {
      repoNote = "Repo could not be determined from labels or description — running in DEV_ROOT.";
    }

    ticketKey = key;
    cwd = root || DEV_ROOT;
    title = `${key} — ${detail.summary}`.slice(0, 70);
    const jiraLink = JIRA_DOMAIN ? `https://${JIRA_DOMAIN}/browse/${key}` : key;
    // The whole thing a human would see expanding this ticket in
    // TicketDetail — not a thinner hand-picked subset.
    const header = [
      `Context: ${key} — ${detail.summary}`,
      `Status: ${detail.status}`,
      detail.stack ? `Parent: ${detail.stack.key} — ${detail.stack.summary}` : null,
      detail.labels.length ? `Labels: ${detail.labels.join(", ")}` : null,
      detail.blockedBy.length ? `Blocked by: ${detail.blockedBy.join(", ")}` : null,
      detail.blocks.length ? `Blocks: ${detail.blocks.join(", ")}` : null,
      detail.dueDate ? `Due: ${detail.dueDate}` : null,
      `Jira: ${jiraLink}`,
      repoNote,
      detail.description ? `\nDescription:\n${detail.description}` : null,
    ]
      .filter(Boolean)
      .join("\n");
    composedPrompt = `${header}\n\n${prompt}`;
  }

  let reviewId = null;
  let reviewRole = null;
  if (type === "review") {
    const role = context?.role ?? "changes";
    if (!REVIEW_ROLES.includes(role)) {
      reply.code(400);
      return { ok: false, error: `context.role must be one of ${REVIEW_ROLES.join(", ")}` };
    }
    const session = getSession(context?.id);
    if (!session) {
      reply.code(400);
      return { ok: false, error: `Unknown review ${context?.id}` };
    }
    // The one place a walkthrough job's dispatch actually happens — moves
    // the review out of ROUND_READY so the round this job is about to walk
    // is recorded as in progress, not just computed. See the "State
    // machine" section of .plans/interactive-review-loop.md: this is what
    // replaces "session.status flips to walkthrough the instant a round's
    // diff exists" with an explicit event tied to a job actually starting.
    if (role === "walkthrough") {
      const dispatched = dispatchWalkthrough(session.id);
      if (!dispatched.ok) {
        reply.code(400);
        return { ok: false, error: dispatched.error };
      }
    }
    reviewId = session.id;
    reviewRole = role;
    cwd = session.repo;
    title = `Review ${role === "walkthrough" ? "walkthrough" : "changes"}: round ${session.currentRound}`;
    const header = [
      `Context: review ${session.id}, round ${session.currentRound} (${role})`,
      `Repo: ${session.repo}`,
      `Base branch: ${session.baseBranch} (feature starts at ${session.rootBaseSha})`,
      session.prUrl ? `PR: ${session.prUrl}` : null,
    ]
      .filter(Boolean)
      .join("\n");
    composedPrompt = `${header}\n\n${prompt}`;
  }

  // Every dispatched agent sizes its own model before touching the actual
  // task — /automodel reads the context right below it (a ticket's
  // complexity label/description, or lack of ticket context at all) and
  // switches to whichever of haiku/sonnet/opus actually fits, rather than
  // every dispatch defaulting to one model regardless of scope.
  composedPrompt = `/automodel\n\n${composedPrompt}`;

  // Pushes completion back to Pearl instead of leaving her to poll
  // /api/jobs — she's named (see pearl.js) so SendMessage can reach her
  // directly. Only covers a job that can still run its own final turn; one
  // wedged on a permission dialog can't execute this instruction either.
  // The instruction itself stays inline so it holds even if /cc-report never
  // loads; the skill only covers how to word the report.
  composedPrompt = `${composedPrompt}\n\n---\n\nWhen you finish — done, failed, or stopping because you're blocked — send ${PEARL_NAME} a brief status via the SendMessage tool: one or two sentences on what happened and whether anything needs human attention. Don't wait for a reply. /cc-report covers what to include.`;

  if (!cwd) {
    reply.code(400);
    return { ok: false, error: "DEV_ROOT is not configured" };
  }

  if (ticketKey) {
    const existing = findRunningJobForTicket(ticketKey);
    if (existing) {
      reply.code(409);
      return {
        ok: false,
        error: `A command is already running for ${ticketKey}`,
        jobId: existing.id,
      };
    }
  }

  if (reviewId) {
    const existing = findRunningJobForReview(reviewId, reviewRole);
    if (existing) {
      reply.code(409);
      return { ok: false, error: `A ${reviewRole} job is already running for review ${reviewId}`, jobId: existing.id };
    }
  }

  // Every dispatched agent gets a brain dir and permission to write to it —
  // the agent decides for itself whether to actually use it (see
  // brainInstructions), not a human at dispatch time. The id has to be
  // generated here, ahead of startCommandJob, because the brain dir's path
  // has to be baked into both composedPrompt (so the agent knows where to
  // write) and the claude invocation's --add-dir (so it's allowed to)
  // before the job/tmux session exists.
  const jobId = randomUUID();
  const brainDir = ensureBrainDir(jobId);
  composedPrompt = `${composedPrompt}\n\n${brainInstructions(canvasPathFor(jobId))}`;
  // Same unconditional, agent-decides posture as Brain View above — every
  // dispatched job gets the option, keyed by its own jobId.
  composedPrompt = `${composedPrompt}\n\n${voiceInstructions(jobId, `http://localhost:${PORT}`)}`;
  // A review change job opens its own terminal when it needs Jay's call on a
  // comment (see /cc-review-changes), so it has to know its own job id.
  if (reviewId) composedPrompt = `${composedPrompt}\n\nYour Command Center job id is ${jobId}.`;
  const extraArgs = `--add-dir '${brainDir}'`;

  const job = startCommandJob({
    id: jobId,
    ticketKey,
    reviewId,
    reviewRole,
    title,
    prompt: composedPrompt,
    cwd,
    now: new Date().toISOString(),
    mode: mode || "headless",
    extraArgs,
  });

  return { ok: true, job: serializeJob(job) };
});

// Interactive review loop, Phase 0 (see .plans/interactive-review-loop.md):
// starting a review, reading a round, leaving comments, confirming
// checklist items, and closing a round's comment-leaving phase. No change
// agent yet — that's Phase 1.
app.get("/api/review", async () => ({ ok: true, reviews: listReviews() }));

app.post("/api/review/start", async (request, reply) => {
  const { repo, baseBranch, prUrl } = request.body || {};
  if (!repo || typeof repo !== "string") {
    reply.code(400);
    return { ok: false, error: "repo is required" };
  }
  if (!baseBranch || typeof baseBranch !== "string") {
    reply.code(400);
    return { ok: false, error: "baseBranch is required" };
  }
  try {
    const { id, round } = startReview({ repo, baseBranch, prUrl: prUrl || null });
    return { ok: true, id, round };
  } catch (err) {
    reply.code(400);
    return { ok: false, error: err.message };
  }
});

app.get("/api/review/:id", async (request, reply) => {
  const session = getSession(request.params.id);
  if (!session) {
    reply.code(404);
    return { ok: false, error: "Unknown review" };
  }
  const round = getRound(request.params.id, session.currentRound);
  const comments = listComments(request.params.id, { round: session.currentRound });
  return {
    ok: true,
    session,
    round: round
      ? {
          round: round.round,
          chunkCount: round.chunks.length,
          checklistTotal: round.chunks.flatMap((c) => c.checklist).length,
          checklistConfirmed: round.chunks.flatMap((c) => c.checklist).filter((k) => k.status === "confirmed").length,
          openComments: comments.filter((c) => c.status === "open").length,
        }
      : null,
  };
});

app.get("/api/review/:id/round/:n", async (request, reply) => {
  const round = getRound(request.params.id, Number.parseInt(request.params.n, 10));
  if (!round) {
    reply.code(404);
    return { ok: false, error: "Unknown round" };
  }
  const comments = listComments(request.params.id, { round: round.round });
  return { ok: true, round, comments };
});

app.post("/api/review/:id/round/:n/comments", async (request, reply) => {
  const round = Number.parseInt(request.params.n, 10);
  const { chunkId, file, line, text } = request.body || {};
  if (!text || typeof text !== "string" || !text.trim()) {
    reply.code(400);
    return { ok: false, error: "text is required" };
  }
  try {
    const comment = addComment(request.params.id, round, { chunkId, file, line, text });
    if (!comment) {
      reply.code(404);
      return { ok: false, error: "Unknown review or round" };
    }
    return { ok: true, comment };
  } catch (err) {
    reply.code(400);
    return { ok: false, error: err.message };
  }
});

app.post("/api/review/:id/round/:n/checklist/:k/confirm", async (request, reply) => {
  const round = Number.parseInt(request.params.n, 10);
  try {
    const updated = confirmChecklistItem(request.params.id, round, request.params.k);
    if (!updated) {
      reply.code(404);
      return { ok: false, error: "Unknown review, round, or checklist item" };
    }
    return { ok: true, round: updated };
  } catch (err) {
    reply.code(400);
    return { ok: false, error: err.message };
  }
});

// Replaces the round's walk order. Validation (every chunk in exactly one
// group) lives in review.js; a rejection comes back with missing /
// duplicates / unknown chunk ids so the agent can fix its proposal.
app.put("/api/review/:id/round/:n/groups", async (request, reply) => {
  const round = Number.parseInt(request.params.n, 10);
  const { groups } = request.body || {};
  const result = setRoundGroups(request.params.id, round, groups);
  if (!result.ok) reply.code(result.notFound ? 404 : 400);
  return result;
});

app.post("/api/review/:id/comments/:commentId/resolution", async (request, reply) => {
  const { status, note, files } = request.body || {};
  const result = resolveComment(request.params.id, request.params.commentId, { status, note, files });
  if (!result.ok) reply.code(result.notFound ? 404 : 400);
  return result;
});

// Called by the change job once its round commit exists. Safe to call
// twice: a round that already exists comes back unchanged.
app.post("/api/review/:id/round/:n/next", async (request, reply) => {
  const round = Number.parseInt(request.params.n, 10);
  try {
    const result = nextRound(request.params.id, round);
    if (!result.ok) reply.code(result.notFound ? 404 : 400);
    return result;
  } catch (err) {
    request.log.error(err, `Review ${request.params.id}: computing round ${round + 1} failed`);
    reply.code(500);
    return { ok: false, error: err.message };
  }
});

app.post("/api/review/:id/round/:n/complete", async (request, reply) => {
  const round = Number.parseInt(request.params.n, 10);
  const { force } = request.body || {};
  const result = completeRound(request.params.id, round, { force: Boolean(force) });
  if (!result.ok) reply.code(400);
  return result;
});

// Drops a review without shipping it. Legal from any non-terminal state;
// an already-approved or already-abandoned review refuses (400) rather
// than silently re-abandoning.
app.post("/api/review/:id/abandon", async (request, reply) => {
  const result = abandonReview(request.params.id);
  if (!result.ok) reply.code(result.notFound ? 404 : 400);
  return result;
});

// Generic voice (see api/voice.js) — any agent, keyed by any id it
// chooses (a reviewId, a jobId, anything), not tied to review.js or
// run-command.js's own registries. Validated here rather than left to
// voice.js, since server.js is the only place an id ever arrives as
// untrusted route-param text rather than a server-generated UUID.
app.post("/api/voice/:id/speak", async (request, reply) => {
  if (!isValidVoiceId(request.params.id)) {
    reply.code(400);
    return { ok: false, error: "id must match [A-Za-z0-9_-]{1,128}" };
  }
  const { text } = request.body || {};
  if (!text || typeof text !== "string" || !text.trim()) {
    reply.code(400);
    return { ok: false, error: "text is required" };
  }
  const result = speakVoice(request.params.id, text);
  if (!result.ok) reply.code(400);
  return result;
});

app.post("/api/voice/:id/hush", async (request, reply) => {
  if (!isValidVoiceId(request.params.id)) {
    reply.code(400);
    return { ok: false, error: "id must match [A-Za-z0-9_-]{1,128}" };
  }
  const result = hushVoice(request.params.id);
  if (!result.ok) reply.code(400);
  return result;
});

// Pearl: ensures her persistent session exists (spawning it, briefed, on
// first call) and opens a real iTerm2 window attached to it. No chat UI —
// the human drives her directly in the terminal from here on.
app.post("/api/pearl/open", async (request, reply) => {
  const result = openPearl({
    cwd: REPO_ROOT,
    repoRoot: REPO_ROOT,
    apiBase: `http://localhost:${PORT}`,
  });
  if (!result.ok) reply.code(400);
  return result;
});

// Restarts Pearl's session so edits to SOUL.md or the briefing in pearl.js
// actually reach her — otherwise they sit unused until someone kills her
// tmux session by hand. Confirmation that this discards her current
// conversation happens in the UI; this route just does the kill-then-spawn.
app.post("/api/pearl/refresh", async (request, reply) => {
  const result = refreshPearl({
    cwd: REPO_ROOT,
    repoRoot: REPO_ROOT,
    apiBase: `http://localhost:${PORT}`,
  });
  if (!result.ok) reply.code(400);
  return result;
});

// SOUL.md: who Pearl is and how the user wants her to work, read fresh on every
// spin-up. Editable here instead of only by hand, so it stays a thing you'd
// actually keep up to date.
app.get("/api/pearl/soul", async () => ({
  ok: true,
  content: readSoul(REPO_ROOT),
}));

app.post("/api/pearl/soul", async (request, reply) => {
  const { content } = request.body || {};
  if (typeof content !== "string") {
    reply.code(400);
    return { ok: false, error: "content must be a string" };
  }
  writeSoul(REPO_ROOT, content);
  return { ok: true };
});

// Overridable so a second instance can run alongside the usual one — useful for
// trying a change without stopping the dashboard you're working from.
const PORT = Number.parseInt(process.env.DASHBOARD_PORT || "3789", 10);

app.listen({ port: PORT }, (err) => {
  if (!err) return;

  // Called out by name rather than left as a pino JSON blob. `npm run dev` runs
  // the API and Vite under `concurrently`, so when an older server already holds
  // the port this process dies while the UI keeps serving — and the browser then
  // talks to the stale server, whose routes are whatever that build had. That
  // surfaces as a bare 404 on newer endpoints, which reads like a missing route
  // rather than a server that needs restarting.
  if (err.code === "EADDRINUSE") {
    console.error(
      [
        `Port ${PORT} is already in use — another dashboard server is running.`,
        "",
        "The browser will keep talking to that older server, so new endpoints",
        "will 404 until it's replaced. Find and stop it:",
        "",
        `  lsof -nP -iTCP:${PORT} -sTCP:LISTEN`,
        `  kill <pid>`,
        "",
        `Or run alongside it: DASHBOARD_PORT=${PORT + 1} npm run dev:api`,
      ].join("\n"),
    );
    process.exit(1);
  }

  app.log.error(err);
  process.exit(1);
});
