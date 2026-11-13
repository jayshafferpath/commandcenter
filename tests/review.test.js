import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let fakeHome;
let repo;

// review.js resolves its root lazily via os.homedir(), same reason as
// brain.js's brainRoot() — a module-level constant would freeze before any
// test gets a chance to mock it.
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, homedir: () => fakeHome };
});

const {
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
  parseDiffIntoChunks,
  resolveComment,
  setRoundGroups,
  startReview,
  validateGroups,
} = await import("../api/review.js");
const { STATES } = await import("../api/lib/review-fsm.js");

function git(args) {
  return execFileSync("git", args, { cwd: repo, encoding: "utf-8" }).trim();
}

// startReview() alone leaves a review in ROUND_READY (round 1's diff is
// computed, nothing has started walking it yet — see review-fsm.js).
// Everything in this file that then adds a comment, confirms a checklist
// item, or completes the round needs a walkthrough job actually dispatched
// first, same as server.js's /api/dispatch does for a real "walkthrough"
// job.
function startReviewInProgress(opts) {
  const started = startReview(opts);
  dispatchWalkthrough(started.id);
  return started;
}

// A real two-commit repo: main at the base commit, a feature branch one
// commit ahead that touches two files. Real git, not a mocked diff, so
// startReview's merge-base/diff plumbing is actually exercised.
function makeRepoWithOneChange() {
  repo = mkdtempSync(join(tmpdir(), "review-test-repo-"));
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Test"]);

  writeFileSync(join(repo, "a.js"), "const a = 1;\n", "utf-8");
  writeFileSync(join(repo, "b.js"), "const b = 1;\n", "utf-8");
  git(["add", "."]);
  git(["commit", "-q", "-m", "base"]);

  git(["checkout", "-q", "-b", "feature"]);
  writeFileSync(join(repo, "a.js"), "const a = 1;\nconst a2 = 2;\n", "utf-8");
  writeFileSync(join(repo, "b.js"), "const b = 1;\nconst b2 = 2;\n", "utf-8");
  git(["add", "."]);
  git(["commit", "-q", "-m", "feature change"]);
}

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), "review-test-home-"));
});

afterEach(() => {
  rmSync(fakeHome, { recursive: true, force: true });
  if (repo) rmSync(repo, { recursive: true, force: true });
  repo = undefined;
});

describe("parseDiffIntoChunks", () => {
  it("returns one chunk per changed file, in order", () => {
    const diff = [
      "diff --git a/a.js b/a.js",
      "index 111..222 100644",
      "--- a/a.js",
      "+++ b/a.js",
      "@@ -1,1 +1,2 @@",
      " const a = 1;",
      "+const a2 = 2;",
      "diff --git a/b.js b/b.js",
      "index 333..444 100644",
      "--- a/b.js",
      "+++ b/b.js",
      "@@ -1,1 +1,2 @@",
      " const b = 1;",
      "+const b2 = 2;",
    ].join("\n");

    const chunks = parseDiffIntoChunks(diff);
    expect(chunks.map((c) => c.file)).toEqual(["a.js", "b.js"]);
    expect(chunks[0].firstChangedLine).toBe(1);
    expect(chunks[0].checklist).toHaveLength(3);
    expect(chunks[0].checklist.every((k) => k.status === "pending")).toBe(true);
  });

  it("returns no chunks for empty input", () => {
    expect(parseDiffIntoChunks("")).toEqual([]);
  });
});

