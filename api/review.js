// Phase 0 of the interactive review loop (see
// .plans/interactive-review-loop.md): round state lives on disk under
// ~/.commandcenter/review/<id>/, the same shape as Brain View's per-job
// canvas dir. This phase covers starting a review, reading a round, leaving
// comments, confirming checklist items, and closing a round's
// comment-leaving phase — no change agent yet (Phase 1).

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  EVENTS,
  GuardFailedError,
  IllegalTransitionError,
  migrateLegacySession,
  NONE,
  STATES,
  transition,
} from "./lib/review-fsm.js";

// Generic, diff-content-blind checklist — Phase 0 proves the loop's
// mechanics before investing in smarter, per-chunk checklist generation
// (open question #3 in the design doc).
const GENERIC_CHECKLIST = [
  "Read the full change in this file",
  "Confirm it does what it's supposed to",
  "Check for missed edge cases or tests",
];

// A function, not a module-level constant, so tests can mock os.homedir()
// the same way brain.js's brainRoot() does.
function reviewRoot() {
  return join(homedir(), ".commandcenter", "review");
}

export function reviewDirFor(id) {
  return join(reviewRoot(), id);
}

function sessionPathFor(id) {
  return join(reviewDirFor(id), "session.json");
}

function roundPathFor(id, round) {
  return join(reviewDirFor(id), "rounds", `${round}.json`);
}

function commentsPathFor(id) {
  return join(reviewDirFor(id), "comments.jsonl");
}

function readJson(path) {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf-8"));
}

function writeJson(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2), "utf-8");
}

function git(repoRoot, args) {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf-8" }).trim();
}

// Effect tag -> the structured notice a caller (an API route, then the
// cc-review-* skill that called it) relays to Pearl. Kept here, not in
// review-fsm.js, since the FSM only knows the tag — building the actual
// message needs session/round data the pure transition function never
// sees.
function describeEffect(tag, session, round) {
  switch (tag) {
    case "notify_pearl_round_ready":
      return {
        type: tag,
        message: `Review ${session.id} round ${round} is ready to walk (${session.repo}).`,
      };
    case "notify_pearl_review_approved":
      return {
        type: tag,
        message: `Review ${session.id} is approved as of round ${round} (${session.repo}) — no new comments.`,
      };
    default:
      return { type: tag };
  }
}

// Every state-mutating route goes through this: read the session (migrating
// legacy on-disk data as it's read — "start equals recover"), run the one
// pure transition, persist the result, and translate a thrown
// Illegal/GuardFailed error into the same {ok:false, error} shape every
// other route in this file already returns, so server.js doesn't need to
// know the FSM exists.
function applyTransition(id, event, payload = {}) {
  const session = getSession(id);
  if (!session) return { ok: false, notFound: true, error: "Unknown review" };

  try {
    const { state, noop, effects } = transition(session.state, event, payload);
    const updated = updateSession(id, { state });
    return {
      ok: true,
      noop,
      session: updated,
      effects: effects.map((tag) => describeEffect(tag, updated, updated.currentRound)),
    };
  } catch (err) {
    if (err instanceof IllegalTransitionError) {
      return { ok: false, error: err.message, code: err.code };
    }
    if (err instanceof GuardFailedError) {
      return { ok: false, error: err.message, code: err.code, reason: err.reason };
    }
    throw err;
  }
}

// Splits `git diff <base>..<head>` output into one chunk per changed file —
// Phase 0's chunking granularity. A lookahead split (not a plain split, which
// would discard the matched separator) keeps each file's own
// "diff --git a/x b/x" header attached to its body.
export function parseDiffIntoChunks(diffText) {
  if (!diffText.trim()) return [];
  const parts = diffText.split(/(?=^diff --git )/m).filter((p) => p.trim());

  return parts.map((part, idx) => {
    const fileMatch = part.match(/^diff --git a\/(.+?) b\/(.+)$/m);
    const file = fileMatch ? fileMatch[2] : `unknown-${idx}`;
    // First hunk's new-file start line — good enough for `code --goto` to
    // land somewhere useful in the chunk; not meant to be exact for every
    // hunk in a multi-hunk file.
    const hunkMatch = part.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/m);
    const firstChangedLine = hunkMatch ? Number.parseInt(hunkMatch[1], 10) : 1;

    return {
      id: `c${idx + 1}`,
      file,
      firstChangedLine,
      diff: part.trimEnd(),
      status: "pending",
      checklist: GENERIC_CHECKLIST.map((text, i) => ({
        id: `c${idx + 1}-k${i + 1}`,
        text,
        status: "pending",
      })),
    };
  });
}

