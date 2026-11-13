// The review loop's lifecycle as one pure state machine. Every route in
// api/review.js calls transition(state, event, payload) instead of poking
// session.status / round.completedAt directly — see the "State machine"
// section of .plans/interactive-review-loop.md for the full design and the
// gap this replaces: round advancement used to just flip session.status
// back to "walkthrough" the moment a round's diff was computed, with
// nothing distinguishing "ready to walk" from "a walkthrough job is
// actually running." That's why round 2 of review
// 6a8f07ea-31ae-4e95-b85d-1cb00f6a3fad sat unnoticed — see ROUND_READY
// below.

export const STATES = Object.freeze({
  WALKTHROUGH_IN_PROGRESS: "walkthrough_in_progress",
  AWAITING_CHANGE_JOB: "awaiting_change_job",
  CHANGES_IN_PROGRESS: "changes_in_progress",
  ROUND_READY: "round_ready",
  APPROVED: "approved",
  ABANDONED: "abandoned",
});

export const EVENTS = Object.freeze({
  START_REVIEW: "START_REVIEW",
  ADD_COMMENT: "ADD_COMMENT",
  CONFIRM_CHECKLIST_ITEM: "CONFIRM_CHECKLIST_ITEM",
  COMPLETE_ROUND: "COMPLETE_ROUND",
  RESOLVE_COMMENT: "RESOLVE_COMMENT",
  ADVANCE_ROUND: "ADVANCE_ROUND",
  DISPATCH_WALKTHROUGH: "DISPATCH_WALKTHROUGH",
  ABANDON: "ABANDON",
});

// No "state" yet — the pseudo-state startReview transitions out of. Never
// persisted; session.json always holds a real STATES value once a review
// exists.
export const NONE = null;

const TERMINAL = new Set([STATES.APPROVED, STATES.ABANDONED]);

export class IllegalTransitionError extends Error {
  constructor(state, event) {
    super(`Cannot apply ${event} from ${state ?? "NONE"}`);
    this.name = "IllegalTransitionError";
    this.code = "ILLEGAL_TRANSITION";
    this.state = state;
    this.event = event;
  }
}

export class GuardFailedError extends Error {
  constructor(state, event, reason) {
    super(`${event} from ${state} failed guard: ${reason}`);
    this.name = "GuardFailedError";
    this.code = "GUARD_FAILED";
    this.state = state;
    this.event = event;
    this.reason = reason;
  }
}

function result(state, { noop = false, effects = [] } = {}) {
  return { state, noop, effects };
}

