# VS Code walkthrough bridge (agent ↔ editor)

## Status (2026-11-13)

Design only — no code. Extends `.plans/interactive-review-loop.md`'s
Phase 3. Revised from this plan's first draft: the extension now simulates
a lightweight, one-way-trust Live Share session — the agent is a second
*participant* with its own presence, not something that drives Jay's
cursor. Jay's real cursor and selection are never touched by any API call;
the agent gets its own labeled, colored caret and selection, rendered
purely as decorations. Live Share itself is still out of scope — no
headless guest client exists, and it raises org policy concerns for a repo
that may contain PHI-adjacent code — this plan borrows the *UX*, not the
product.

Today, `/cc-review-walkthrough` drives VS Code one-way and blind: `code
--diff`/`code --goto` opens a path at a line (a new OS process per call,
fire-and-forget) and the agent has no way to find out what Jay is actually
looking at. This plan adds a small local VS Code extension plus Command
Center API routes so:

1. **Agent presence** — the agent's position and selection render as a
   labeled, colored caret/selection, separate from Jay's own.
2. **Follow mode, both ways** — Jay can follow the agent's position
   (editor auto-scrolls as the agent walks), and the agent can follow
   Jay (file, viewport, and selection streamed to Command Center) so it
   knows where Jay is looking at any moment.