export function computeDiff(repoRoot, baseSha, headSha) {
  return git(repoRoot, ["diff", `${baseSha}..${headSha}`]);
}

// baseBranch's merge-base with HEAD, not baseBranch itself — so a base
// branch that's moved since the feature branch forked doesn't leak
// unrelated upstream commits into round 1 (see design doc).
export function startReview({ repo, baseBranch, prUrl = null }) {
  if (!repo || !existsSync(repo)) {
    throw new Error(`Repo not found: ${repo}`);
  }
  if (!baseBranch) {
    throw new Error("baseBranch is required");
  }

  const baseSha = git(repo, ["merge-base", baseBranch, "HEAD"]);
  const headSha = git(repo, ["rev-parse", "HEAD"]);

  const diffText = computeDiff(repo, baseSha, headSha);
  const chunks = parseDiffIntoChunks(diffText);
  if (chunks.length === 0) {
    throw new Error(`No changes between ${baseBranch} and HEAD in ${repo}`);
  }

  const id = randomUUID();
  const now = new Date().toISOString();
  // START_REVIEW always legal from NONE (a review with this id has never
  // existed before randomUUID()) — no try/catch needed here, unlike every
  // other transition below.
  const { state } = transition(NONE, EVENTS.START_REVIEW);

  writeJson(sessionPathFor(id), {
    id,
    repo,
    prUrl,
    baseBranch,
    // The whole feature branch's own starting point, held here (not just
    // recoverable from round 1's own file) so any round — including a
    // freshly dispatched one with no memory of earlier rounds — can always
    // reconstruct the full-branch diff/log, not just its own incremental
    // slice against the previous round.
    rootBaseSha: baseSha,
    state,
    currentRound: 1,
    createdAt: now,
    updatedAt: now,
  });

  writeJson(roundPathFor(id, 1), {
    round: 1,
    baseSha,
    headSha,
    chunks,
    startedAt: now,
    completedAt: null,
  });

  return { id, round: 1 };
}

// Migrates legacy `status`-only sessions in place as they're read — the
// first read after an upgrade rewrites the file, every read after that is
// already in the new shape. Re-running this migration (restart, retry,
// crash mid-write) is safe: migrateLegacySession is a no-op once `state`
// is present.
export function getSession(id) {
  const session = readJson(sessionPathFor(id));
  if (!session) return null;

  const migrated = migrateLegacySession(session);
  if (migrated !== session) writeJson(sessionPathFor(id), migrated);
  return migrated;
}

export function getRound(id, round) {
  return readJson(roundPathFor(id, round));
}

export function listReviews() {
  const root = reviewRoot();
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .map((id) => getSession(id))
    .filter(Boolean)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

// Comments are an append-only ledger (comments.jsonl), not a mutable record —
// the walkthrough job (writer while a round's comment-leaving phase is open)
// and a future change job (writer while resolving the round after) never
// hold the pen at the same time by construction, so this sidesteps the
// "two writers, one JSON file, last write wins" hazard a single mutable file
// would have. A comment's current state is whichever line for its id comes
// last in the log.
export function addComment(id, round, { chunkId = null, file = null, line = null, text }) {
  const session = getSession(id);
  if (!session || !getRound(id, round)) return null;
  if (!text || !text.trim()) throw new Error("text is required");
  // Throws IllegalTransitionError (a round that's awaiting/getting changes,
  // or already approved/abandoned) — ADD_COMMENT is a self-loop, so this
  // never changes `state`, it only gates on it.
  transition(session.state, EVENTS.ADD_COMMENT);

  const comment = {
    id: `cm_${randomUUID()}`,
    round,
    chunkId,
    file,
    line,
    text,
    status: "open",
    createdAt: new Date().toISOString(),
  };
  mkdirSync(reviewDirFor(id), { recursive: true });
  appendFileSync(commentsPathFor(id), `${JSON.stringify(comment)}\n`, "utf-8");
  return comment;
}

export function listComments(id, { round = null } = {}) {
  const path = commentsPathFor(id);
  if (!existsSync(path)) return [];

  const byId = new Map();
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    const entry = JSON.parse(line);
    byId.set(entry.id, entry);
  }

  const all = [...byId.values()];
  return round === null ? all : all.filter((c) => c.round === round);
}

