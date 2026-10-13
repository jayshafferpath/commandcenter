// Pearl (name configurable via PEARL_NAME): a persistent, singleton
// supervisor session. One tmux session running interactive `claude`,
// created once and reused forever after — the dashboard's only job is to
// make sure she exists and
// to open a real terminal into her, not to drive her session. An
// earlier version tried to script her via `tmux send-keys`, which broke the
// moment a freshly-launched `claude` landed on a task-overview screen
// instead of a bare chat prompt — there is no reliable way to blindly type
// into a TUI without knowing what screen it's showing. The human drives her
// directly once the terminal is open, same as any other interactive Claude
// Code session.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { openSessionInIterm } from "./run-command.js";

// Configurable so the supervisor isn't stuck with the name "Pearl" on
// someone else's install — her tmux session is named off the same value so
// renaming doesn't collide with (or orphan) a session created under the old
// name.
export const PEARL_NAME = process.env.PEARL_NAME?.trim() || "Pearl";

const SESSION = `ccenter-${
  PEARL_NAME.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "pearl"
}`;

export const SOUL_FILENAME = "SOUL.md";

export function soulPath(repoRoot) {
  return resolve(repoRoot, SOUL_FILENAME);
}

// Who Pearl is and how Jay wants her to work — editable from the dashboard's
// Pearl tab, read fresh on every spin-up, kept separate from the mechanical
// API/repo briefing below so personality/preferences don't require touching
// this file to change.
export function readSoul(repoRoot) {
  const path = soulPath(repoRoot);
  if (!existsSync(path)) return "";
  return readFileSync(path, "utf-8");
}

export function writeSoul(repoRoot, content) {
  writeFileSync(soulPath(repoRoot), content, "utf-8");
}

function sessionExists() {
  try {
    execFileSync("tmux", ["has-session", "-t", SESSION], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function briefing({ apiBase, repoRoot }) {
  const technical = [
    `You are ${PEARL_NAME}, the supervisor agent for the Command Center dashboard.`,
    `Command Center's REST API is at ${apiBase}.`,
    "Key endpoints: GET /api/tickets (tickets, with each ticket's current classification), GET /api/todos, POST /api/todos ({summary, description, dueDate}), POST /api/todos/:key/complete, GET /api/jobs and GET /api/jobs/:id (agent sessions), POST /api/dispatch ({prompt, context:{type:'ticket'|'none', key}}) to start a new agent.",
    `You also have this repo checked out at ${repoRoot}, with api/lib/jira.js exporting searchIssues/getIssue/editIssue/addLabel/removeLabel/transitionForEvent/createIssue/getCurrentUser — use those (via a short node -e snippet) for anything the REST API doesn't cover: editing a ticket's summary, labels, status, or due date directly.`,
  ].join(" ");

  const soul = readSoul(repoRoot).trim();
  return soul ? `${soul}\n\n---\n\n${technical}` : technical;
}

// Passed as the initial prompt argument rather than typed in afterward via
// send-keys: `claude <prompt>` starts interactive mode already processing
// that first message, then stays open for the human's own follow-up —
// no race with whatever screen the CLI happens to boot into.
function ensureSession({ cwd, apiBase, repoRoot }) {
  if (sessionExists()) return false;

  execFileSync("tmux", [
    "new-session",
    "-d",
    "-s",
    SESSION,
    "-c",
    cwd,
    "claude",
    briefing({ apiBase, repoRoot }),
    // Pearl is pinned to Opus, not /automodel — she's a standing supervisor,
    // not a scoped one-shot task /automodel's heuristics are sized for.
    "--model",
    "claude-opus-5-5",
    "--permission-mode",
    "auto",
  ]);
  execFileSync("tmux", ["set-option", "-t", SESSION, "remain-on-exit", "on"]);

  return true;
}

export function openPearl({ cwd, apiBase, repoRoot }) {
  const spawned = ensureSession({ cwd, apiBase, repoRoot });
  const result = openSessionInIterm(SESSION);
  return { ...result, spawned };
}

export const __test__ = { SESSION, briefing };
