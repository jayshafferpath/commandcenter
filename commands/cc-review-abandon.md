---
description: Abandon a review-loop review and close any job still running for it. Use when Jay says to drop a review without shipping it.
---

# Command Center: abandon a review

Fires `ABANDON` — legal from any state except the two terminal ones.
Use the API base from your briefing (default `http://localhost:3789`).

```bash
curl -s -X POST "$API/api/review/<id>/abandon"
```

- 404 means the review id is unknown — double check it rather than
  guessing.
- 400 with `code: "ILLEGAL_TRANSITION"` means it's already `approved` or
  `abandoned` — tell Jay which, and that there's nothing to do.
- 200 `{ok: true}` means it's done.

## Close any job still running for it

Abandoning doesn't stop a walkthrough or change job that's actively
running against this review — do that yourself, so nothing keeps working
on something Jay just dropped:

```bash
curl -s "$API/api/jobs" | jq -r --arg id "<id>" \
  '.jobs[] | select(.reviewId == $id and (.status == "running" or .status == "needs_input")) | .id'
```

For each id that comes back:

```bash
curl -s -X POST "$API/api/jobs/<jobId>/close"
```

Tell Jay the review is abandoned and name any job you closed for it.