const RESOLUTION_STATUSES = ["resolved", "pushed_back"];
const MAX_RESOLUTION_NOTE = 2000;
const MAX_RESOLUTION_FILES = 100;
const MAX_PATH_LENGTH = 500;

function isRelativeRepoPath(path) {
  return (
    typeof path === "string" &&
    path.length > 0 &&
    path.length <= MAX_PATH_LENGTH &&
    !path.startsWith("/") &&
    !path.split("/").includes("..")
  );
}

function updateSession(id, fields) {
  const session = getSession(id);
  const updated = { ...session, ...fields, updatedAt: new Date().toISOString() };
  writeJson(sessionPathFor(id), updated);
  return updated;
}

// The change job's half of the ledger: one appended line per comment, never
// an edit in place. `files` is what lets the next round match each changed
// chunk back to the comment that caused it, so it has to name repo-relative
// paths exactly as git reports them.
export function resolveComment(id, commentId, { status, note, files = [] }) {
  const session = getSession(id);
  if (!session) return { ok: false, notFound: true, error: "Unknown review" };
  const comment = listComments(id).find((c) => c.id === commentId);
  if (!comment) return { ok: false, notFound: true, error: `Unknown comment ${commentId}` };
  if (comment.status !== "open") {
    return { ok: false, error: `Comment ${commentId} is already ${comment.status}` };
  }
  if (!RESOLUTION_STATUSES.includes(status)) {
    return { ok: false, error: `status must be one of ${RESOLUTION_STATUSES.join(", ")}` };
  }
  if (typeof note !== "string" || !note.trim() || note.length > MAX_RESOLUTION_NOTE) {
    return { ok: false, error: `note is required (at most ${MAX_RESOLUTION_NOTE} characters)` };
  }
  if (!Array.isArray(files) || files.length > MAX_RESOLUTION_FILES || !files.every(isRelativeRepoPath)) {
    return { ok: false, error: `files must be at most ${MAX_RESOLUTION_FILES} repo-relative paths` };
  }

  // Guarded before the ledger is touched: a comment can only be resolved
  // once its round has actually closed (AWAITING_CHANGE_JOB) or while a
  // change job is already working the rest of the queue
  // (CHANGES_IN_PROGRESS) — never while the round is still open for new
  // comments.
  let transitionResult;
  try {
    transitionResult = transition(session.state, EVENTS.RESOLVE_COMMENT);
  } catch (err) {
    if (err instanceof IllegalTransitionError) return { ok: false, error: err.message, code: err.code };
    throw err;
  }

  const entry = {
    ...comment,
    status,
    note,
    files,
    addressedInRound: comment.round,
    resolvedAt: new Date().toISOString(),
  };
  appendFileSync(commentsPathFor(id), `${JSON.stringify(entry)}\n`, "utf-8");
  if (!transitionResult.noop) updateSession(id, { state: transitionResult.state });
  return { ok: true, comment: entry };
}

function annotateChunks(chunks, comments) {
  return chunks.map((chunk) => {
    const addressedComments = comments
      .filter((c) => c.status === "resolved" && (c.files || []).includes(chunk.file))
      .map((c) => c.id);
    return { ...chunk, addressedComments, untraced: addressedComments.length === 0 };
  });
}

