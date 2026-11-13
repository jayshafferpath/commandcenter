// Pair Pal's server side: the agent's presence in Jay's editor, backed by
// one state file per review/walkthrough session, parallel to how brain.js
// backs one canvas per job.
//
//   ~/.commandcenter/review/<id>/vscode.json
//
// Phase A only (see .plans/vscode-walkthrough-bridge.md): connect, move,
// clear, ack, the long-poll command loop, and walkthrough discovery. jayState/commentsVersion are
// Phase B/C fields with no writer yet, so this file doesn't carry them —
// adding empty placeholders now would just be dead shape to maintain.
//
// The id is a review id (same ~/.commandcenter/review/<id>/ directory
// review.js already owns); connectVscode hard-rejects a workspace that
// doesn't match that review's own repo, per the plan's Multi-window and
// wrong-workspace handling section.

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { STATES } from "./lib/review-fsm.js";
import { getSession } from "./review.js";

const COMMAND_LONG_POLL_TIMEOUT_MS = 25_000;

// A function, not a module-level constant, so tests can mock os.homedir()
// and have it take effect — see brain.js for the same reasoning.
function vscodeRoot() {
  return join(homedir(), ".commandcenter", "review");
}

export function vscodeDirFor(id) {
  return join(vscodeRoot(), id);
}

export function vscodeStatePathFor(id) {
  return join(vscodeDirFor(id), "vscode.json");
}

export class VscodeNotConnectedError extends Error {}
export class VscodeRepoMismatchError extends Error {}
export class VscodeUnknownReviewError extends Error {}

function readState(id) {
  const path = vscodeStatePathFor(id);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf-8"));
}

// Waiters woken by every write so a long-poll GET resolves the instant a
// command lands instead of sitting out the full timeout. Keyed by id since
// multiple reviews could be connected at once.
const waiters = new Map();

function notifyWaiters(id, state) {
  const set = waiters.get(id);
  if (!set || set.size === 0) return;
  for (const resolve of set) resolve(state);
  set.clear();
}

function writeState(id, state) {
  mkdirSync(vscodeDirFor(id), { recursive: true });
  writeFileSync(vscodeStatePathFor(id), JSON.stringify(state, null, 2), "utf-8");
  notifyWaiters(id, state);
  return state;
}

function requireConnected(id) {
  const state = readState(id);
  if (!state) throw new VscodeNotConnectedError(`No Pair Pal connection for review ${id}`);
  return state;
}

export function getVscodeState(id) {
  return readState(id);
}

// Discovery and connect must agree on what "the same repo" means, or the
// extension could discover a review it then can't connect to. resolve()
// only absorbs a trailing slash or `..` segment — no realpath, since a
// symlinked checkout is a different workspace as far as VS Code is
// concerned too.
export function isSameRepoPath(a, b) {
  if (!a || !b) return false;
  return resolve(a) === resolve(b);
}

// How Pair Pal finds its review without anyone setting
// commandCenter.sessionId by hand — and without writing anything into the
// reviewed repo's working tree (a .vscode/settings.json there would dirty
// it, and ADVANCE_ROUND refuses a dirty tree). Pure over the review list so
// it's testable without the filesystem; server.js supplies listReviews().
// More than one in-progress walkthrough for the same repo returns no match
// rather than a guess: connecting to the wrong review would show one
// agent's presence in a conversation with another.
export function matchWalkthroughForRepo(reviews, repo) {
  const matches = reviews.filter(
    (review) => review.state === STATES.WALKTHROUGH_IN_PROGRESS && isSameRepoPath(review.repo, repo),
  );
  if (matches.length === 1) return { match: matches[0], ambiguous: [] };
  return { match: null, ambiguous: matches.length > 1 ? matches.map((review) => review.id) : [] };
}

// Last-connect-wins, same as every other multi-window case this plan
// accepts (see Multi-window handling) — a second `connect` for the same id
// simply replaces the first, it doesn't error. Hard-rejects (not a silent
// no-op) a workspace that doesn't match the review's own repo, and refuses
// to connect at all for an id with no review session — Pair Pal is always
// a second participant in a review that already exists, never the thing
// that creates one.
export function connectVscode(id, repo) {
  const session = getSession(id);
  if (!session) {
    throw new VscodeUnknownReviewError(`No review session ${id} — start one before connecting Pair Pal`);
  }
  if (!isSameRepoPath(repo, session.repo)) {
    throw new VscodeRepoMismatchError(
      `Workspace "${repo}" does not match this review's repo "${session.repo}"`,
    );
  }
  const now = new Date().toISOString();
  return writeState(id, { repo, connectedAt: now, lastSeenAt: now, pendingCommand: null });
}

// The single verb covering both "jump to this element" and "point at this
// block" — see Pointing in the plan. `reveal` defaults to true: most calls
// are "go look at this," and the extension's Follow Agent toggle decides
// client-side whether that actually scrolls Jay's viewport.
export function moveCommand(
  id,
  { file, startLine, startCol, endLine, endCol, label, reveal },
) {
  const state = requireConnected(id);
  const pendingCommand = {
    id: `cmd_${randomUUID()}`,
    type: "move",
    file,
    startLine,
    startCol: startCol ?? 1,
    endLine: endLine ?? startLine,
    endCol: endCol ?? 1,
    label,
    reveal: reveal ?? true,
    createdAt: new Date().toISOString(),
  };
  state.pendingCommand = pendingCommand;
  state.lastSeenAt = pendingCommand.createdAt;
  return writeState(id, state);
}

// Removes the agent's decorations entirely (round/job ended). No TTL on
// either move or clear — a pointer is exactly as persistent as "the agent
// is currently looking at this," which `clear` or the next `move` both end.
export function clearCommand(id) {
  const state = requireConnected(id);
  const pendingCommand = { id: `cmd_${randomUUID()}`, type: "clear", createdAt: new Date().toISOString() };
  state.pendingCommand = pendingCommand;
  state.lastSeenAt = pendingCommand.createdAt;
  return writeState(id, state);
}

// Guarded by cmdId so a late ack for a command that's already been
// superseded by a newer `move`/`clear` can't wipe that newer one out.
export function ackCommand(id, cmdId) {
  const state = requireConnected(id);
  if (state.pendingCommand?.id === cmdId) {
    state.pendingCommand = null;
    return writeState(id, state);
  }
  return state;
}

// Resolves immediately if a command is already pending (the extension just
// reconnected, or missed one), otherwise blocks until the next write or
// timeoutMs elapses — Fastify just holds the HTTP response open across the
// await, no socket of its own to manage. Tests override timeoutMs instead
// of waiting out the real ~25s.
export async function waitForCommand(id, { timeoutMs = COMMAND_LONG_POLL_TIMEOUT_MS } = {}) {
  const state = requireConnected(id);
  if (state.pendingCommand) return state;

  return new Promise((resolve) => {
    let set = waiters.get(id);
    if (!set) {
      set = new Set();
      waiters.set(id, set);
    }
    const onCommand = (nextState) => {
      clearTimeout(timer);
      resolve(nextState);
    };
    const timer = setTimeout(() => {
      set.delete(onCommand);
      resolve(readState(id) ?? state);
    }, timeoutMs);
    set.add(onCommand);
  });
}