describe("startReview", () => {
  it("creates a session and round 1 from a real repo diff, ready but not yet walked", () => {
    makeRepoWithOneChange();
    const { id, round } = startReview({ repo, baseBranch: "main" });

    expect(round).toBe(1);
    const session = getSession(id);
    expect(session.repo).toBe(repo);
    // Round 1's diff is computed; nothing has dispatched its walkthrough
    // job yet — see the "State machine" section of
    // .plans/interactive-review-loop.md for why this is ROUND_READY, not
    // WALKTHROUGH_IN_PROGRESS.
    expect(session.state).toBe(STATES.ROUND_READY);
    expect(session.currentRound).toBe(1);

    const roundData = getRound(id, 1);
    expect(roundData.chunks.map((c) => c.file).sort()).toEqual(["a.js", "b.js"]);
    expect(roundData.completedAt).toBeNull();
    // Held on the session, not just recoverable from round 1 — so a later
    // round (a separate dispatched job, with no memory of this one) can
    // always find the whole feature branch's own starting point.
    expect(session.rootBaseSha).toBe(roundData.baseSha);
  });

  it("rejects an unknown repo path", () => {
    expect(() => startReview({ repo: "/nope/not/a/repo", baseBranch: "main" })).toThrow(/not found/i);
  });

  it("rejects when there is nothing to review", () => {
    repo = mkdtempSync(join(tmpdir(), "review-test-empty-"));
    git(["init", "-q", "-b", "main"]);
    git(["config", "user.email", "test@example.com"]);
    git(["config", "user.name", "Test"]);
    writeFileSync(join(repo, "a.js"), "const a = 1;\n", "utf-8");
    git(["add", "."]);
    git(["commit", "-q", "-m", "base"]);

    expect(() => startReview({ repo, baseBranch: "main" })).toThrow(/no changes/i);
  });
});

// On-disk sessions written by the old implicit lifecycle only ever had
// `status`, never `state`. getSession() migrates them in place the first
// time they're read — this is the exact shape review 6a8f07ea…
// (dsm-transport) had sitting under ~/.commandcenter/review before this
// change: a round's diff computed and `status: "walkthrough"`, with no
// walkthrough job ever actually dispatched for it.
describe("legacy session migration", () => {
  function writeLegacySession(id, status) {
    const dir = join(fakeHome, ".commandcenter", "review", id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "session.json"),
      JSON.stringify({
        id,
        repo: "/tmp/does-not-matter",
        prUrl: null,
        baseBranch: "main",
        rootBaseSha: "deadbeef",
        status,
        currentRound: 2,
        createdAt: "2026-11-12T23:24:07.582Z",
        updatedAt: "2026-11-13T06:53:23.412Z",
      }),
      "utf-8",
    );
  }

  it("reads an old status:walkthrough session as round_ready, not walkthrough_in_progress", () => {
    writeLegacySession("legacy-1", "walkthrough");
    expect(getSession("legacy-1").state).toBe(STATES.ROUND_READY);
  });

  it("reads old status:awaiting_changes / changes_in_progress sessions as their matching state", () => {
    writeLegacySession("legacy-2", "awaiting_changes");
    writeLegacySession("legacy-3", "changes_in_progress");
    expect(getSession("legacy-2").state).toBe(STATES.AWAITING_CHANGE_JOB);
    expect(getSession("legacy-3").state).toBe(STATES.CHANGES_IN_PROGRESS);
  });

  it("rewrites the file on disk so the migration only ever happens once", () => {
    writeLegacySession("legacy-4", "walkthrough");
    getSession("legacy-4");

    const onDisk = JSON.parse(readFileSync(join(fakeHome, ".commandcenter", "review", "legacy-4", "session.json"), "utf-8"));
    expect(onDisk.state).toBe(STATES.ROUND_READY);
  });

  it("migrated sessions go through dispatchWalkthrough like any other", () => {
    writeLegacySession("legacy-5", "walkthrough");
    const result = dispatchWalkthrough("legacy-5");
    expect(result.ok).toBe(true);
    expect(getSession("legacy-5").state).toBe(STATES.WALKTHROUGH_IN_PROGRESS);
  });
});

