---
description: Walk Jay through a diff element by element in VS Code, with a checklist, capturing his comments, then hand the round to a change agent. Use when you were dispatched to run an interactive review-loop walkthrough round.
---

# Command Center: review walkthrough

You're running one round of an interactive review loop. Your prompt names a
review id and, usually, a round number (default to the review's
`currentRound` if none is given). Use the API base from your briefing
(default `http://localhost:3789`).

You walk Jay through the diff and capture what he wants changed. You don't
make changes yourself: when the round closes, you dispatch a change agent
(`/cc-review-changes`) that works his comments and opens the next round.

**Be concise throughout.** Per-element narration (see below) is a sentence
or two — what changed and why it matters — not a walk through every line or
a restatement of the diff he can already see open in VS Code. Don't pad
with "let me know if..." or recap what you just did; state it once and hand
back to him.

**Narrate as an independent reviewer, in the third person — never as the
code, in the first person.** You're describing what the code does to Jay,
not speaking as the function. Wrong: "if you send me a UUID, then this
will happen." Right: "if the caller sends a UUID, the handler does X."
This applies to every narration below, spoken or posted.

**One element at a time, confirmed directly with Jay** — not a whole-file
summary dumped in one message. Within a chunk, identify its distinct
elements (a function, a class, a logical section — your judgment on the
right granularity for this file) and walk through them one at a time: jump
VS Code to that specific element's line (not just the chunk's
`firstChangedLine`), explain only that element, and wait for his reaction
before moving to the next one. A chunk is a unit of state (one checklist,
one completion status); an element is a unit of conversation. Don't
collapse the two.

**Read every element in the context of the whole feature branch, not just
this round's own incremental diff.** A round's own diff (its `baseSha` to
`headSha`) only ever shows what changed since the *previous* round — on a
multi-round, multi-commit feature, that's a narrow slice. The session
itself holds `rootBaseSha` (`GET /api/review/$ID` → `session.rootBaseSha`),
the whole branch's actual starting point, specifically so you — even a
freshly dispatched round with no memory of earlier ones — can always pull
the full picture:
```bash
git -C "<repo>" log <session.rootBaseSha>..HEAD --oneline
git -C "<repo>" diff <session.rootBaseSha>..<round.headSha>
```
Use this to understand how the piece in front of you fits the feature as a
whole before you narrate it — don't read an element as if it were an
isolated one-commit change when it's actually step 6 of 11. That said, keep
narrating one element at a time, concisely (see above): bring in the
feature-level framing only when it actually changes how the element should
be read, same judgment call as caller context, below.

**Pull in caller/related-code context when it's worth it, not by default.**
An element's own diff doesn't show what happens to its output elsewhere —
sometimes that matters (a return value that drives a routing or
authorization decision downstream, a changed signature every caller now
has to match) and sometimes it genuinely doesn't. Always pull it in when
Jay asks. Otherwise, use judgment: if tracing a value forward (`grep` for
callers, follow it through the files it touches) surfaces something
non-obvious that changes how the element should be read, say so — briefly,
the same few-sentence budget as the element itself, not a second full
narration. Don't do this reflexively for every element; most don't need it.

## Load the round

Being dispatched with `role: "walkthrough"` already fired this review's
`DISPATCH_WALKTHROUGH` event server-side — the round you're about to walk
moved from merely computed (`round_ready`) to actively in progress
(`walkthrough_in_progress`) the moment your job started, not when you
personally do anything. Nothing for you to call here; it's background for
why `completeRound`'s guards behave the way they do below.

```bash
curl -s "$API/api/review/$ID/round/$N"
```

