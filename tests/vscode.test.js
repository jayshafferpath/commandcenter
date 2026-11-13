import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let fakeHome;
let fakeSession;

// vscode.js resolves its root lazily via os.homedir(), same reasoning as
// brain.test.js — a module-level constant would freeze before the mock ran.
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, homedir: () => fakeHome };
});

// connectVscode validates against a review session (api/review.js) — faked
// here rather than spinning up a real git repo (see review.test.js for
// that), since this file's job is vscode.js's own state machine, not
// review.js's startReview plumbing.
vi.mock("../api/review.js", () => ({
  getSession: (id) => (fakeSession && fakeSession.id === id ? fakeSession : null),
}));

const {
  ackCommand,
  clearCommand,
  connectVscode,
  getVscodeState,
  isSameRepoPath,
  matchWalkthroughForRepo,
  moveCommand,
  VscodeNotConnectedError,
  VscodeRepoMismatchError,
  VscodeUnknownReviewError,
  waitForCommand,
} = await import("../api/vscode.js");

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), "vscode-test-"));
  fakeSession = { id: "rev-1", repo: "/repo" };
});

afterEach(() => {
  rmSync(fakeHome, { recursive: true, force: true });
});

describe("connectVscode", () => {
  it("creates state with no pending command", () => {
    const state = connectVscode("rev-1", "/repo");
    expect(state.repo).toBe("/repo");
    expect(state.pendingCommand).toBeNull();
    expect(state.connectedAt).toBe(state.lastSeenAt);
  });

  it("last-connect-wins: a second connect replaces the first", () => {
    connectVscode("rev-1", "/repo");
    const state = connectVscode("rev-1", "/repo");
    expect(state.repo).toBe("/repo");
  });

  it("accepts the review's repo with a trailing slash, same as discovery does", () => {
    expect(connectVscode("rev-1", "/repo/").repo).toBe("/repo/");
  });

  it("hard-rejects a workspace that doesn't match the review's own repo", () => {
    expect(() => connectVscode("rev-1", "/wrong/repo")).toThrow(VscodeRepoMismatchError);
  });

  it("rejects connecting to an id with no review session at all", () => {
    fakeSession = null;
    expect(() => connectVscode("rev-1", "/repo")).toThrow(VscodeUnknownReviewError);
  });
});

describe("moveCommand / clearCommand", () => {
  it("rejects when nothing has connected yet", () => {
    expect(() => moveCommand("rev-1", { file: "a.js", startLine: 1 })).toThrow(VscodeNotConnectedError);
    expect(() => clearCommand("rev-1")).toThrow(VscodeNotConnectedError);
  });

  it("sets a move pendingCommand with defaulted ranges", () => {
    connectVscode("rev-1", "/repo");
    const state = moveCommand("rev-1", { file: "api/review.js", startLine: 318, label: "Pearl" });
    expect(state.pendingCommand).toMatchObject({
      type: "move",
      file: "api/review.js",
      startLine: 318,
      startCol: 1,
      endLine: 318,
      endCol: 1,
      label: "Pearl",
      reveal: true,
    });
    expect(state.pendingCommand.id).toMatch(/^cmd_/);
  });

  it("a move overwrites whatever was already pending", () => {
    connectVscode("rev-1", "/repo");
    const first = moveCommand("rev-1", { file: "a.js", startLine: 1 });
    const second = moveCommand("rev-1", { file: "b.js", startLine: 2 });
    expect(second.pendingCommand.id).not.toBe(first.pendingCommand.id);
    expect(second.pendingCommand.file).toBe("b.js");
  });

  it("clear sets a clear-type pendingCommand", () => {
    connectVscode("rev-1", "/repo");
    moveCommand("rev-1", { file: "a.js", startLine: 1 });
    const state = clearCommand("rev-1");
    expect(state.pendingCommand.type).toBe("clear");
  });
});

