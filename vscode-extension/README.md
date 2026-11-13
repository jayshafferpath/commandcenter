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
- `commandCenter.sessionId` — the review/walkthrough id to connect to.
  Phase A has no automatic handoff for this yet (that lands once the
  review-loop work this plan builds on merges), so set it by hand in VS
  Code's settings to smoke-test.

## Manual smoke checklist

No automated test covers this file or `extension.js` — there's no VS Code
extension host in this repo's test runner (see `tests/vscode-extension-*`
for what *is* covered: the pure decoration/follow-state math). Run through
this by hand after any change here:

1. **Connect** — set `commandCenter.sessionId`, reload the window, confirm
   the status bar shows "Pair Pal: Following" and no connection warning
   appears.
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
6. **Reconnect after restart** — reload the VS Code window with the same
   `sessionId` still set; confirm it reconnects and resumes receiving
   commands without needing the extension reinstalled.