describe("dispatchWalkthrough", () => {
  it("moves a freshly started review into walkthrough_in_progress", () => {
    makeRepoWithOneChange();
    const { id } = startReview({ repo, baseBranch: "main" });

    const result = dispatchWalkthrough(id);
    expect(result.ok).toBe(true);
    expect(result.noop).toBe(false);
    expect(getSession(id).state).toBe(STATES.WALKTHROUGH_IN_PROGRESS);
  });

  it("is a safe no-op when the walkthrough is already in progress", () => {
    makeRepoWithOneChange();
    const { id } = startReviewInProgress({ repo, baseBranch: "main" });

    const result = dispatchWalkthrough(id);
    expect(result.ok).toBe(true);
    expect(result.noop).toBe(true);
    expect(getSession(id).state).toBe(STATES.WALKTHROUGH_IN_PROGRESS);
  });

  it("refuses on an unknown review", () => {
    expect(dispatchWalkthrough("nope").notFound).toBe(true);
  });

  it("refuses once the round has been completed — nothing to dispatch yet", () => {
    makeRepoWithOneChange();
    const { id } = startReviewInProgress({ repo, baseBranch: "main" });
    completeRound(id, 1, { force: true });

    const result = dispatchWalkthrough(id);
    expect(result.ok).toBe(false);
    expect(result.code).toBe("ILLEGAL_TRANSITION");
  });
});

describe("abandonReview", () => {
  it("abandons a review mid-walkthrough", () => {
    makeRepoWithOneChange();
    const { id } = startReviewInProgress({ repo, baseBranch: "main" });

    const result = abandonReview(id);
    expect(result.ok).toBe(true);
    expect(getSession(id).state).toBe(STATES.ABANDONED);
  });

  it("refuses to abandon an already-abandoned review", () => {
    makeRepoWithOneChange();
    const { id } = startReviewInProgress({ repo, baseBranch: "main" });
    abandonReview(id);

    const result = abandonReview(id);
    expect(result.ok).toBe(false);
    expect(result.code).toBe("ILLEGAL_TRANSITION");
  });

  it("refuses on an unknown review", () => {
    expect(abandonReview("nope").notFound).toBe(true);
  });
});

describe("comments", () => {
  it("records a comment scoped to its round and chunk", () => {
    makeRepoWithOneChange();
    const { id } = startReviewInProgress({ repo, baseBranch: "main" });

    const comment = addComment(id, 1, { chunkId: "c1", file: "a.js", line: 2, text: "use a constant name" });
    expect(comment.status).toBe("open");

    const comments = listComments(id, { round: 1 });
    expect(comments).toHaveLength(1);
    expect(comments[0].text).toBe("use a constant name");
  });

  it("returns null for an unknown review", () => {
    expect(addComment("nope", 1, { text: "x" })).toBeNull();
  });

  it("refuses on a round that hasn't been dispatched for walkthrough yet", () => {
    makeRepoWithOneChange();
    const { id } = startReview({ repo, baseBranch: "main" });
    expect(() => addComment(id, 1, { text: "too early" })).toThrow(/ADD_COMMENT/);
  });

  it("refuses once the round is closed", () => {
    makeRepoWithOneChange();
    const { id } = startReviewInProgress({ repo, baseBranch: "main" });
    completeRound(id, 1, { force: true });
    expect(() => addComment(id, 1, { text: "too late" })).toThrow(/ADD_COMMENT/);
  });

  it("rejects empty comment text", () => {
    makeRepoWithOneChange();
    const { id } = startReviewInProgress({ repo, baseBranch: "main" });
    expect(() => addComment(id, 1, { text: "   " })).toThrow(/text is required/);
  });

  it("folds the append-only ledger to the latest entry per id", () => {
    makeRepoWithOneChange();
    const { id } = startReviewInProgress({ repo, baseBranch: "main" });
    const comment = addComment(id, 1, { text: "first" });

    // Simulates a later writer (the Phase 1 change agent) appending a
    // resolution line for the same comment id.
    const path = join(fakeHome, ".commandcenter", "review", id, "comments.jsonl");
    appendFileSync(
      path,
      `${JSON.stringify({ ...comment, status: "resolved", resolution: "done" })}\n`,
      "utf-8",
    );

    const comments = listComments(id, { round: 1 });
    expect(comments).toHaveLength(1);
    expect(comments[0].status).toBe("resolved");
  });
});

