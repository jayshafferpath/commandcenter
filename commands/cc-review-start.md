---
description: Start a new review-loop review, or dispatch the next round's walkthrough for one that's already round_ready. Use when Jay asks to review a branch or PR with the interactive review loop, or says to go ahead and start the next round.
---

# Command Center: start a review round

Covers the two transitions nothing else wraps in a skill:
`START_REVIEW` (a brand-new review) and the first `DISPATCH_WALKTHROUGH`
for whichever round is current — round 1 for a fresh review, or round
*N+1* once a change job has advanced an existing one. Use the API base
from your briefing (default `http://localhost:3789`).

## New review: repo + base branch, no id yet

```bash
curl -s -X POST "$API/api/review/start" -H 'Content-Type: application/json' \
  -d '{"repo": "<absolute path>", "baseBranch": "<branch, usually main>", "prUrl": "<optional>"}'
```

- `repo` must be an absolute path to an existing checkout, already on the
  branch Jay wants reviewed.
- A 400 with `"Repo not found: ..."` means the path is wrong — don't
  guess one, ask Jay.
- A 400 with `"No changes between <baseBranch> and HEAD..."` means
  there's nothing to review — tell him and stop.

Success gives you `{id, round: 1}`. Keep the `id` — you need it next.

## Existing review: just an id

If Jay names a review that's already sitting `round_ready` (from a change
job's "round *N+1* is ready" notification, or `GET /api/review` if you
need to find the id), skip straight to dispatching — there's no `start`
call to make for a round that already exists.

## Either way: dispatch the walkthrough

```bash
curl -s -X POST "$API/api/dispatch" -H 'Content-Type: application/json' \
  -d '{"prompt": "/cc-review-walkthrough", "context": {"type": "review", "id": "<id>", "role": "walkthrough"}, "mode": "interactive"}'
```

This is what actually fires `DISPATCH_WALKTHROUGH` — the review has to be
`round_ready` for it to succeed. A 400 here means it wasn't (already being
walked, or the review has moved on to `approved`/`abandoned`); relay
whatever the response says rather than retrying blind. A 409 means a
walkthrough job for this review is already running — report its `jobId`
instead of starting a second one.

It must be `mode: "interactive"` — Jay needs to actually talk to this
session to leave comments. Once it's running, see `/cc-dispatch` for how
to open a terminal into it; tell him the job's id and that it's waiting
for him.

Everything after this point — comments, checklist, closing the round,
the change job, the next round's `round_ready` notification — happens on
its own per `/cc-review-walkthrough` and `/cc-review-changes`. You don't
need to do anything further here until the next round's notification
tells you a fresh `round_ready` is waiting.
