#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "Installing Command Center dependencies..."
(cd "$SCRIPT_DIR" && npm install)

# .env holds the credentials/config the API reads via api/lib/env.js (loadEnv).
if [ ! -f "$SCRIPT_DIR/.env" ] && [ -f "$SCRIPT_DIR/.env.example" ]; then
  cp "$SCRIPT_DIR/.env.example" "$SCRIPT_DIR/.env"
  echo ""
  echo "  Created $SCRIPT_DIR/.env from template — fill in your credentials"
fi

echo ""
echo "Installing commands..."

# Dispatch (api/server.js) prepends /automodel to every spawned agent's
# prompt before it ever touches the actual task — without this symlinked
# into ~/.claude/commands, the CLI can't resolve it in whatever repo the
# agent runs in, and the model ends up trying to invoke it as a (nonexistent)
# Skill with the task text as an argument instead.
CLAUDE_COMMANDS_DIR="$HOME/.claude/commands"
mkdir -p "$CLAUDE_COMMANDS_DIR"
for file in "$SCRIPT_DIR"/commands/*.md; do
  [ -f "$file" ] || continue
  name=$(basename "$file")
  target="$CLAUDE_COMMANDS_DIR/$name"

  if [ -L "$target" ]; then
    rm "$target"
  elif [ -f "$target" ]; then
    backup="$target.bak"
    n=1
    while [ -e "$backup" ]; do
      backup="$target.bak.$n"
      n=$((n + 1))
    done
    echo "  Backing up existing $name -> $(basename "$backup")"
    mv "$target" "$backup"
  fi

  ln -s "$file" "$target"
  echo "  Linked $name"
done

echo ""
echo "Checking optional runtime dependencies..."

# tmux backs every dashboard-spawned session (dispatched agents, and the
# Pearl supervisor) — without it, dispatch and Pearl both fail at runtime
# with no earlier warning otherwise.
if command -v tmux >/dev/null 2>&1; then
  echo "  tmux found"
else
  echo "  Warning: tmux not found — dispatch and Pearl both require it."
  echo "    Install with: brew install tmux"
fi

# osascript drives "open a real terminal window" (iTerm2) for sessions and
# Pearl. Only relevant on macOS; harmless to warn about elsewhere since the
# dashboard itself is a macOS-only tool (see api/run-command.js).
if command -v osascript >/dev/null 2>&1; then
  if osascript -e 'id of application "iTerm"' >/dev/null 2>&1; then
    echo "  iTerm2 found"
  else
    echo "  Warning: iTerm2 not found — opening a terminal for a session or Pearl will fail."
    echo "    Install from: https://iterm2.com"
  fi
else
  echo "  Warning: osascript not found — this dashboard's terminal-opening features require macOS."
fi

echo ""
echo "Setting up MCP servers..."

# Pearl is a real interactive `claude` session (see api/pearl.js) — Jira work
# she does goes through the Atlassian MCP server, not this project's own REST
# calls. Registered at user scope so it's available in every project, not
# just this one.
MCP_NAME="atlassian"
MCP_URL="https://mcp.atlassian.com/v1/mcp"
if ! command -v claude >/dev/null 2>&1; then
  echo "  Warning: claude CLI not found — skipping MCP setup."
  echo "    Install Claude Code, then run: claude mcp add --transport http $MCP_NAME $MCP_URL -s user"
elif claude mcp list 2>/dev/null | grep -q "^$MCP_NAME:"; then
  echo "  $MCP_NAME MCP server already registered"
else
  echo "  Registering $MCP_NAME MCP server (user scope)..."
  if claude mcp add --transport http "$MCP_NAME" "$MCP_URL" -s user; then
    echo "  Registered — authenticate it with: claude mcp list"
  else
    echo "  Warning: failed to register $MCP_NAME automatically."
    echo "    Run manually: claude mcp add --transport http $MCP_NAME $MCP_URL -s user"
  fi
fi

echo ""
echo "Done."
echo ""
echo "Next steps:"
echo "  1. Edit $SCRIPT_DIR/.env — set JIRA_EMAIL, JIRA_API_TOKEN, JIRA_DOMAIN, DEV_ROOT"
echo "  2. Optionally set PEARL_NAME in that same .env to rename the supervisor agent"
echo "     (defaults to \"Pearl\" if unset)"
echo "  3. Optionally set DASHBOARD_ALLOW_ACTIONS=true to let the dashboard run"
echo "     lifecycle commands and spawn agents instead of only suggesting them"
echo "  4. If the atlassian MCP server was just registered, authenticate it"
echo "     (run 'claude' and approve the OAuth prompt on first use)"
echo "  5. Run: npm run dev"
echo "     This starts both the API (port 3789) and the Vite dev server (port 5173)"
echo "  6. Open http://localhost:5173"