// Round N+1 is always the diff from round N's head to the current HEAD, so it
// shows only what the change job did, never anything older. Writes the round
// file before bumping the session: a crash in between leaves a round the
// session hasn't caught up to, which the already-exists branch below repairs
// on the next call (start equals recover), rather than a session pointing at
// a round that was never written.
export function nextRound(id, round) {
  const session = getSession(id);
  if (!session) return { ok: false, notFound: true, error: "Unknown review" };
  const roundData = getRound(id, round);
  if (!roundData) return { ok: false, notFound: true, error: "Unknown round" };

  const existing = getRound(id, round + 1);
  if (existing) {
    // ADVANCE_ROUND's own idempotency (ROUND_READY -> ROUND_READY, a noop)
    // covers the state; currentRound still needs bumping on a genuine
    // retry (a crash between writeJson and updateSession below).
    if (session.currentRound < round + 1) updateSession(id, { currentRound: round + 1 });
    return { ok: true, round: existing, alreadyExisted: true };
  }

  // A concrete, round-scoped fact, checked ahead of the FSM: `session.state`
  // tracks the review's *current* stage, which for round 1 reads
  // ROUND_READY both before round 1 has ever been completed and (for a
  // later round) after it has — the two aren't distinguishable from
  // `state` alone the way ADVANCE_ROUND's own idempotency check needs.
  // `roundData.completedAt` is unambiguous either way.
  if (!roundData.completedAt) return { ok: false, error: `Round ${round} isn't complete yet` };

  const comments = listComments(id, { round });
  const openCommentIds = comments.filter((c) => c.status === "open").map((c) => c.id);
  const workingTreeDirty = Boolean(
    // Uncommitted edits wouldn't show up in a commit-to-commit diff, so
    // they'd silently skip review rather than fail loudly here.
    git(session.repo, ["status", "--porcelain"]),
  );

  let transitionResult;
  try {
    transitionResult = transition(session.state, EVENTS.ADVANCE_ROUND, {
      openCommentCount: openCommentIds.length,
      workingTreeClean: !workingTreeDirty,
    });
  } catch (err) {
    if (err instanceof IllegalTransitionError) return { ok: false, error: err.message, code: err.code };
    if (err instanceof GuardFailedError) {
      if (err.reason === "open_comments") {
        return {
          ok: false,
          error: `${openCommentIds.length} comment(s) from round ${round} are still open`,
          openCommentIds,
        };
      }
      return { ok: false, error: `Working tree in ${session.repo} has uncommitted changes; commit them first` };
    }
    throw err;
  }

  const headSha = git(session.repo, ["rev-parse", "HEAD"]);
  const chunks = parseDiffIntoChunks(computeDiff(session.repo, roundData.headSha, headSha));
  const next = {
    round: round + 1,
    baseSha: roundData.headSha,
    headSha,
    chunks: annotateChunks(chunks, comments),
    outcomes: comments.map(({ id: commentId, file, line, text, status, note, files }) => ({
      id: commentId,
      file,
      line,
      text,
      status,
      note,
      files,
    })),
    startedAt: new Date().toISOString(),
    completedAt: null,
  };

  // Round file written before the session is bumped: a crash in between
  // leaves a round the session hasn't caught up to yet, which the
  // `existing` branch above repairs on the next call.
  writeJson(roundPathFor(id, round + 1), next);
  const updated = updateSession(id, { currentRound: round + 1, state: transitionResult.state });
  return {
    ok: true,
    round: next,
    effects: transitionResult.effects.map((tag) => describeEffect(tag, updated, round + 1)),
  };
}

// Checklist confirmation lives on the round file directly (one writer — the
// walkthrough job — for the round's whole comment-leaving phase), unlike
// comments, which need the append-only ledger because two different job
// types touch them across rounds.
export function confirmChecklistItem(id, round, checklistId) {
  const session = getSession(id);
  const roundData = getRound(id, round);
  if (!session || !roundData) return null;
  // Throws IllegalTransitionError once the round has moved past
  // WALKTHROUGH_IN_PROGRESS — same self-loop guard as ADD_COMMENT.
  transition(session.state, EVENTS.CONFIRM_CHECKLIST_ITEM);

  let found = null;
  for (const chunk of roundData.chunks) {
    const item = chunk.checklist.find((k) => k.id === checklistId);
    if (item) {
      item.status = "confirmed";
      found = item;
      break;
    }
  }
  if (!found) return null;

  writeJson(roundPathFor(id, round), roundData);
  return roundData;
}

const MAX_GROUP_TITLE = 120;
const MAX_GROUP_RATIONALE = 500;