describe("ackCommand", () => {
  it("clears pendingCommand when the cmdId matches", () => {
    connectVscode("rev-1", "/repo");
    const { pendingCommand } = moveCommand("rev-1", { file: "a.js", startLine: 1 });
    const state = ackCommand("rev-1", pendingCommand.id);
    expect(state.pendingCommand).toBeNull();
  });

  it("is a no-op when the cmdId is stale (superseded by a newer command)", () => {
    connectVscode("rev-1", "/repo");
    const { pendingCommand: first } = moveCommand("rev-1", { file: "a.js", startLine: 1 });
    moveCommand("rev-1", { file: "b.js", startLine: 2 });
    const state = ackCommand("rev-1", first.id);
    expect(state.pendingCommand.file).toBe("b.js");
  });

  it("rejects when nothing has connected yet", () => {
    expect(() => ackCommand("rev-1", "cmd_x")).toThrow(VscodeNotConnectedError);
  });
});

describe("waitForCommand", () => {
  it("resolves immediately when a command is already pending", async () => {
    connectVscode("rev-1", "/repo");
    moveCommand("rev-1", { file: "a.js", startLine: 1 });
    const state = await waitForCommand("rev-1", { timeoutMs: 5000 });
    expect(state.pendingCommand.file).toBe("a.js");
  });

  it("resolves as soon as a move lands, without waiting out the timeout", async () => {
    connectVscode("rev-1", "/repo");
    const pending = waitForCommand("rev-1", { timeoutMs: 5000 });
    moveCommand("rev-1", { file: "a.js", startLine: 1 });
    const state = await pending;
    expect(state.pendingCommand.file).toBe("a.js");
  });

  it("falls back to the current (null) state once the timeout elapses", async () => {
    connectVscode("rev-1", "/repo");
    const state = await waitForCommand("rev-1", { timeoutMs: 20 });
    expect(state.pendingCommand).toBeNull();
  });

  it("rejects when nothing has connected yet", async () => {
    await expect(waitForCommand("rev-1", { timeoutMs: 20 })).rejects.toThrow(VscodeNotConnectedError);
  });
});

describe("matchWalkthroughForRepo", () => {
  const makeReview = (overrides) => ({
    id: "rev-1",
    repo: "/repo",
    state: "walkthrough_in_progress",
    currentRound: 1,
    ...overrides,
  });

  it("returns no match when no review is in progress for the repo", () => {
    const reviews = [
      makeReview({ id: "rev-1", state: "round_ready" }),
      makeReview({ id: "rev-2", repo: "/other" }),
    ];
    expect(matchWalkthroughForRepo(reviews, "/repo")).toEqual({ match: null, ambiguous: [] });
  });

  it("returns no match for an empty review list", () => {
    expect(matchWalkthroughForRepo([], "/repo")).toEqual({ match: null, ambiguous: [] });
  });

  it("returns the single in-progress walkthrough for the repo", () => {
    const target = makeReview({ id: "rev-2" });
    const reviews = [
      makeReview({ id: "rev-1", state: "awaiting_change_job" }),
      target,
      makeReview({ id: "rev-3", repo: "/other" }),
    ];
    expect(matchWalkthroughForRepo(reviews, "/repo")).toEqual({ match: target, ambiguous: [] });
  });

  it("matches across a trailing slash on either side", () => {
    const target = makeReview({ repo: "/repo/" });
    expect(matchWalkthroughForRepo([target], "/repo").match).toBe(target);
  });

  it("picks none and reports every candidate when several match", () => {
    const reviews = [makeReview({ id: "rev-1" }), makeReview({ id: "rev-2" })];
    expect(matchWalkthroughForRepo(reviews, "/repo")).toEqual({ match: null, ambiguous: ["rev-1", "rev-2"] });
  });
});

describe("isSameRepoPath", () => {
  it("is false when either side is missing", () => {
    expect(isSameRepoPath("", "/repo")).toBe(false);
    expect(isSameRepoPath("/repo", undefined)).toBe(false);
  });

  it("does not treat a parent or sibling path as the same repo", () => {
    expect(isSameRepoPath("/repo", "/repo-two")).toBe(false);
    expect(isSameRepoPath("/repo/sub", "/repo")).toBe(false);
  });
});

describe("getVscodeState", () => {
  it("returns null before any connect", () => {
    expect(getVscodeState("rev-1")).toBeNull();
  });
});