Returns `{round: {round, baseSha, headSha, chunks, completedAt}, comments}`.
Each chunk has `file`, `firstChangedLine`, `diff` (that file's own diff
text), `status`, and a generic `checklist` (read it, confirm it does what
it's supposed to, check for missed edge cases/tests — not diff-aware yet,
that's a later phase).

If `round.completedAt` is already set, this round is closed — don't take
new comments on it. Tell Jay; its change agent either is running or has
already opened the next round (`GET /api/review/$ID` → `currentRound`).

## Round 2 and later: outcomes first

A round after the first is the diff since the previous round, plus
`outcomes`: every comment from that round with its `status` (`resolved` or
`pushed_back`), the change agent's `note`, and the `files` it touched. Each
chunk carries `addressedComments` (which comments it implements) and
`untraced` (true when no comment claims it).

Before grouping or walking chunks, take the outcomes one at a time:

- **Resolved**: open the changed file at the change (same diff view as
  below, against this round's `baseSha`), say in a sentence how it was
  addressed, and wait for his reaction.
- **Pushed back**: Jay already agreed to this with the change agent, so
  just restate the comment and the reasoning in a sentence, so the record
  is in front of him while he reviews the rest.

If he isn't satisfied with an outcome, leave a new comment on this round
(see Capturing a comment); the next change agent picks it up. Don't reopen
the old one.

Then walk the chunks as usual. A chunk you already covered through its
outcome needs only its checklist. Call out every `untraced` chunk
explicitly: "this changed, but no comment asked for it." Those are the
changes most worth his attention.

If the round has no chunks (everything was pushed back) and no outcome
draws a new comment, the loop is done; tell him so.

## Group the round before walking it

Don't walk chunks in file order. Before the first chunk, read the round's
files and propose groups by logic and data flow: shared foundations first,
then each path the feature adds followed through its files in the order
data moves (e.g. poller → capture → unpack → dispatch), then failure
handling, then wiring and infrastructure, with incidental churn (lockfiles,
lint/tsconfig tweaks) last. Put a test file in the same group as the source
file it covers, right after it. Within a group, order the chunks the way
you'll walk them.

Save it (the order of `groups`, and of `chunkIds` inside each, is the walk
order):

```bash
curl -s -X PUT "$API/api/review/$ID/round/$N/groups" -H 'Content-Type: application/json' \
  -d '{"groups": [{"title": "Inbound path", "rationale": "follows a message from poll to handler", "chunkIds": ["c18", "c21", "c20"]}]}'
```

Every chunk must be in exactly one group. A 400 lists `missing`,
`duplicates`, and `unknown` chunk ids. Fix the grouping and resend it;
don't force a chunk into a group it doesn't belong in just to pass.

Show Jay the groups (title, one-line rationale, file count) before you
start, and reorder or regroup if he asks, then save again. If the round
already has `groups` (you're resuming), use them as they are.

## Walk through one chunk at a time

Walk group by group, and within each group take its chunks in order. When
you start a new group, give one sentence on what it covers before its first
element. For each chunk:

1. Skim the chunk's `diff` and pick out its distinct elements (functions,
   classes, logical sections) in order. Small chunks may have just one —
   that's fine, don't manufacture extra splits.
2. For each element, in order:
   - Open VS Code at that element's own line (not the chunk's
     `firstChangedLine`) — a real diff, not just the file, confirmed with
     Jay as the preferred view. Snapshot the chunk's file as it was at the
     round's `baseSha` into a temp path named for this review + chunk (so
     re-opening the same chunk overwrites rather than piling up files),
     then open VS Code's diff editor against the current file on disk:
     ```bash
     SNAPSHOT_DIR="/tmp/ccenter-review/$ID"
     mkdir -p "$SNAPSHOT_DIR"
     EXT="${FILE##*.}"
     SNAPSHOT="$SNAPSHOT_DIR/${CHUNK_ID}.${EXT}"
     git -C "<repo>" show "<round.baseSha>:<chunk.file>" > "$SNAPSHOT" 2>/dev/null
     if [ -s "$SNAPSHOT" ]; then
       code --diff "$SNAPSHOT" "<repo>/<chunk.file>:<element's line>"
     else
       # New file in this branch — there's no base version to diff against,
       # so a diff view would just show an empty left side. Fall back to
       # opening the file itself at this element's line.
       code --goto "<repo>/<chunk.file>:<element's line>"
     fi
     ```
     `<repo>` is the review's `repo` path and `<round.baseSha>` is the
     round's own `baseSha` (both from `GET /api/review/$ID/round/$N`). This
     is plain VS Code CLI (`code --diff`/`--goto`), not anything
     Claude-specific — it requires the `code` shell command to be on PATH
     (if the command isn't found, say so plainly rather than silently
     skipping the open).

     Alongside it — never instead of it — also tell Pair Pal (the VS Code
     extension, if Jay has it installed) where you are, so its own
     caret/selection decoration follows you without moving his real cursor:
     ```bash
     curl -s -X POST "$API/api/vscode/$ID/move" -H 'Content-Type: application/json' \
       -d '{"file": "<chunk.file>", "startLine": <element's line>}'
     ```
     `file` is repo-relative (same as `chunk.file`), not the absolute path
     you pass to `code`. Fire this unconditionally, same as the `code` call
     above: if Pair Pal isn't installed or connected, this just 404s and
     has no visible effect — don't treat that as an error or skip the
     `code --diff`/`--goto` call waiting on it. You don't hand Pair Pal
     this review's id: it finds this walkthrough on its own (it polls for
     the in-progress walkthrough matching the repo open in VS Code), so
     the first move or two can 404 while it connects. Never write a
     `.vscode/settings.json` or anything else into the repo to help it
     along — that dirties the working tree, and the change agent's
     `ADVANCE_ROUND` refuses a dirty tree.
   - Explain only that element, in a sentence or two, in your own words —
     don't paste the diff back at him. Speak it too, right after you post
     it, with the same text — this uses the generic voice capability every
     dispatched agent has (see `/cc-voice`), keyed by this review's own
     `$ID`:
     ```bash
     curl -s -X POST "$API/api/voice/$ID/speak" -H 'Content-Type: application/json' \
       -d '{"text": "<the narration you just gave>"}'
     ```
     Unlike most agents (for whom voice is opt-in, see `/cc-voice`), this
     is on by default here. If Jay says to stop narrating aloud, stop
     calling this route for the rest of the round (no toggle to flip, just
     honor the request). If he says to stop mid-utterance:
     ```bash
     curl -s -X POST "$API/api/voice/$ID/hush"
     ```
   - Wait for his reaction before moving to the next element. **If he
     leaves a comment, stay on this element after recording it** —
     acknowledge what you captured, and respond or ask a follow-up if
     there's something worth clarifying. Don't advance until he explicitly
     says to: "next", "continue", "looks good", or anything else that
     plainly means move on. A comment is not itself that signal — he may
     have more to say about the same element.
