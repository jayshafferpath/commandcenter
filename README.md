# Command Center

A personal focus dashboard for Jira ticket work: tickets, personal todos,
open pull requests, and live agent sessions in one window. Each ticket row
can spawn its own Claude Code agent (headless or interactive); a persistent
supervisor agent (nicknamed "Pearl" by default, configurable) is one click
away in a real terminal.

## Install

```bash
./install.sh
```

Installs dependencies, creates `.env` from the template, checks for `tmux`
and iTerm2 (both required at runtime — see Architecture below), and
registers the Atlassian MCP server with Claude Code if it isn't already.

Then fill in `.env`:

- `JIRA_EMAIL`, `JIRA_API_TOKEN`, `JIRA_DOMAIN` — Jira Cloud credentials
- `DEV_ROOT` — parent directory of your repo clones (tickets resolve to a
  repo via a `repo:<name>` label → `$DEV_ROOT/<name>`)
- Everything else in `.env.example` is optional, with sane defaults.

## Run

```bash
npm run dev
```

Starts the API (port 3789) and the Vite dev server (port 5173). Open
`http://localhost:5173`.

## Architecture

```
api/
  server.js        Fastify REST API — tickets, todos, PRs, jobs, dispatch
  pearl.js          The supervisor agent: ensures her tmux session exists,
                     opens a real terminal into her
  run-command.js    Spawns dispatched agents in their own tmux sessions,
                     tracks them as jobs
  lib/              Jira REST client, label/stack helpers, ADF→text, etc.
ui/                 React dashboard (Vite)
tests/              Vitest suite for api/ and ui/ pure logic
```

Dispatched agents and Pearl both run as real `tmux` sessions so you can
attach to and drive them directly from a terminal, not just watch a log —
and opening that terminal window uses `osascript` to drive iTerm2. Both are
macOS-only requirements.

By default, write actions (dispatching an agent, running Pearl) are
disabled — the dashboard shows what it *would* run as copy-to-clipboard
only. Set `DASHBOARD_ALLOW_ACTIONS=true` to let it actually run them.

## SOUL.md

Who Pearl is and how you want her to work, kept separate from the
mechanical API briefing (`api/pearl.js`) so personality/preferences don't
require editing code. Edit it from the dashboard's Pearl tab, or directly —
it's read fresh every time she spins up.
