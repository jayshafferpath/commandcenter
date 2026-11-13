# Pair Pal

A local VS Code extension that shows the Command Center agent's own
presence in your editor — a labeled, colored caret and selection, separate
from your real cursor — while it walks you through a review. See
`.plans/vscode-walkthrough-bridge.md` for the full design.

**Phase A (this build):** agent presence (caret/selection decorations) and
follow-the-agent (your viewport scrolling to keep the agent's position
visible). Nothing here ever calls `editor.selection = ...` or otherwise
touches your real cursor, selection, or focus — only decoration APIs, which
are purely visual.

Not yet built: agent-follows-you (Phase B) and inline comment threads
(Phase C).

## Install

Never installed by default. From the repo root:

```
./install.sh --vscode-ext
```

This builds a local `.vsix` with `vsce package` (nothing is published to
the Marketplace) and installs it with `code --install-extension`. To do it
by hand instead:

```
cd vscode-extension
npm install
npx vsce package --out pair-pal.vsix
code --install-extension pair-pal.vsix
```

## Configuration

- `commandCenter.apiUrl` — base URL of the local Command Center API.
  Defaults to `http://localhost:3789`.
- `commandCenter.sessionId` — optional override. Leave it empty for
  normal use: Pair Pal finds the review itself (see below). Set it to force
  a specific review id, which skips discovery entirely.

## How it finds the review

With no `sessionId` set, Pair Pal polls `GET /api/vscode/discover?repo=<the
workspace's first folder>` every couple of seconds. The API answers with
the one review whose state is `walkthrough_in_progress` and whose `repo`
matches that folder, and Pair Pal connects to it on its own.

- **No match**: stays idle and keeps checking.
- **Several matches** (two walkthroughs on one repo): connects to none,
  logs the candidate ids to the "Pair Pal" output channel (and the API
  logs a warning). Set `commandCenter.sessionId` to pick one.
- **Walkthrough ends** (round completed, review abandoned, session gone):
  disconnects and clears the agent's decorations within one long-poll
  cycle (~25s; the walkthrough skill's own `clear` usually removes them
  first), then goes back to waiting for the next one.

Nothing is ever written into the reviewed repo to hand off the id. A
`.vscode/settings.json` there would dirty the tree, and the review loop
refuses to advance a round on a dirty tree.

Until discovery connects, the agent's `move` calls 404, so the first
element or two of a walkthrough can go by without a presence marker. The
`code --diff`/`--goto` fallback still opens each one.

## Manual smoke checklist

No automated test covers this file or `extension.js` — there's no VS Code
extension host in this repo's test runner (see `tests/vscode-extension-*`
for what *is* covered: the pure decoration/follow-state math). Run through
this by hand after any change here:

1. **Connect (discovery)** — with `commandCenter.sessionId` empty, open
   the reviewed repo and dispatch a walkthrough for it; confirm the "Pair
   Pal" output channel logs "Connected to review <id>" within a few
   seconds, the status bar shows "Pair Pal: Following", and `git status`
   in the repo is still clean.
1a. **Connect (override)** — set `commandCenter.sessionId`, reload the
   window, confirm it connects with no connection warning.
1b. **Ambiguous** — with two walkthroughs in progress for the same repo,
   confirm the output channel logs both ids once and nothing connects.
2. **Move + follow on** — `POST /api/vscode/<id>/move` with a file/line in
   the open workspace; confirm the file opens (or switches to), a violet
   caret + nameplate renders at the position, a violet-wash selection
   renders over the range, and the viewport scrolls to reveal it.
3. **Move + follow off** — click the status bar item to toggle follow off,
   send another `move`; confirm the decoration still updates but the
   viewport does *not* scroll, and your own cursor/selection are
   untouched throughout.
4. **Pointer clears on next move** — send a `move` to a different
   location; confirm the old decoration is gone, not just overlapped.
5. **Clear** — `POST /api/vscode/<id>/clear`; confirm all decorations
   disappear from every visible editor.
6. **Disconnect on end** — complete the round (or abandon the review);
   confirm the output channel logs the disconnect within ~25s and no
   decorations remain.
7. **Reconnect after restart** — reload the VS Code window mid-walkthrough
   (discovery mode, or with the same `sessionId` set); confirm it
   reconnects and resumes receiving commands without needing the
   extension reinstalled.
