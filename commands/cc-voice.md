---
description: Speak text aloud through the same say/relay mechanics Pearl uses. Use when you were dispatched by Command Center and want to say something out loud, not just in chat.
---

# Command Center: voice

When Command Center dispatches you, your prompt names a voice endpoint
keyed by this session's own id (usually your `jobId`, or a review's `id`
if you're a review-walkthrough round). Use the API base from your briefing
(default `http://localhost:3789`).

## Whether to use it

It's optional, and most sessions never touch it — like Brain View, nobody
notices if you never call it. Reach for it when hearing something matters
more than reading it: a long-running task finishing while the user's away
from the screen, a question you want to make sure lands, or (as
`/cc-review-walkthrough` does) narration meant to run alongside a visual
walkthrough rather than compete with it in the same window.

Don't use it to narrate routine progress ("now running tests") — that's
what your terminal output is for.

## Speak

```bash
curl -s -X POST "$API/api/voice/<id>/speak" -H 'Content-Type: application/json' \
  -d '{"text": "whatever you want said"}'
```

Long text is condensed to one short spoken line automatically (same
pipeline Pearl's own replies go through) — send your real text, don't
pre-shorten it yourself.

macOS only. A 400 with `"Voice only works on macOS"` means exactly that;
don't retry it.

## Stop it mid-utterance

```bash
curl -s -X POST "$API/api/voice/<id>/hush"
```

## Picking `<id>`

Any id you already have for this session works — your `jobId` if you're a
plain dispatched job, a review's own `id` if you're a review-walkthrough
round. It only needs to be unique to you: a different id gets its own
independent voice, so two sessions speaking around the same time never cut
each other off. Don't reuse someone else's id on purpose.