describe("confirmChecklistItem", () => {
  it("marks one item confirmed without touching the others", () => {
    makeRepoWithOneChange();
    const { id } = startReviewInProgress({ repo, baseBranch: "main" });
    const before = getRound(id, 1);
    const firstId = before.chunks[0].checklist[0].id;

    confirmChecklistItem(id, 1, firstId);

    const after = getRound(id, 1);
    expect(after.chunks[0].checklist[0].status).toBe("confirmed");
    expect(after.chunks[0].checklist[1].status).toBe("pending");
  });

  it("returns null for an unknown checklist id", () => {
    makeRepoWithOneChange();
    const { id } = startReviewInProgress({ repo, baseBranch: "main" });
    expect(confirmChecklistItem(id, 1, "nope")).toBeNull();
  });

  it("refuses on a round that hasn't been dispatched for walkthrough yet", () => {
    makeRepoWithOneChange();
    const { id } = startReview({ repo, baseBranch: "main" });
    const checklistId = getRound(id, 1).chunks[0].checklist[0].id;
    expect(() => confirmChecklistItem(id, 1, checklistId)).toThrow(/CONFIRM_CHECKLIST_ITEM/);
  });
});

describe("completeRound", () => {
  it("refuses while checklist items are unconfirmed", () => {
    makeRepoWithOneChange();
    const { id } = startReviewInProgress({ repo, baseBranch: "main" });
    const result = completeRound(id, 1);
    expect(result.ok).toBe(false);
    expect(result.unconfirmed).toBeGreaterThan(0);
  });

  it("succeeds once every checklist item is confirmed", () => {
    makeRepoWithOneChange();
    const { id } = startReviewInProgress({ repo, baseBranch: "main" });
    addComment(id, 1, { text: "one thing to fix" });
    for (const chunk of getRound(id, 1).chunks) {
      for (const item of chunk.checklist) confirmChecklistItem(id, 1, item.id);
    }

    const result = completeRound(id, 1);
    expect(result.ok).toBe(true);
    expect(result.round.completedAt).not.toBeNull();
    expect(getSession(id).state).toBe(STATES.AWAITING_CHANGE_JOB);
  });

  it("succeeds with force even when items are unconfirmed", () => {
    makeRepoWithOneChange();
    const { id } = startReviewInProgress({ repo, baseBranch: "main" });
    const result = completeRound(id, 1, { force: true });
    expect(result.ok).toBe(true);
  });

  it("refuses to complete an already-completed round", () => {
    makeRepoWithOneChange();
    const { id } = startReviewInProgress({ repo, baseBranch: "main" });
    completeRound(id, 1, { force: true });
    const result = completeRound(id, 1, { force: true });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/already complete/);
  });

  it("goes straight to approved when the round has no comments", () => {
    makeRepoWithOneChange();
    const { id } = startReviewInProgress({ repo, baseBranch: "main" });

    const result = completeRound(id, 1, { force: true });
    expect(result.ok).toBe(true);
    expect(result.session.state).toBe(STATES.APPROVED);
    expect(result.effects).toEqual([
      { type: "notify_pearl_review_approved", message: expect.stringContaining(id) },
    ]);
  });

  it("goes to awaiting_change_job, not approved, when the round has a comment", () => {
    makeRepoWithOneChange();
    const { id } = startReviewInProgress({ repo, baseBranch: "main" });
    addComment(id, 1, { text: "fix this" });

    const result = completeRound(id, 1, { force: true });
    expect(result.session.state).toBe(STATES.AWAITING_CHANGE_JOB);
    expect(result.effects).toEqual([]);
  });
});

