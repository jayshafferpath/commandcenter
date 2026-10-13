import { loadEnv } from "./lib/env.js";
loadEnv();

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
import { searchMyPrs } from "./lib/pr.js";
import { adfToPlainText } from "./lib/adf.js";
import { isExecutionEnabled } from "./lib/dashboard-actions.js";
import {
  closeJob,
  findRunningJobForTicket,
  getJob,
  listJobs,
  openInIterm,
  serializeJob,
  startCommandJob,
} from "./run-command.js";
import { openPearl, PEARL_NAME, readSoul, refreshPearl, writeSoul } from "./pearl.js";
import { repoNotFoundError, resolveRepoRoot } from "./lib/util.js";
import { loadDevRoot, getJiraAuth } from "./lib/config.js";

// Personal todos are Jira issues too — a different label, not a different
// system. Kept configurable rather than hardcoded since the project/label
// are deployment-specific, same spirit as JIRA_DOMAIN etc.
const TODO_PROJECT_KEY = process.env.TODO_PROJECT_KEY || "JT";
const TODO_ISSUE_TYPE = process.env.TODO_ISSUE_TYPE || "Task";
const TODO_LABEL = process.env.TODO_LABEL || "Todo";

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
    actionsEnabled: isExecutionEnabled(),
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
  actionsEnabled: isExecutionEnabled(),
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

// Opens a real iTerm2 window on this machine, attached to the job's tmux
// session. Only meaningful when the browser and the dashboard server are on
// the same Mac — same trust model as the rest of this app.
app.post("/api/jobs/:id/open-terminal", async (request, reply) => {
  const result = openInIterm(request.params.id);
  if (!result.ok) reply.code(400);
  return result;
});

// Closes a session: kills its tmux session if still live, then drops it
// from the job list entirely. Gated the same as dispatch when there's an
// actual live agent to kill; dismissing an already-finished card needs no
// such gate — it's not an action against anything, just tidying the list.
app.post("/api/jobs/:id/close", async (request, reply) => {
  const job = getJob(request.params.id);
  if (!job) {
    reply.code(404);
    return { ok: false, error: "Unknown job" };
  }
  const isLive = job.status === "running" || job.status === "needs_input";
  if (isLive && !isExecutionEnabled()) {
    reply.code(400);
    return {
      ok: false,
      error: "Closing a running session requires DASHBOARD_ALLOW_ACTIONS=true",
    };
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

    const prs = [...byUrl.values()].map(({ pr, roles }) => ({
      repo: pr.repository?.nameWithOwner || null,
      number: pr.number,
      title: pr.title,
      url: pr.url,
      isDraft: pr.isDraft,
      updatedAt: pr.updatedAt,
      roles,
    }));

    return { ok: true, prs };
  } catch (err) {
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

  if (!isExecutionEnabled()) {
    reply.code(400);
    return {
      ok: false,
      error: "Dispatch is disabled. Set DASHBOARD_ALLOW_ACTIONS=true to enable it.",
    };
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

  // Every dispatched agent sizes its own model before touching the actual
  // task — /automodel reads the context right below it (a ticket's
  // complexity label/description, or lack of ticket context at all) and
  // switches to whichever of haiku/sonnet/opus actually fits, rather than
  // every dispatch defaulting to one model regardless of scope.
  composedPrompt = `/automodel\n\n${composedPrompt}`;

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

  const job = startCommandJob({
    ticketKey,
    title,
    prompt: composedPrompt,
    cwd,
    now: new Date().toISOString(),
    mode: mode || "headless",
  });

  return { ok: true, job: serializeJob(job) };
});

// Pearl: ensures her persistent session exists (spawning it, briefed, on
// first call) and opens a real iTerm2 window attached to it. No chat UI —
// the human drives her directly in the terminal from here on.
app.post("/api/pearl/open", async (request, reply) => {
  if (!isExecutionEnabled()) {
    reply.code(400);
    return {
      ok: false,
      error: "Pearl is disabled. Set DASHBOARD_ALLOW_ACTIONS=true to enable it.",
    };
  }

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
  if (!isExecutionEnabled()) {
    reply.code(400);
    return {
      ok: false,
      error: `${PEARL_NAME} is disabled. Set DASHBOARD_ALLOW_ACTIONS=true to enable it.`,
    };
  }

  const result = refreshPearl({
    cwd: REPO_ROOT,
    repoRoot: REPO_ROOT,
    apiBase: `http://localhost:${PORT}`,
  });
  if (!result.ok) reply.code(400);
  return result;
});

// SOUL.md: who Pearl is and how Jay wants her to work, read fresh on every
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
