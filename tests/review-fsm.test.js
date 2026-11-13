import { describe, expect, it } from "vitest";
import {
  EVENTS,
  GuardFailedError,
  IllegalTransitionError,
  migrateLegacySession,
  NONE,
  STATES,
  isTerminal,
  transition,
} from "../api/lib/review-fsm.js";

const ALL_STATES = [NONE, ...Object.values(STATES)];
const ALL_EVENTS = Object.values(EVENTS);

// Every (state, event) pair this machine recognizes as legal, with the
// payload that satisfies its guard (if any) and the state it lands on.
// Table-driven so adding a new transition means adding a row here, not a
// new describe block.
const LEGAL = [
  { state: NONE, event: EVENTS.START_REVIEW, payload: {}, next: STATES.ROUND_READY },

  { state: STATES.ROUND_READY, event: EVENTS.DISPATCH_WALKTHROUGH, payload: {}, next: STATES.WALKTHROUGH_IN_PROGRESS },
  {
    state: STATES.WALKTHROUGH_IN_PROGRESS,
    event: EVENTS.DISPATCH_WALKTHROUGH,
    payload: {},
    next: STATES.WALKTHROUGH_IN_PROGRESS,
    noop: true,
  },

  { state: STATES.WALKTHROUGH_IN_PROGRESS, event: EVENTS.ADD_COMMENT, payload: {}, next: STATES.WALKTHROUGH_IN_PROGRESS },
  {
    state: STATES.WALKTHROUGH_IN_PROGRESS,
    event: EVENTS.CONFIRM_CHECKLIST_ITEM,
    payload: {},
    next: STATES.WALKTHROUGH_IN_PROGRESS,
  },

  {
    state: STATES.WALKTHROUGH_IN_PROGRESS,
    event: EVENTS.COMPLETE_ROUND,
    payload: { unconfirmedChecklistCount: 0, commentCountThisRound: 3 },
    next: STATES.AWAITING_CHANGE_JOB,
  },
  {
    state: STATES.WALKTHROUGH_IN_PROGRESS,
    event: EVENTS.COMPLETE_ROUND,
    payload: { unconfirmedChecklistCount: 2, force: true, commentCountThisRound: 1 },
    next: STATES.AWAITING_CHANGE_JOB,
  },
  {
    state: STATES.WALKTHROUGH_IN_PROGRESS,
    event: EVENTS.COMPLETE_ROUND,
    payload: { unconfirmedChecklistCount: 0, commentCountThisRound: 0 },
    next: STATES.APPROVED,
    effects: ["notify_pearl_review_approved"],
  },

  {
    state: STATES.AWAITING_CHANGE_JOB,
    event: EVENTS.RESOLVE_COMMENT,
    payload: {},
    next: STATES.CHANGES_IN_PROGRESS,
  },
  {
    state: STATES.CHANGES_IN_PROGRESS,
    event: EVENTS.RESOLVE_COMMENT,
    payload: {},
    next: STATES.CHANGES_IN_PROGRESS,
    noop: true,
  },

  {
    state: STATES.CHANGES_IN_PROGRESS,
    event: EVENTS.ADVANCE_ROUND,
    payload: { openCommentCount: 0, workingTreeClean: true },
    next: STATES.ROUND_READY,
    effects: ["notify_pearl_round_ready"],
  },
  // Reachable in practice (review.js calls nextRound before any comment is
  // resolved) but always fails the open-comments guard, since
  // AWAITING_CHANGE_JOB only exists while at least one comment on the round
  // is still open — kept legal (guard-checked), not outright illegal, so
  // that failure carries the same openCommentIds detail CHANGES_IN_PROGRESS
  // would.
  {
    state: STATES.AWAITING_CHANGE_JOB,
    event: EVENTS.ADVANCE_ROUND,
    payload: { openCommentCount: 0, workingTreeClean: true },
    next: STATES.ROUND_READY,
    effects: ["notify_pearl_round_ready"],
  },
  {
    state: STATES.ROUND_READY,
    event: EVENTS.ADVANCE_ROUND,
    payload: {},
    next: STATES.ROUND_READY,
    noop: true,
  },

  { state: STATES.WALKTHROUGH_IN_PROGRESS, event: EVENTS.ABANDON, payload: {}, next: STATES.ABANDONED },
  { state: STATES.AWAITING_CHANGE_JOB, event: EVENTS.ABANDON, payload: {}, next: STATES.ABANDONED },
  { state: STATES.CHANGES_IN_PROGRESS, event: EVENTS.ABANDON, payload: {}, next: STATES.ABANDONED },
  { state: STATES.ROUND_READY, event: EVENTS.ABANDON, payload: {}, next: STATES.ABANDONED },
];

