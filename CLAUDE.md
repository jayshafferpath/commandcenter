# CLAUDE.md

Personal focus dashboard: Jira tickets, todos, open PRs, and live agent
sessions, with per-ticket agent dispatch and the Pearl supervisor agent.
See README.md for setup, architecture, and feature docs.

## Commands

- `npm run dev` — API on 3789 (`node --watch`) and Vite on 5173
- `npm test` — Vitest. On Node 20.5 the default pool crashes before running
  anything; use `npx vitest run --pool=threads`.
- `npm run build` — Vite build of `ui/`

## Layout

- `api/server.js` — every REST route lives here
- `api/pearl.js` — Pearl's tmux session and her briefing
- `api/run-command.js` — dispatched agents as tmux-backed jobs
- `api/brain.js` — Brain View canvas storage under `~/.commandcenter/brain/`
- `api/pearl-speak.js` — Pearl's Stop-hook speech and push-to-talk input
- `api/lib/` — Jira client (`jira.js`), lifecycle labels (`labels.js`,
  canonical), config/env loading, PR and Slack helpers
- `ui/src/` — React dashboard, one component per column
- `commands/` — Claude Code commands symlinked into `~/.claude/commands` by
  `install.sh`; dispatch depends on `/automodel` resolving
- `tests/` — Vitest, covering `api/` and the pure parts of `ui/`

## Conventions

- ES modules throughout (`"type": "module"`). One-off Node snippets need
  `node --input-type=module -e` with `import`, not `require`.
- Comments explain why — design history, a rejected approach, a race being
  avoided. Match that density; don't narrate what the code does.
- Write actions (dispatch, Pearl, closing a live session, Slack posts) are gated
  on `DASHBOARD_ALLOW_ACTIONS=true` via `isExecutionEnabled()`. Gate any new
  write action the same way.
- macOS only: tmux for every session, `osascript` to open iTerm2.

## Pearl

- `SOUL.md` holds her personality and preferences; the technical briefing
  lives in `briefing()` in `api/pearl.js`. Keep personality out of code and
  mechanics out of SOUL.md.
- The briefing must stay a single line (it's passed as the `claude` prompt
  argument, and `tests/pearl.test.js` asserts no newlines).
- When you add or change an API route Pearl should use, update the
  briefing's endpoint list in the same change.
- Briefing and SOUL.md edits only reach her after a restart (↻ in the
  dashboard, or `POST /api/pearl/refresh`).
- Her session is pinned to Opus in `auto` permission mode and named
  `PEARL_NAME` so dispatched agents can `SendMessage` her.

## Gotchas

- If an older API server still holds port 3789, `npm run dev` serves the UI
  against the stale server and new routes 404. The server prints the
  `lsof`/`kill` recipe on `EADDRINUSE`.
- Push-to-talk must only ever use a local-only Superwhisper mode. See
  `.plans/push-to-talk-wispr.md` before touching `pearl-speak.js` voice
  paths or `hammerspoon/pearl-ptt.lua`.