// The walk order is the agent's judgment (by data flow, by layer), not a
// mechanical sort, so it's proposed by the walkthrough job and only
// validated here. The one invariant that can't be left to judgment: every
// chunk lands in exactly one group, so a grouping can never silently drop a
// file from review. Chunks stay the unit of checklist state; groups only
// change the order they're walked in.
export function validateGroups(chunks, groups) {
  if (!Array.isArray(groups) || groups.length === 0) {
    return { ok: false, error: "groups must be a non-empty array" };
  }
  if (groups.length > chunks.length) {
    return { ok: false, error: "more groups than chunks" };
  }

  const known = new Set(chunks.map((c) => c.id));
  const seen = new Set();
  const duplicates = [];
  const unknown = [];

  for (const group of groups) {
    if (typeof group?.title !== "string" || !group.title.trim() || group.title.length > MAX_GROUP_TITLE) {
      return { ok: false, error: `each group needs a title (at most ${MAX_GROUP_TITLE} characters)` };
    }
    if (group.rationale !== undefined && (typeof group.rationale !== "string" || group.rationale.length > MAX_GROUP_RATIONALE)) {
      return { ok: false, error: `rationale must be a string (at most ${MAX_GROUP_RATIONALE} characters)` };
    }
    if (!Array.isArray(group.chunkIds) || group.chunkIds.length === 0) {
      return { ok: false, error: `group "${group.title}" has no chunkIds` };
    }
    for (const chunkId of group.chunkIds) {
      if (!known.has(chunkId)) unknown.push(chunkId);
      else if (seen.has(chunkId)) duplicates.push(chunkId);
      seen.add(chunkId);
    }
  }

  const missing = [...known].filter((chunkId) => !seen.has(chunkId));
  if (missing.length || duplicates.length || unknown.length) {
    return { ok: false, error: "every chunk must appear in exactly one group", missing, duplicates, unknown };
  }
  return { ok: true };
}

export function setRoundGroups(id, round, groups) {
  const roundData = getRound(id, round);
  if (!roundData) return { ok: false, notFound: true, error: "Unknown review or round" };
  if (roundData.completedAt) return { ok: false, error: "Round already complete" };

  const validation = validateGroups(roundData.chunks, groups);
  if (!validation.ok) return validation;

  roundData.groups = groups.map(({ title, rationale = null, chunkIds }) => ({ title, rationale, chunkIds }));
  writeJson(roundPathFor(id, round), roundData);
  return { ok: true, round: roundData };
}

// Closes the comment-leaving phase of a round. Refuses when checklist items
// are still unconfirmed unless force is passed — Jay can always override,
// but doesn't silently skip by default.
export function completeRound(id, round, { force = false } = {}) {
  const session = getSession(id);
  if (!session) return { ok: false, error: "Unknown review" };
  const roundData = getRound(id, round);
  if (!roundData) return { ok: false, error: "Unknown round" };
  if (roundData.completedAt) return { ok: false, error: "Round already complete" };

  const unconfirmed = roundData.chunks
    .flatMap((c) => c.checklist)
    .filter((k) => k.status !== "confirmed").length;
  const commentCountThisRound = listComments(id, { round }).length;

  let transitionResult;
  try {
    transitionResult = transition(session.state, EVENTS.COMPLETE_ROUND, {
      unconfirmedChecklistCount: unconfirmed,
      force,
      commentCountThisRound,
    });
  } catch (err) {
    if (err instanceof IllegalTransitionError) return { ok: false, error: err.message, code: err.code };
    if (err instanceof GuardFailedError) {
      return { ok: false, error: `${unconfirmed} checklist item(s) not confirmed yet`, unconfirmed };
    }
    throw err;
  }

  const now = new Date().toISOString();
  roundData.completedAt = now;
  writeJson(roundPathFor(id, round), roundData);

  const updated = updateSession(id, { state: transitionResult.state });
  return {
    ok: true,
    session: updated,
    round: roundData,
    effects: transitionResult.effects.map((tag) => describeEffect(tag, updated, round)),
  };
}

// Dispatched by server.js's /api/dispatch whenever a review-role job with
// role "walkthrough" actually starts — the moment this review's current
// round stops being merely computed (ROUND_READY) and starts being
// actively walked. Idempotent: a retry, or round 1's dispatch landing
// while it's already in progress, is a no-op (see DISPATCH_WALKTHROUGH in
// review-fsm.js).
export function dispatchWalkthrough(id) {
  const session = getSession(id);
  if (!session) return { ok: false, notFound: true, error: "Unknown review" };

  try {
    const { state, noop } = transition(session.state, EVENTS.DISPATCH_WALKTHROUGH);
    const updated = noop ? session : updateSession(id, { state });
    return { ok: true, noop, session: updated };
  } catch (err) {
    if (err instanceof IllegalTransitionError) return { ok: false, error: err.message, code: err.code };
    throw err;
  }
}

// Jay drops a review without shipping it. Legal from any non-terminal
// state; a review already APPROVED or ABANDONED can't be abandoned again
// (IllegalTransitionError), matching every other terminal-state guard in
// this file.
export function abandonReview(id) {
  return applyTransition(id, EVENTS.ABANDON);
}