describe("validateGroups", () => {
  const chunks = [{ id: "c1" }, { id: "c2" }, { id: "c3" }];

  it("accepts a grouping that covers every chunk exactly once", () => {
    const groups = [
      { title: "Inbound", chunkIds: ["c2", "c1"] },
      { title: "Config", chunkIds: ["c3"] },
    ];
    expect(validateGroups(chunks, groups)).toEqual({ ok: true });
  });

  it("reports a chunk left out of every group", () => {
    const result = validateGroups(chunks, [{ title: "Inbound", chunkIds: ["c1", "c2"] }]);
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(["c3"]);
  });

  it("reports a chunk placed in two groups", () => {
    const result = validateGroups(chunks, [
      { title: "A", chunkIds: ["c1", "c2"] },
      { title: "B", chunkIds: ["c2", "c3"] },
    ]);
    expect(result.duplicates).toEqual(["c2"]);
  });

  it("reports a chunk id that isn't in the round", () => {
    const result = validateGroups(chunks, [{ title: "A", chunkIds: ["c1", "c2", "c3", "c9"] }]);
    expect(result.unknown).toEqual(["c9"]);
  });

  it("rejects a group with no title", () => {
    const result = validateGroups(chunks, [{ title: " ", chunkIds: ["c1", "c2", "c3"] }]);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/title/);
  });

  it("rejects an empty grouping", () => {
    expect(validateGroups(chunks, []).ok).toBe(false);
  });
});

describe("setRoundGroups", () => {
  it("persists a valid grouping onto the round in the given order", () => {
    makeRepoWithOneChange();
    const { id } = startReviewInProgress({ repo, baseBranch: "main" });
    const [first, second] = getRound(id, 1).chunks.map((c) => c.id);
    const groups = [
      { title: "Second first", rationale: "data flow", chunkIds: [second] },
      { title: "Then first", chunkIds: [first] },
    ];

    expect(setRoundGroups(id, 1, groups).ok).toBe(true);
    expect(getRound(id, 1).groups).toEqual([
      { title: "Second first", rationale: "data flow", chunkIds: [second] },
      { title: "Then first", rationale: null, chunkIds: [first] },
    ]);
  });

  it("leaves the round untouched when the grouping is invalid", () => {
    makeRepoWithOneChange();
    const { id } = startReviewInProgress({ repo, baseBranch: "main" });
    const [first] = getRound(id, 1).chunks.map((c) => c.id);

    expect(setRoundGroups(id, 1, [{ title: "Partial", chunkIds: [first] }]).ok).toBe(false);
    expect(getRound(id, 1).groups).toBeUndefined();
  });

  it("refuses to regroup a completed round", () => {
    makeRepoWithOneChange();
    const { id } = startReviewInProgress({ repo, baseBranch: "main" });
    const chunkIds = getRound(id, 1).chunks.map((c) => c.id);
    completeRound(id, 1, { force: true });

    const result = setRoundGroups(id, 1, [{ title: "All", chunkIds }]);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/already complete/);
  });

  it("flags an unknown review as not found", () => {
    expect(setRoundGroups("nope", 1, []).notFound).toBe(true);
  });
});

