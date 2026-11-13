---
description: Work through Jay's comments from a closed review round, make the changes, commit once, and open the next round. Use when you were dispatched with review context to address a review-loop round's comments.
---

# Command Center: review changes

You're the change agent for one round of an interactive review loop. Your
prompt names the review id and round, and you're running in the review's
repo. Use the API base from your briefing (default `http://localhost:3789`).

This review is a state machine (`.plans/interactive-review-loop.md`'s
"State machine" section, implemented in `api/lib/review-fsm.js`). Every
route below fires a named event server-side; your job is to call them in
order and act on what they return, not to track the review's lifecycle
yourself.

## Load the comments

```bash
curl -s "$API/api/review/$ID"                # session: repo, currentRound, rootBaseSha
curl -s "$API/api/review/$ID/round/$N"       # round N: chunks and comments
```

Work every comment with `status: "open"` from round N. Each has `file`,
`line`, and `text`: what Jay wants, in his words. Before changing anything,
read the comment's file around its line, and skim the whole feature
(`git log <rootBaseSha>..HEAD`, `git diff <rootBaseSha>..HEAD`) so a fix
fits the branch, not just the one line.

## One comment at a time

**If you agree**, make the change, then record it:

```bash
curl -s -X POST "$API/api/review/$ID/comments/<commentId>/resolution" \
  -H 'Content-Type: application/json' \
  -d '{"status": "resolved", "note": "<what you changed, one or two sentences>", "files": ["src/path/one.ts"]}'
```

`files` lists every repo-relative path you touched for this comment,
exactly as git reports them. The next round uses it to match each changed
file back to the comment that caused it. A file you change that no
resolution names shows up there as "not tied to a comment."

This fires `RESOLVE_COMMENT`: the first resolution in the round moves the
review from `awaiting_change_job` to `changes_in_progress`; every
resolution after that is a no-op on the review's state (you're still the
one job working the queue). You don't need to read or report this state
yourself — it's what lets `next` (below) tell whether you're actually
done.

**If you disagree, stop and ask Jay. Never decline a comment on your
own.** Bring your terminal to the front and tell him out loud:

```bash
curl -s -X POST "$API/api/jobs/<your job id>/open-terminal"
curl -s -X POST "$API/api/voice/<your job id>/speak" -H 'Content-Type: application/json' \
  -d '{"text": "I need your call on a review comment."}'
```

Your job id is at the end of your prompt. Then lay out the comment, what
you'd do instead, and why, in a few sentences, and wait. He'll tell you to:

- **Do it anyway**: make the change and record it `resolved`.
- **Push back**: record `pushed_back`, with a note giving the reasoning he
  agreed to and `files: []`.
- **Something else**: do what he says, then record whichever status fits.

Stay in scope. Change only what the comments ask for. No opportunistic
refactors, no "while I was in here" cleanups. If you spot something worth
fixing that no comment asks for, mention it in your report instead.

## Verify, commit once, open the next round

When every comment from round N is resolved or pushed back:

1. Run the repo's own verification, as its `CLAUDE.md` defines it (tests,
   lint, build). Fix what your changes broke. If something fails that your
   changes didn't cause, say so in your report rather than fixing it.
2. Make **one** local commit for the round:
   ```
   Review round N: address comments

   cm_…: <one line on what changed>
   cm_…: pushed back, <one line on why>
   ```
   Skip the commit if every comment was pushed back and nothing changed.
   Never push. Never amend. Never skip hooks; if one fails, fix the cause
   and make a new commit.
3. Open the next round — this fires `ADVANCE_ROUND`:
   ```bash
   curl -s -X POST "$API/api/review/$ID/round/$N/next"
   ```
   It refuses while any round N comment is still open, or while the working
   tree has uncommitted changes. The response lists what's wrong. Calling it
   twice is safe (the second call is a no-op: you'll get back
   `alreadyExisted: true` and no `effects`).

4. **The response's `effects` array is not optional background — it's the
   fix for the exact gap this state machine replaced.** A successful call
   returns
   `effects: [{"type": "notify_pearl_round_ready", "message": "Review $ID
   round N+1 is ready to walk (<repo>)."}]`. Previously, telling the
   supervisor that the next round existed was left to this step's own
   end-of-job courtesy report — which is exactly how round 2 of a real
   review sat unnoticed until Jay happened to go looking. Now it's a
   required step, not a courtesy:

   - Say the effect's `message` out loud through the voice route.
   - Send that same message to the supervisor via `SendMessage`
     **before** your `/cc-report` wrap-up, as its own explicit statement —
     not folded into a generic "I'm done" report where it can get lost.
     Include it even if `/cc-report` also covers your overall status.

   If `effects` is empty (shouldn't happen on a successful `next` call —
   say so in your report if it does), you don't owe a round-ready
   notification, but you should never *skip* sending one when `effects`
   names one.

5. Report to the supervisor (`/cc-report`): how many comments you resolved
   and pushed back, the commit sha, and anything you noticed but left
   alone.