// The one pure transition function. `payload` carries whatever the guard
// for this (state, event) pair needs — never read from disk here, so the
// same (state, event, payload) triple always produces the same result
// (needed for the idempotency guarantees below and for table-testing).
//
// Throws IllegalTransitionError when `event` has no legal edge out of
// `state` at all, and GuardFailedError when the edge exists but this
// payload doesn't satisfy it. Both are typed so a caller (an API route) can
// tell "this never made sense" (400, programmer error upstream) apart from
// "this made sense but isn't allowed yet" (400, tell the human why).
export function transition(state, event, payload = {}) {
  switch (event) {
    case EVENTS.START_REVIEW: {
      if (state !== NONE) throw new IllegalTransitionError(state, event);
      // Round 1 goes through ROUND_READY too, same as every later round —
      // starting a review computes round 1's diff, it doesn't dispatch its
      // walkthrough job. Treating round 1 as a special case that's
      // "in progress" the instant it's computed is exactly the collapsed
      // distinction this machine exists to undo (see module doc comment).
      // DISPATCH_WALKTHROUGH is the only transition into
      // WALKTHROUGH_IN_PROGRESS, for round 1 and every round after it.
      return result(STATES.ROUND_READY);
    }

    case EVENTS.ADD_COMMENT:
    case EVENTS.CONFIRM_CHECKLIST_ITEM: {
      // Self-loops: these never change `status`, they just require a round
      // to actually be open for comment-leaving/checklist work. Modeled as
      // transitions (not left as bare existence checks) so every route goes
      // through transition(), per the design doc.
      if (state !== STATES.WALKTHROUGH_IN_PROGRESS) {
        throw new IllegalTransitionError(state, event);
      }
      return result(state);
    }

    case EVENTS.COMPLETE_ROUND: {
      if (state !== STATES.WALKTHROUGH_IN_PROGRESS) {
        throw new IllegalTransitionError(state, event);
      }
      const { unconfirmedChecklistCount = 0, force = false, commentCountThisRound = 0 } = payload;
      if (unconfirmedChecklistCount > 0 && !force) {
        throw new GuardFailedError(state, event, "unconfirmed_checklist");
      }
      // No comments this round means nothing for a change job to do —
      // Jay is satisfied as of this round. Previously this was a judgment
      // call left to the walkthrough skill's prose ("If the round has no
      // comments... tell Jay the review is done and stop here"); the FSM
      // now makes it structural.
      if (commentCountThisRound === 0) {
        return result(STATES.APPROVED, { effects: ["notify_pearl_review_approved"] });
      }
      return result(STATES.AWAITING_CHANGE_JOB);
    }

    case EVENTS.RESOLVE_COMMENT: {
      if (state === STATES.AWAITING_CHANGE_JOB) return result(STATES.CHANGES_IN_PROGRESS);
      // Every resolution after the first is a no-op on `status` — the
      // change job stays in CHANGES_IN_PROGRESS while it works the rest of
      // the round's comment queue.
      if (state === STATES.CHANGES_IN_PROGRESS) return result(state, { noop: true });
      throw new IllegalTransitionError(state, event);
    }

    case EVENTS.ADVANCE_ROUND: {
      if (state === STATES.ROUND_READY) {
        // Calling the `next` route twice (the change job retries after a
        // crash, or Jay pokes it by hand) must be safe — the round it
        // already computed doesn't change and nothing is notified twice.
        return result(state, { noop: true });
      }
      // AWAITING_CHANGE_JOB is legal here too, not just CHANGES_IN_PROGRESS:
      // it's reached only when a round has at least one comment and none of
      // them has been resolved yet (zero comments short-circuits straight
      // to APPROVED in COMPLETE_ROUND), so openCommentCount is always > 0
      // there — the guard below fails it the same way it would from
      // CHANGES_IN_PROGRESS, with the same open_comments detail, rather
      // than an opaque "illegal from this state".
      if (state !== STATES.CHANGES_IN_PROGRESS && state !== STATES.AWAITING_CHANGE_JOB) {
        throw new IllegalTransitionError(state, event);
      }
      const { openCommentCount = 0, workingTreeClean = true } = payload;
      if (openCommentCount > 0) {
        throw new GuardFailedError(state, event, "open_comments");
      }
      if (!workingTreeClean) {
        throw new GuardFailedError(state, event, "dirty_working_tree");
      }
      // The transition this whole redesign is for: the round's diff is
      // materialized, but nobody has started walking it yet. Notifying
      // Pearl is the side effect, not an optional courtesy left to the
      // dispatched agent's own end-of-job report (see
      // notifyReviewRoundReady in review.js) — that's what the old
      // "flip status back to walkthrough and hope someone notices" gap was
      // actually missing.
      return result(STATES.ROUND_READY, { effects: ["notify_pearl_round_ready"] });
    }

    case EVENTS.DISPATCH_WALKTHROUGH: {
      // Idempotent like ADVANCE_ROUND: round 1's first-ever dispatch (or a
      // retry of any round's dispatch after a crash) may land while the
      // walkthrough is already running — that's a no-op, not an error.
      if (state === STATES.WALKTHROUGH_IN_PROGRESS) return result(state, { noop: true });
      if (state !== STATES.ROUND_READY) throw new IllegalTransitionError(state, event);
      return result(STATES.WALKTHROUGH_IN_PROGRESS);
    }

    case EVENTS.ABANDON: {
      if (state === NONE || TERMINAL.has(state)) throw new IllegalTransitionError(state, event);
      return result(STATES.ABANDONED);
    }

    default:
      throw new IllegalTransitionError(state, event);
  }
}

export function isTerminal(state) {
  return TERMINAL.has(state);
}

// Old on-disk session.json only ever recorded three strings in `status`.
// "walkthrough" collapses two states the new machine tells apart (a round
// actively being walked vs. one just sitting computed, ready to be
// picked up) — see the module doc comment above for why ROUND_READY, not
// WALKTHROUGH_IN_PROGRESS, is the correct read of old data: nothing in the
// old format ever recorded that a walkthrough job had actually started, so
// "status: walkthrough" always meant "ready for one," never "one is
// running." DISPATCH_WALKTHROUGH is what now draws that line going
// forward.
const LEGACY_STATUS_MIGRATION = Object.freeze({
  walkthrough: STATES.ROUND_READY,
  awaiting_changes: STATES.AWAITING_CHANGE_JOB,
  changes_in_progress: STATES.CHANGES_IN_PROGRESS,
});

// Idempotent: a session already on the new `state` field is returned as
// is; a legacy `status`-only session is mapped once. Safe to call on every
// read (start equals recover) rather than as a one-shot migration script.
export function migrateLegacySession(session) {
  if (!session) return session;
  if (session.state && Object.values(STATES).includes(session.state)) return session;

  const migrated = LEGACY_STATUS_MIGRATION[session.status];
  if (!migrated) {
    throw new Error(`Cannot migrate review ${session.id}: unknown legacy status ${session.status}`);
  }
  return { ...session, state: migrated };
}