describe("resolveComment", () => {
  function reviewWithComment() {
    makeRepoWithOneChange();
    const { id } = startReviewInProgress({ repo, baseBranch: "main" });
    const comment = addComment(id, 1, { chunkId: "c1", file: "a.js", line: 2, text: "rename a2" });
    return { id, comment };
  }

  it("refuses while the round is still open for comments", () => {
    const { id, comment } = reviewWithComment();
    const result = resolveComment(id, comment.id, { status: "resolved", note: "too early", files: [] });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("ILLEGAL_TRANSITION");
  });

  it("appends a resolution that the ledger fold picks up", () => {
    const { id, comment } = reviewWithComment();
    completeRound(id, 1, { force: true });
    const result = resolveComment(id, comment.id, { status: "resolved", note: "Renamed to total", files: ["a.js"] });

    expect(result.ok).toBe(true);
    const [folded] = listComments(id, { round: 1 });
    expect(folded).toMatchObject({ status: "resolved", note: "Renamed to total", files: ["a.js"], addressedInRound: 1 });
  });

  it("moves an awaiting_change_job session to changes_in_progress", () => {
    const { id, comment } = reviewWithComment();
    completeRound(id, 1, { force: true });
    resolveComment(id, comment.id, { status: "resolved", note: "done", files: ["a.js"] });
    expect(getSession(id).state).toBe(STATES.CHANGES_IN_PROGRESS);
  });

  it("stays in changes_in_progress across more than one resolution", () => {
    makeRepoWithOneChange();
    const { id } = startReviewInProgress({ repo, baseBranch: "main" });
    const first = addComment(id, 1, { text: "one" });
    const second = addComment(id, 1, { text: "two" });
    completeRound(id, 1, { force: true });

    resolveComment(id, first.id, { status: "resolved", note: "done", files: [] });
    const result = resolveComment(id, second.id, { status: "resolved", note: "also done", files: [] });
    expect(result.ok).toBe(true);
    expect(getSession(id).state).toBe(STATES.CHANGES_IN_PROGRESS);
  });

  it("refuses to resolve a comment twice", () => {
    const { id, comment } = reviewWithComment();
    completeRound(id, 1, { force: true });
    resolveComment(id, comment.id, { status: "resolved", note: "done", files: [] });
    const result = resolveComment(id, comment.id, { status: "pushed_back", note: "nope", files: [] });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/already resolved/);
  });

  it("rejects an unknown status", () => {
    const { id, comment } = reviewWithComment();
    completeRound(id, 1, { force: true });
    expect(resolveComment(id, comment.id, { status: "ignored", note: "x" }).ok).toBe(false);
  });

  it("rejects a missing note", () => {
    const { id, comment } = reviewWithComment();
    completeRound(id, 1, { force: true });
    expect(resolveComment(id, comment.id, { status: "resolved", note: " " }).ok).toBe(false);
  });

  it("rejects absolute and parent-escaping file paths", () => {
    const { id, comment } = reviewWithComment();
    completeRound(id, 1, { force: true });
    expect(resolveComment(id, comment.id, { status: "resolved", note: "x", files: ["/etc/passwd"] }).ok).toBe(false);
    expect(resolveComment(id, comment.id, { status: "resolved", note: "x", files: ["../a.js"] }).ok).toBe(false);
  });

  it("flags an unknown comment as not found", () => {
    const { id } = reviewWithComment();
    completeRound(id, 1, { force: true });
    expect(resolveComment(id, "cm_nope", { status: "resolved", note: "x" }).notFound).toBe(true);
  });
});

