# Command Center

A personal focus dashboard for Jira ticket work: tickets, personal todos,
open pull requests, and live agent sessions in one window. Each ticket row
can spawn its own Claude Code agent (headless or interactive); a persistent
supervisor agent (nicknamed "Pearl" by default, configurable) is one click
away in a real terminal.

## Install

```bash
./install.sh            # core setup only
./install.sh --all      # + Atlassian MCP registration + push-to-talk setup
./install.sh --mcp      # + Atlassian MCP registration only
./install.sh --ptt      # + push-to-talk setup only
```

Core (always runs): installs dependencies, creates `.env` from the
template, symlinks `commands/` into `~/.claude/commands`, and checks for
`tmux`, iTerm2, `gh`, and Hammerspoon (`tmux` and iTerm2 are required at
runtime — see Architecture below; `gh` and Hammerspoon are only needed for
the PR column and push-to-talk voice input, respectively).

Optional, off by default — pick what you actually use:

- `--mcp` registers the Atlassian MCP server with Claude Code (Pearl's Jira
  work goes through it)
- `--ptt` sets up push-to-talk voice input for Pearl (see Pearl's voice,
  below)

`install.sh` defaults `DEV_ROOT` to commandcenter's own parent directory
(it's always a repo under your `DEV_ROOT`) — adjust it if that's wrong.
Then fill in `.env`:

- `JIRA_EMAIL`, `JIRA_API_TOKEN`, `JIRA_DOMAIN` — Jira Cloud credentials
- `TODO_PROJECT_KEY` — Jira project key new todos get created in. No
  default (a project key is specific to one person's Jira instance); the
  Todos column's add-todo form returns a clear error until this is set.
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
  server.js         Fastify REST API — tickets, todos, PRs, jobs, dispatch
  pearl.js          The supervisor agent: ensures her tmux session exists,
                     opens a real terminal into her
  pearl-speak.js    Pearl's on-demand speech and push-to-talk input
  run-command.js    Spawns dispatched agents in their own tmux sessions,
                     tracks them as jobs
  brain.js          Per-job Brain View canvas storage
  lib/              Jira REST client, label/stack helpers, ADF→text,
                     Slack PR announce, etc.
commands/           Claude Code commands symlinked into ~/.claude/commands
                     by install.sh (currently /automodel)
hammerspoon/        Push-to-talk hotkey glue for Pearl
ui/                 React dashboard (Vite)
tests/              Vitest suite for api/ and ui/ pure logic
```

Dispatched agents and Pearl both run as real `tmux` sessions so you can
attach to and drive them directly from a terminal, not just watch a log —
and opening that terminal window uses `osascript` to drive iTerm2. Both are
macOS-only requirements.

Write actions (dispatching an agent, running Pearl, ticket cleanup/promote)
always run — there's no env gate or UI toggle to disable them.

## Dispatch

`POST /api/dispatch` with `{ prompt, context, mode, brain }` starts an
agent in its own tmux session. `context` is `{ type: "ticket", key }` or
`{ type: "none" }`; a ticket dispatch prepends the ticket's full detail and
runs in the repo resolved from its labels or description, falling back to
`DEV_ROOT`. `mode` is `headless` (the default) or `interactive`. One
running job per ticket; a second dispatch returns 409.

Every dispatched prompt starts with `/automodel`
(`commands/automodel.md`), so the agent picks haiku, sonnet, or opus for
the task before starting it, and ends with an instruction to report back to
Pearl via `SendMessage`.

## Brain View

Pass `brain: true` on dispatch to give the agent a live canvas at
`~/.commandcenter/brain/<jobId>/canvas.md`, which it rewrites as it works.
The dashboard renders it on its own page (markdown plus Mermaid), served
from `GET /api/jobs/:id/brain`. Opt-in, so sessions that weren't asked to
show their thinking don't fill it with narration.

## SOUL.md

Who Pearl is and how you want her to work, kept separate from the
mechanical API briefing (`api/pearl.js`) so personality/preferences don't
require editing code. Edit it from the dashboard's Pearl tab, or directly —
it's read fresh every time she spins up. The ↻ button next to her name
restarts her session so edits take effect, discarding her current
conversation.

Pearl runs pinned to Opus in `auto` permission mode, named `PEARL_NAME` so
dispatched agents can reach her with `SendMessage`.

## Pearl's voice

A Stop hook, scoped to Pearl's session only, caches a condensed version of
each reply. `api/pearl-speak.js` speaks it on demand (`say`), stops it
(`hush`), and handles voice input: `ask "<text>"` from any dictation tool,
or the `preflight`/`voice` push-to-talk pair driven by Superwhisper's CLI
through `hammerspoon/pearl-ptt.lua` (held Insert key). `./install.sh --ptt`
auto-generates `hammerspoon/pearl-ptt.local.lua` (gitignored) with the
machine-specific paths this needs and wires it into `~/.hammerspoon/init.lua`
idempotently. Superwhisper must still be set up with a local-only mode by
hand; see `.plans/push-to-talk-wispr.md` for why and how.

Optional env: `PEARL_VOICE`, `PEARL_SPEECH_RATE`, `PEARL_SPEECH_VOLUME`,
`PEARL_SPEECH_TONE`, `PEARL_SUPERWHISPER_BIN`, `PEARL_SUPERWHISPER_MODE`.

## Slack PR announcements

Set `SLACK_WORKFLOW_URL_PR_ANNOUNCE` to a Slack Workflow Builder trigger URL
(`hooks.slack.com/triggers/...`) to post PRs to a Slack channel on demand.
Unset, the feature is off. Nothing posts automatically: each PR card gets a
**post** button, and Pearl can post one when asked
(`POST /api/prs/announce` with `{ "url": "<PR URL>" }`). It sends a flat JSON
payload — the Slack workflow owns the channel and the message formatting.
The existing workflow declares a single `text` input; a workflow that wants
to lay out the message itself can use the other fields instead:

- `text` — `:pr-review-request: <title>` plus the PR URL on the next line
- `title` — PR title
- `url` — PR URL
- `repo` — `owner/name`
- `number` — PR number (as a string)

Each PR posts at most once. Posted PRs are recorded by URL in
`~/.commandcenter/slack-posted-prs.json`; asking again for one already there
returns `alreadyPosted` without posting.