// Every guard that exists, exercised with a payload that fails it.
const GUARD_FAILURES = [
  {
    state: STATES.WALKTHROUGH_IN_PROGRESS,
    event: EVENTS.COMPLETE_ROUND,
    payload: { unconfirmedChecklistCount: 2, force: false, commentCountThisRound: 1 },
    reason: "unconfirmed_checklist",
  },
  {
    state: STATES.CHANGES_IN_PROGRESS,
    event: EVENTS.ADVANCE_ROUND,
    payload: { openCommentCount: 1, workingTreeClean: true },
    reason: "open_comments",
  },
  {
    state: STATES.AWAITING_CHANGE_JOB,
    event: EVENTS.ADVANCE_ROUND,
    payload: { openCommentCount: 1, workingTreeClean: true },
    reason: "open_comments",
  },
  {
    state: STATES.CHANGES_IN_PROGRESS,
    event: EVENTS.ADVANCE_ROUND,
    payload: { openCommentCount: 0, workingTreeClean: false },
    reason: "dirty_working_tree",
  },
];

function legalKey(state, event) {
  return `${state ?? "NONE"}\0${event}`;
}

describe("transition — legal table", () => {
  for (const row of LEGAL) {
    const label = `${row.state ?? "NONE"} + ${row.event} -> ${row.next}${row.noop ? " (noop)" : ""}`;
    it(label, () => {
      const outcome = transition(row.state, row.event, row.payload);
      expect(outcome.state).toBe(row.next);
      expect(outcome.noop).toBe(Boolean(row.noop));
      expect(outcome.effects).toEqual(row.effects ?? []);
    });
  }
});

describe("transition — guard failures", () => {
  for (const row of GUARD_FAILURES) {
    it(`${row.state} + ${row.event} fails guard (${row.reason}) with this payload`, () => {
      expect(() => transition(row.state, row.event, row.payload)).toThrow(GuardFailedError);
      try {
        transition(row.state, row.event, row.payload);
      } catch (err) {
        expect(err.code).toBe("GUARD_FAILED");
        expect(err.reason).toBe(row.reason);
      }
    });
  }
});

// Every (state, event) pair NOT in the legal table is illegal — generated
// rather than hand-listed, so a new STATE or EVENT added later is covered
// automatically instead of silently falling through untested.
describe("transition — every other (state, event) pair is illegal", () => {
  const legalPairs = new Set(LEGAL.map((row) => legalKey(row.state, row.event)));

  for (const state of ALL_STATES) {
    for (const event of ALL_EVENTS) {
      if (legalPairs.has(legalKey(state, event))) continue;
      it(`${state ?? "NONE"} + ${event} is illegal`, () => {
        expect(() => transition(state, event, {})).toThrow(IllegalTransitionError);
      });
    }
  }
});

describe("isTerminal", () => {
  it("is true only for APPROVED and ABANDONED", () => {
    for (const state of Object.values(STATES)) {
      expect(isTerminal(state)).toBe(state === STATES.APPROVED || state === STATES.ABANDONED);
    }
  });
});

describe("migrateLegacySession", () => {
  it("maps every legacy status to its new state", () => {
    expect(migrateLegacySession({ id: "r1", status: "walkthrough" }).state).toBe(STATES.ROUND_READY);
    expect(migrateLegacySession({ id: "r2", status: "awaiting_changes" }).state).toBe(STATES.AWAITING_CHANGE_JOB);
    expect(migrateLegacySession({ id: "r3", status: "changes_in_progress" }).state).toBe(
      STATES.CHANGES_IN_PROGRESS,
    );
  });

  it("is a no-op once state is already present", () => {
    const session = { id: "r1", state: STATES.WALKTHROUGH_IN_PROGRESS };
    expect(migrateLegacySession(session)).toBe(session);
  });

  it("is idempotent — migrating twice gives the same result", () => {
    const once = migrateLegacySession({ id: "r1", status: "walkthrough" });
    const twice = migrateLegacySession(once);
    expect(twice).toEqual(once);
  });

  it("throws on an unrecognized legacy status rather than guessing", () => {
    expect(() => migrateLegacySession({ id: "r1", status: "satisfied" })).toThrow(/unknown legacy status/i);
  });

  it("passes through null/undefined", () => {
    expect(migrateLegacySession(null)).toBeNull();
  });
});