3. **Pointing** — the agent marks a block of code without moving Jay's
   cursor; this replaces the old "highlight" verb outright (see Pointing,
   below — also settles the old TTL question: a pointer clears on the
   agent's next move, no timer).
4. **Inline comment threads** — review-loop comments render in the file
   via VS Code's Comments API, with replies flowing back into the
   review's own comment ledger.

## Transport: still HTTP, upgraded to long-polling (not a websocket)

Re-evaluated given the higher event rate follow mode implies (the agent's
position can change every few seconds while walking; Jay's viewport can
change continuously while scrolling):

1. **Short poll (original draft's choice, 400–600ms fixed interval).**
   Simple, but now the wrong tradeoff: Jay-follows-agent only feels like
   "following" if the editor reacts close to instantly when the agent
   moves, and a fixed interval adds visible lag to every move.
2. **Long poll (hanging `GET`).** The extension's `GET
   /api/vscode/:id/commands` call blocks server-side (Fastify just delays
   the reply) until either a new command/comments-version lands or ~25s
   elapses, then the extension immediately re-issues it. Near-instant
   delivery of agent moves, still plain HTTP, still zero new npm
   dependencies, still the same "extension is a client of `api/server.js`,
   nothing listens on Jay's machine but the one Fastify server" shape
   every other Command Center capability already uses.
3. **WebSocket.** Lower latency still, but `package.json` has no `ws`/
   `@fastify/websocket` today, and adding one means reconnect/heartbeat
   logic in both the extension and the API that a hanging GET doesn't
   need (an HTTP request that times out just gets reissued — no socket
   lifecycle to manage). The actual latency gap between "hanging GET,
   ~25s cap" and "websocket" is in practice close to zero for this
   feature: agent moves are bursty-but-sparse (once per element, every
   several seconds), not a continuous stream, and the one genuinely
   continuous signal — Jay's viewport while scrolling — is the
   editor→agent direction, which is push-on-change from the extension
   anyway (not something it has to wait on a socket to receive).

**Recommendation: long poll.** It directly answers the latency concern
that motivated re-evaluating transport at all, without taking on a new
dependency or a connection-lifecycle problem. Revisit websocket only if a
long-poll in daily use still feels laggy — nothing below is hard to
migrate off HTTP later, since the extension and API both already treat
"the current command" as a single piece of state, not a stream.

Editor→agent pushes (`PUT /api/vscode/:id/state` for viewport/selection)
stay a simple immediate `PUT` on change, debounced client-side (~150ms for
selection, ~300ms for viewport — viewport fires much more often during a
scroll fling) — this direction was already push, not poll, and doesn't
need the long-poll change.

## State storage: same shape as `review.js`, one more file per review

New `api/vscode.js`, parallel to `brain.js`/`voice.js`:

```
~/.commandcenter/review/<id>/vscode.json
```

```jsonc
{
  "repo": "/Users/jayshaffer/dev/partner-service",
  "connectedAt": "2026-11-13T18:02:00.000Z",
  "lastSeenAt": "2026-11-13T18:04:30.000Z",
  "commentsVersion": 4,                   // bumped by review.js's addComment/resolveComment
  "pendingCommand": {
    "id": "cmd_...",
    "type": "move",                       // "move" | "clear"
    "file": "api/review.js",
    "startLine": 318, "startCol": 1,
    "endLine": 360, "endCol": 1,
    "label": "Pearl",                      // shown on the agent's caret nameplate
    "reveal": true,                        // whether this move should also scroll Jay's viewport (follow mode)
    "createdAt": "..."
  },
  "jayState": {
    "file": "api/review.js",
    "visibleRange": { "startLine": 300, "endLine": 340 },
    "selection": { "startLine": 318, "startCol": 1, "endLine": 360, "endCol": 1 },
    "selectionText": "...",                // capped, see Security
    "updatedAt": "2026-11-13T18:04:30.000Z"
  }
}
```

`pendingCommand` stays a single slot (not a queue), same reasoning as the
first draft: the agent only ever has one current position, and a new
`move` simply overwrites whatever's pending. Renamed from
`reveal`/`highlight` to a single `move` type (see Pointing) plus `clear`
(agent presence removed entirely — used when a round ends or the
walkthrough job finishes). `selection` is renamed `jayState` and gains
`visibleRange`, since follow-the-agent-direction now needs Jay's viewport,
not just his selection.

## 1. Agent presence

The agent gets its own simulated cursor, distinct from Jay's real one,
using `vscode.window.createTextEditorDecorationType` (there is no API to
draw a second *native* text cursor — VS Code has exactly one caret per
editor, and it's the user's):

- **Caret**: a thin colored vertical border decoration at the agent's
  current column, plus an `after` content-text decoration showing the
  agent's label — the literal agent name, e.g. "Pearl" (`PEARL_NAME`,
  settled, not generic "Command Center"), the same visual idea as Live
  Share's remote-participant cursor tag.
- **Selection**: a background-colored range decoration over the agent's
  current `startLine..endLine`, in a color distinct from VS Code's native
  selection highlight so the two are never visually confused.

Both decorations are driven entirely by `pendingCommand` — the extension
never calls any cursor/selection-setting API (`editor.selection = ...`),
only decoration APIs, which are purely visual and have no effect on what
Jay is actually doing in the buffer. This is the core property the redesign
depends on: nothing the agent does can ever move Jay's actual cursor,
change his actual selection, or steal focus.

## 2. Follow mode, both ways

**Jay follows the agent.** A VS Code status bar toggle,
`Command Center: Follow Agent` (default **on** while a walkthrough job is
connected — matches today's behavior where VS Code already jumps to each
element automatically; settled, not open), mirrors
Live Share's own "follow" button. When on, every `move` command the
extension receives also calls `editor.revealRange(range,
TextEditorRevealType.InCenterIfOutsideViewport)` — scrolls Jay's viewport
to keep the agent's position visible, but never touches his selection or
cursor. When off, the decoration still updates (the agent's marker moves)
but Jay's viewport doesn't follow — he can look wherever he wants without
being yanked around, and glance down at the agent's marker whenever he
wants. This toggle state lives client-side in the extension only; it's a
viewing preference, not round state, and isn't reported back to the API.

**The agent follows Jay.** The extension streams `PUT
/api/vscode/:id/state` on every `visibleRange`/`selection` change
(debounced as above). This is always on from the extension's side — it's
cheap and local-only. The agent reads it in two ways: pulled on demand
(`GET /api/vscode/:id/state`) when answering "what about this?", and
**pushed proactively on navigation-away** (settled — see below), not left
to the agent to notice only when it happens to ask.

**Navigation-away detection is active, not just available on request.**
The extension itself compares Jay's current `file` (from
`onDidChangeActiveTextEditor`/`onDidChangeTextEditorVisibleRanges`)
against the file of the agent's own last `move`. When they diverge — Jay
opens a different file, or scrolls far enough that the agent's pointer
decoration is no longer in his visible range — the `PUT .../state` body
sets `divergedFromAgent: true`, and that flag rides back to the agent on
its very next long-poll response (`GET /api/vscode/:id/commands` adds a
`jayDiverged` field alongside `pendingCommand`/`commentsVersion`), not
just whenever the agent happens to pull `jayState` for an unrelated
reason. The walkthrough skill treats a `jayDiverged` flag as a prompt to
actually pause and check in — "looks like you're looking at X now — still
with me on Y, or should I jump to what you're on?" — rather than noting it
silently and plowing ahead; interrupting here is the point, since the
alternative is narrating to someone who's stopped looking. No reciprocal
toggle on this side; this direction was already push/pull from the first
draft, now with an explicit divergence signal instead of relying on the
agent to compare files itself.

## 3. Pointing (replaces "highlight")

A single verb, `move`, covers both "jump to this element" and "point at
this block" — they're the same action (set the agent's position/selection
decoration; follow mode decides whether it also scrolls Jay's view).
There's no separate `highlight` endpoint anymore.

**TTL: cleared on the agent's next move, no timer.** This settles the
first draft's open question #2 per Jay's instruction — a pointer is
exactly as persistent as "the agent is currently looking at this," which
is naturally cleared the moment the agent looks at something else (a new
`move`) or the round/job ends (`clear`). No expiry logic needed in the
extension or the API; "replace on next write" is the whole mechanism.

## 4. Inline comment threads (VS Code Comments API)

The extension registers one `vscode.comments.createCommentController`.
For the **current round's open comments only** (not prior-round outcomes
— those stay narrated in chat, per `interactive-review-loop.md`'s existing
"Round 2 and later: outcomes first" framing, to avoid Jay mistaking a
closed round's resolved thread for something still live), it renders a
native `CommentThread` anchored at each comment's `file`/`line`.

- **Sync, server → extension**: the long-poll response from
  `GET /api/vscode/:id/commands` carries `commentsVersion` alongside
  `pendingCommand`. When it's higher than what the extension last
  rendered, the extension re-fetches the round's comments via the
  existing `GET /api/review/:id/round/:n` (no new comments route — this
  reuses what `/cc-review-walkthrough` already calls) and rebuilds its
  `CommentThread`s. `review.js`'s `addComment`/`resolveComment` bump
  `commentsVersion` on every write, the same way `roundData.groups`
  already gets written in place.
- **Replies, extension → server**: VS Code's Comments API gives each
  thread a native "Reply..." box. The extension's reply handler posts
  straight to the existing `POST /api/review/:id/round/:n/comments` route
  — same shape the walkthrough skill already uses (`chunkId`, `file`,
  `line`, `text`) — so the comment ledger gains no new writer type, just
  one more caller. The extension renders its own reply in the thread
  immediately (it wrote it; no round-trip needed to see your own comment
  appear) while the API remains the system of record.
- Resolved/pushed-back comments don't get a live thread; they're not
  reply-able in-editor by design — re-opening something from a closed
  round happens by leaving a *new* comment (in chat or in a current-round
  thread), same rule the skill already follows today.

## API routes (`api/server.js`, delegating to `api/vscode.js`)

- `POST /api/vscode/:id/connect` — unchanged from the first draft: body
  `{ repo }`, rejects a workspace that doesn't match `session.repo`, sets
  `connectedAt`/`lastSeenAt`.
- `GET /api/vscode/:id/commands` — now a long poll (holds the response
  open, Fastify-side, until a new `pendingCommand`/`commentsVersion`/
  `jayDiverged` lands or ~25s passes). Returns `{ pendingCommand,
  commentsVersion, jayDiverged }`.
- `POST /api/vscode/:id/commands/:cmdId/ack` — unchanged: clears
  `pendingCommand`, guarded by `cmdId` so a late ack can't clear a newer
  command.
- `POST /api/vscode/:id/move` — replaces `reveal`/`highlight`. Body:
  `{ file, startLine, startCol?, endLine?, endCol?, label?, reveal? }`.
  `label` defaults to the session's agent name (`PEARL_NAME`, same value
  Pearl's own tmux session and `SendMessage` address already use) rather
  than a generic "Command Center" tag. `reveal` defaults to `true` (most
  calls are "go look at this"); the
  walkthrough skill can pass `false` for a pure "mark this without moving
  your view" pointer if it ever wants one, though in practice `move`
  with `reveal: true` covers both the original "jump to element" and
  "point at a block" uses from the first draft.
- `POST /api/vscode/:id/clear` — removes the agent's decorations
  entirely (round/job ended). No body.
- `PUT /api/vscode/:id/state` — body now `{ file, visibleRange: {
  startLine, endLine }, selection: { startLine, startCol, endLine,
  endCol }, selectionText, divergedFromAgent }`. Overwrites `jayState`
  wholesale; `divergedFromAgent` is computed client-side by the extension
  (see Follow mode, above) and carried straight through to the next
  long-poll response as `jayDiverged`.
- `GET /api/vscode/:id/state` — returns `jayState` plus
  `connectedAt`/`lastSeenAt` for staleness judgment (unchanged reasoning
  from the first draft).

Comments keep using the existing `review.js` routes unmodified — the
extension is a new *caller* of `GET round` and `POST comments`, not a new
route surface. Every new route 404s on an unknown `:id` the same way every
existing `review.js` route already does.

## Staleness (unchanged from the first draft, applies to `jayState` now)

Same rule: the skill treats `jayState.updatedAt` older than ~2 minutes, or
older than the start of the current element's narration, as probably
stale before answering "what about this?" from it — ask Jay to repoint
rather than guess against code he may not still be looking at.

## Multi-window and wrong-workspace handling (unchanged)

Still one `vscode.json` per review, still last-connect-wins, still a hard
reject (not a silent no-op) on a workspace mismatch at `connect` time,
still no fan-out across windows or reviews — same reasoning as the first
draft, none of it changed by the presence/follow redesign.

## Security (unchanged in substance)

Still localhost-only, no outbound, no new auth beyond `api/server.js`'s
existing same-machine trust model. The one addition: `jayState` now
carries a `visibleRange` (line numbers only, no text) in addition to the
capped `selectionText` snippet — strictly more metadata about *where* Jay
is looking, not more code content, so the PHI-adjacent-repo mitigation
from the first draft (cap the text, never forward it anywhere but the
localhost API, read back only by the agent on the same machine) still
covers it without changes.

## Failure modes when the extension isn't running (unchanged shape)

Same pattern as the first draft, updated for the new verb: the skill
always calls `POST .../move` **and** the `code --goto`/`--diff` fallback
unconditionally — it never waits on the extension to confirm before
falling back. A stale/absent connection means the agent simply has no
presence decoration and no `jayState` to read; "what about this?" degrades
to asking Jay what he means, exactly as it does today. Comment threads
simply don't render — comments still work exactly as they do now, chat-
mediated, through the same API routes.

## Extension packaging and install

**Named "Pair Pal"** (settled — `package.json`'s `displayName`, shown in
the Extensions list and as the VS Code command-palette prefix, e.g. "Pair
Pal: Follow Agent"; the internal `name` field is `pair-pal`). Same
`vscode-extension/` directory, same `vsce package --out pair-pal.vsix`/
`code --install-extension` flow, same lazy activation (workspace has
`.git`, not `"*"`), same `commandCenter.apiUrl` setting defaulting to
`http://localhost:3789`.

`install.sh` gets the new `--vscode-ext` flag, same opt-in style as
`--mcp`/`--ptt`/`--memory`. **Settled: it stays out of `--all` and is never
installed by default** — `--all` enables every *other* optional feature
but explicitly excludes `--vscode-ext`; a comment in `install.sh` next to
the flag definition should say so, so a future edit to `--all` doesn't
silently sweep it in. Installing Pair Pal always requires the explicit
flag, every time.

**No Marketplace publishing required or planned.** `vsce package` builds
a `.vsix` entirely locally; `code --install-extension <path>.vsix`
installs it straight into VS Code from that file. Nothing is uploaded,
listed, or reviewed — Marketplace publishing is a separate, optional step
(publisher account, public listing) only relevant if this were ever meant
for other people to find and install themselves, which it isn't. This
matches `hammerspoon/`'s local-only install pattern already used
elsewhere in this repo.

## `/cc-review-walkthrough` changes

- Replace the old `reveal`/`highlight` instruction with: call
  `POST /api/vscode/$ID/move` (`reveal: true` for the normal "open this
  element" case) **and** keep the existing `code --diff`/`--goto` call as
  the always-run fallback — both fire together, never either/or.
- Add the "what about this?" instruction from the first draft, reading
  `jayState` instead of `selection`, same staleness rule.
- Add a new instruction: when a long-poll response carries
  `jayDiverged: true`, stop narrating and check in before continuing —
  "looks like you're looking at X now — still with me, or should I jump
  to what you're on?" — rather than noting it lightly and plowing ahead.
  This is a deliberate interrupt, not a soft hint; Jay asked for active
  detection specifically so the agent doesn't keep talking to someone
  who's stopped looking.
- Comments: no change to *capturing* a comment server-side (`POST
  .../comments` is unchanged), but the skill no longer needs to narrate
  "I've recorded that" quite as deliberately for comments left via the new
  in-editor reply box, since Jay sees his own reply land in the thread
  immediately — still confirm back in chat for comments he dictates
  verbally, same as today.
- Round start/clear: when a round completes or a walkthrough job ends,
  call `POST /api/vscode/$ID/clear` so the agent's presence marker doesn't
  linger after the conversation moves on.

## Tests (unchanged shape, updated surface)

- `api/vscode.js`: `move`/`clear` state transitions, `cmdId`-guarded ack,
  repo-mismatch rejection, `commentsVersion` bump wiring (a thin call from
  `review.js` into `vscode.js` on `addComment`/`resolveComment`),
  `selectionText` truncation.
- `api/server.js` route tests: 404s, happy paths, the long-poll route's
  early-return-on-new-command behavior (test with a short timeout override
  rather than waiting out the real ~25s).
- No automated test for the extension itself (no VS Code extension host in
  this repo's test runner) — manual smoke checklist in the extension's
  README: connect, move+follow-on, move+follow-off, pointer clears on next
  move, viewport streaming, comment thread render, reply round-trip,
  reconnect after VS Code restart.

## Phased rollout

**Phase A — presence + follow-the-agent.** `move`/`clear` routes, the
long-poll command loop, the caret/selection decorations, the "Follow
Agent" toggle and its `revealRange` behavior, `code --goto`/`--diff`
fallback always still firing. This is the core of what Jay asked for and
ships first.

**Phase B — agent-follows-Jay.** `PUT/GET .../state` with
`visibleRange`, "what about this?" and navigation-away detection wired into
the walkthrough skill. Builds on Phase A's transport and extension
scaffolding; smaller surface on its own.

**Phase C — inline comment threads.** The Comments API controller,
`commentsVersion` sync, reply-to-ledger wiring. Sequenced last: it's the
most new VS Code API surface (and the first draft's original Phase 3
scope), and both presence and follow-mode are independently useful
without it.

**Phase D — polish.** Decoration styling from real use, follow-toggle
tuning, multi-window toast wording. `--vscode-ext` stays a standing
explicit flag (settled — never folds into `--all`), so no action item
here beyond what Phase A already sets up.

No phase is a one-way door: every route is additive to `api/review.js`'s
existing shape, every skill change sits alongside the `code --goto`
fallback rather than replacing it, and uninstalling the extension at any
point drops cleanly back to today's blind-`code`-CLI behavior.

## Open questions for Jay

None remaining — all settled this round: agent label uses the literal
agent name (`PEARL_NAME`, e.g. "Pearl"), Follow Agent defaults **on**
when a walkthrough job connects, no Marketplace publishing is needed or
planned (local `.vsix` sideload only), the extension is named **Pair
Pal** and stays out of `--all` permanently (always an explicit
`--vscode-ext` install), navigation-away is actively detected and
surfaced as an interrupt rather than a soft note, and the caret/selection
color is a fixed violet (below) rather than a theme-derived or
user-configurable one.

**Caret/selection color: violet, `#A371F7`.** Picked over this repo's
other candidate colors deliberately: not blue (VS Code's native selection
and most themes' default accent — would blend in), not red/green (already
load-bearing for diff add/remove, which the walkthrough is showing in the
same window), not yellow/orange (diagnostics and warning squiggles). A
solid `#A371F7` border + nameplate background for the caret, and a ~12%-
opacity wash of the same color (`rgba(163, 55, 247, 0.12)`) for the
selection range, both at mid-tone saturation so they hold contrast against
near-white and near-black editor backgrounds alike — no separate
light/dark variants needed. Not configurable in v1 (no VS Code setting for
it); revisit only if it turns out to clash with Jay's actual theme in
practice.