describe("nextRound", () => {
  function commitChange(file, content) {
    writeFileSync(join(repo, file), content, "utf-8");
    git(["add", "."]);
    git(["commit", "-q", "-m", "Review round 1: address comments"]);
  }

  // Round 1 closed with one comment on a.js, already resolved — the state the
  // change job leaves behind just before it calls next.
  function closedRoundWithResolvedComment() {
    makeRepoWithOneChange();
    const { id } = startReviewInProgress({ repo, baseBranch: "main" });
    const comment = addComment(id, 1, { chunkId: "c1", file: "a.js", line: 2, text: "rename a2" });
    completeRound(id, 1, { force: true });
    resolveComment(id, comment.id, { status: "resolved", note: "Renamed to total", files: ["a.js"] });
    return { id, comment };
  }

  it("diffs only what changed since round 1, not the whole branch", () => {
    const { id } = closedRoundWithResolvedComment();
    commitChange("a.js", "const a = 1;\nconst total = 2;\n");

    const result = nextRound(id, 1);
    expect(result.ok).toBe(true);
    expect(result.round.chunks.map((c) => c.file)).toEqual(["a.js"]);
    expect(result.round.baseSha).toBe(getRound(id, 1).headSha);
  });

  it("matches each changed chunk to the comment that caused it", () => {
    const { id, comment } = closedRoundWithResolvedComment();
    commitChange("a.js", "const a = 1;\nconst total = 2;\n");

    const [chunk] = nextRound(id, 1).round.chunks;
    expect(chunk.addressedComments).toEqual([comment.id]);
    expect(chunk.untraced).toBe(false);
  });

  it("flags a changed file no comment claims as untraced", () => {
    const { id } = closedRoundWithResolvedComment();
    writeFileSync(join(repo, "a.js"), "const a = 1;\nconst total = 2;\n", "utf-8");
    commitChange("b.js", "const b = 1;\nconst b2 = 3;\n");

    const byFile = Object.fromEntries(nextRound(id, 1).round.chunks.map((c) => [c.file, c]));
    expect(byFile["a.js"].untraced).toBe(false);
    expect(byFile["b.js"].untraced).toBe(true);
  });

  it("carries every round 1 comment forward as an outcome", () => {
    const { id, comment } = closedRoundWithResolvedComment();
    commitChange("a.js", "const a = 1;\nconst total = 2;\n");

    expect(nextRound(id, 1).round.outcomes).toEqual([
      { id: comment.id, file: "a.js", line: 2, text: "rename a2", status: "resolved", note: "Renamed to total", files: ["a.js"] },
    ]);
  });

  it("allows an empty diff when every comment was pushed back", () => {
    makeRepoWithOneChange();
    const { id } = startReviewInProgress({ repo, baseBranch: "main" });
    const comment = addComment(id, 1, { text: "rename a2" });
    completeRound(id, 1, { force: true });
    resolveComment(id, comment.id, { status: "pushed_back", note: "Jay agreed the name is fine", files: [] });

    const result = nextRound(id, 1);
    expect(result.ok).toBe(true);
    expect(result.round.chunks).toEqual([]);
    expect(result.round.outcomes[0].status).toBe("pushed_back");
  });

  it("advances the session to round_ready and notifies Pearl", () => {
    const { id } = closedRoundWithResolvedComment();
    commitChange("a.js", "const a = 1;\nconst total = 2;\n");
    const result = nextRound(id, 1);

    expect(getSession(id)).toMatchObject({ currentRound: 2, state: STATES.ROUND_READY });
    expect(result.effects).toEqual([
      { type: "notify_pearl_round_ready", message: expect.stringContaining(id) },
    ]);
  });

  it("returns the existing round unchanged when called twice, without notifying again", () => {
    const { id } = closedRoundWithResolvedComment();
    commitChange("a.js", "const a = 1;\nconst total = 2;\n");
    const first = nextRound(id, 1);
    commitChange("b.js", "const b = 1;\nconst b2 = 9;\n");

    const second = nextRound(id, 1);
    expect(second.alreadyExisted).toBe(true);
    expect(second.round).toEqual(first.round);
    expect(second.effects).toBeUndefined();
  });

  it("refuses while the round is still open", () => {
    makeRepoWithOneChange();
    const { id } = startReviewInProgress({ repo, baseBranch: "main" });
    const result = nextRound(id, 1);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/isn't complete/);
  });

  it("refuses while no comment has been resolved yet", () => {
    makeRepoWithOneChange();
    const { id } = startReviewInProgress({ repo, baseBranch: "main" });
    const comment = addComment(id, 1, { text: "rename a2" });
    completeRound(id, 1, { force: true });

    const result = nextRound(id, 1);
    expect(result.ok).toBe(false);
    expect(result.openCommentIds).toEqual([comment.id]);
  });

  it("refuses when the working tree has uncommitted changes", () => {
    const { id } = closedRoundWithResolvedComment();
    writeFileSync(join(repo, "a.js"), "uncommitted\n", "utf-8");

    const result = nextRound(id, 1);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/uncommitted/);
  });
});

describe("listReviews", () => {
  it("is empty before any review exists", () => {
    expect(listReviews()).toEqual([]);
  });

  it("lists every started review, newest first", () => {
    makeRepoWithOneChange();
    const first = startReview({ repo, baseBranch: "main" });
    // Second repo so the two reviews don't collide on the same path.
    const repoA = repo;
    makeRepoWithOneChange();
    const second = startReview({ repo, baseBranch: "main" });

    const reviews = listReviews();
    expect(reviews.map((r) => r.id).sort()).toEqual([first.id, second.id].sort());

    rmSync(repoA, { recursive: true, force: true });
  });
});