3. Once every element in the chunk has been through that loop, name the
   chunk's checklist items in one line (don't invent extra ones in this
   phase; they're intentionally generic) and confirm each:
   ```bash
   curl -s -X POST "$API/api/review/$ID/round/$N/checklist/<checklistId>/confirm"
   ```
   A comment left on one of its elements doesn't replace confirming the
   checklist — confirm it regardless once the chunk's elements are covered.
4. Move to the next chunk. He may also ask to go back to an earlier
   chunk or element — that's fine, nothing here is strictly ordered.

Don't dump a whole chunk — let alone a whole file — into one message. One
element, his reaction, then the next — that's the point of the loop.

## Capturing a comment

When Jay says what he wants changed about something you just showed him,
record it immediately — don't wait until the end of the round and try to
reconstruct it from memory:

```bash
curl -s -X POST "$API/api/review/$ID/round/$N/comments" \
  -H 'Content-Type: application/json' \
  -d '{"chunkId": "<chunkId>", "file": "<file>", "line": <line>, "text": "<what he said>"}'
```

- `text` should capture what he wants to happen, in his words where
  possible — not your interpretation of it. The change agent acts on this
  text directly; a vague paraphrase here costs more later than it saves
  now.
- `line` is optional — use the specific line he's pointing at if you have
  one, otherwise the chunk's `firstChangedLine` is fine.
- Confirm back to him what you recorded in one line, so he can correct it
  immediately if you got it wrong.

## Ending the round

This review is a state machine (`.plans/interactive-review-loop.md`'s
"State machine" section, implemented in `api/lib/review-fsm.js`) — every
route below is a named event, not a flag you're setting. You're not
tracking the review's lifecycle yourself; you're firing events and reading
back whatever state they land on.

When Jay says he's done reviewing for this round (listen for something
like "that's it for now" / "send it" / "I'm good with this round" — there's
no fixed phrase yet, see the design doc's open question #4), fire
`COMPLETE_ROUND`:

```bash
curl -s -X POST "$API/api/review/$ID/round/$N/complete"
```

If it comes back `{ok: false, error: "N checklist item(s) not confirmed
yet", unconfirmed: N}`, either go back and confirm the remaining items, or
— only if Jay explicitly says to skip them — retry with
`{"force": true}`.

Read the response's `session.state`, not whether the round had comments
yourself:

- **`approved`** — the round had no comments, so `COMPLETE_ROUND` went
  straight to the terminal `approved` state (the FSM does this, not a
  judgment call you make). Tell Jay the review is done and stop here.
  There's nothing to dispatch.
- **`awaiting_change_job`** — the round had at least one comment. Dispatch
  the change agent, which fires `RESOLVE_COMMENT` (and later `ADVANCE_ROUND`)
  on your behalf:

  ```bash
  curl -s -X POST "$API/api/dispatch" -H 'Content-Type: application/json' \
    -d '{"prompt": "/cc-review-changes", "context": {"type": "review", "id": "'"$ID"'", "role": "changes"}, "mode": "interactive"}'
  ```

  It must be `interactive`: the change agent stops to ask Jay before it
  pushes back on any comment. A 409 means a change agent for this review is
  already running; report its `jobId` instead of starting another.

Either way, this walkthrough job is ending — clear Pair Pal's presence
marker so it doesn't linger after the conversation moves on (same
no-op-if-not-connected caveat as above, fire it unconditionally):

```bash
curl -s -X POST "$API/api/vscode/$ID/clear"
```

Tell Jay in one line what happened (approved and done, or the change agent
is working — it will speak up if it needs him), then report to the
supervisor with `/cc-report`.
