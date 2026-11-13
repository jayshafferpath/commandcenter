#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Core setup (deps, .env, commands symlink, dependency checks) always runs.
# The rest is opt-in per feature — pick what you actually use.
WITH_MCP=false
WITH_PTT=false
WITH_MEMORY=false
WITH_VSCODE_EXT=false

usage() {
  echo "Usage: ./install.sh [options]"
  echo ""
  echo "Always runs: npm install, .env setup, commands/ symlinks, tmux/iTerm2/gh/Hammerspoon checks."
  echo ""
  echo "Optional (off by default):"
  echo "  --mcp         Register the Atlassian MCP server (needed for Pearl's Jira work)"
  echo "  --ptt         Set up push-to-talk voice input for Pearl (Hammerspoon + Superwhisper glue)"
  echo "  --memory      Install Basic Memory for Pearl's persistent, local-only memory (~0.5 GB)"
  echo "  --vscode-ext  Build and install the Pair Pal VS Code extension (agent presence in your editor)"
  echo "  --all         Enable all of the above except --vscode-ext (see note below; always opt-in)"
  echo "  -h, --help    Show this help"
}

for arg in "$@"; do
  case "$arg" in
    --mcp) WITH_MCP=true ;;
    --ptt) WITH_PTT=true ;;
    --memory) WITH_MEMORY=true ;;
    --vscode-ext) WITH_VSCODE_EXT=true ;;
    # --vscode-ext deliberately stays out of --all: installing a VS Code
    # extension is a bigger footprint change than the other optional flags
    # (it sideloads into the user's editor, not just this repo's own
    # tooling), so it always requires the explicit flag, every time. Don't
    # add it here even if --all grows more entries later.
    --all) WITH_MCP=true; WITH_PTT=true; WITH_MEMORY=true ;;
    -h|--help) usage; exit 0 ;;
    *)
      echo "Unknown option: $arg"
      usage
      exit 1
      ;;
  esac
done

echo "Installing Command Center dependencies..."
(cd "$SCRIPT_DIR" && npm install)

# .env holds the credentials/config the API reads via api/lib/env.js (loadEnv).
if [ ! -f "$SCRIPT_DIR/.env" ] && [ -f "$SCRIPT_DIR/.env.example" ]; then
  cp "$SCRIPT_DIR/.env.example" "$SCRIPT_DIR/.env"
  # commandcenter is itself always a repo under DEV_ROOT, so its own parent
  # directory is the right default rather than leaving the template's
  # placeholder in place.
  DEV_ROOT_DEFAULT="$(dirname "$SCRIPT_DIR")"
  sed -i '' "s#^DEV_ROOT=.*#DEV_ROOT=$DEV_ROOT_DEFAULT#" "$SCRIPT_DIR/.env"
  echo ""
  echo "  Created $SCRIPT_DIR/.env from template (DEV_ROOT defaulted to $DEV_ROOT_DEFAULT)"
  echo "  Fill in JIRA_EMAIL, JIRA_API_TOKEN, JIRA_DOMAIN"
fi

# SOUL.md is each user's own copy of Pearl's personality, gitignored like
# .env. Seeded from the neutral template once, never overwritten, so edits
# made from the dashboard's Pearl tab survive a re-run.
if [ ! -f "$SCRIPT_DIR/SOUL.md" ] && [ -f "$SCRIPT_DIR/SOUL.example.md" ]; then
  cp "$SCRIPT_DIR/SOUL.example.md" "$SCRIPT_DIR/SOUL.md"
  echo ""
  echo "  Created $SCRIPT_DIR/SOUL.md from template — make Pearl yours from the dashboard's Pearl tab"
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

# gh backs the PR column, PR announce, and the PR-state checks several
# lifecycle commands rely on. Missing or unauthenticated, the PR column just
# renders empty with no explanation why.
if command -v gh >/dev/null 2>&1; then
  if gh auth status >/dev/null 2>&1; then
    echo "  gh found and authenticated"
  else
    echo "  Warning: gh found but not authenticated — the PR column will stay empty."
    echo "    Run: gh auth login"
  fi
else
  echo "  Warning: gh not found — the PR column and PR announce require it."
  echo "    Install with: brew install gh"
fi

# Hammerspoon drives Pearl's push-to-talk hotkey (hammerspoon/pearl-ptt.lua) —
# optional, only needed for voice input. See .plans/push-to-talk-wispr.md.
if [ -d "/Applications/Hammerspoon.app" ]; then
  echo "  Hammerspoon found"
else
  echo "  Note: Hammerspoon not found — only needed for push-to-talk voice input to Pearl."
  echo "    Install from: https://www.hammerspoon.org"
fi

if [ "$WITH_MCP" = true ]; then
  echo ""
  echo "Setting up MCP servers..."

  # Pearl is a real interactive `claude` session (see api/pearl.js) — Jira
  # work she does goes through the Atlassian MCP server, not this project's
  # own REST calls. Registered at user scope so it's available in every
  # project, not just this one.
  MCP_NAME="atlassian"
  MCP_URL="https://mcp.atlassian.com/v2/mcp"
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
else
  echo ""
  echo "Skipping MCP setup (pass --mcp or --all to enable)."
fi

if [ "$WITH_PTT" = true ]; then
  echo ""
  echo "Setting up push-to-talk voice input (Pearl)..."

  # The machine-specific bits of pearl-ptt.lua (repo location, node path,
  # superwhisper path, homebrew prefix) used to require hand-editing a
  # tracked file on every new machine. This generates a gitignored override
  # file instead — same pattern as .env/.env.example. Never overwritten once
  # it exists, so machine-specific hand-edits (e.g. a corrected node path)
  # survive a re-run.
  HS_LOCAL="$SCRIPT_DIR/hammerspoon/pearl-ptt.local.lua"
  if [ -f "$HS_LOCAL" ]; then
    echo "  $HS_LOCAL already exists — leaving it alone"
  else
    NODE_BIN_DETECTED="$(command -v node || true)"
    SUPERWHISPER_DETECTED="$(command -v superwhisper || true)"
    if [ -z "$SUPERWHISPER_DETECTED" ]; then
      SUPERWHISPER_DETECTED="$HOME/.local/bin/superwhisper"
    fi
    if command -v brew >/dev/null 2>&1; then
      BREW_PREFIX="$(brew --prefix)"
    else
      BREW_PREFIX="/opt/homebrew"
    fi
    if [ -z "$NODE_BIN_DETECTED" ]; then
      NODE_BIN_DETECTED="$HOME/.asdf/shims/node"
    fi

    cat > "$HS_LOCAL" <<EOF
-- Auto-generated by install.sh for this machine. Edit freely — install.sh
-- never overwrites this file once it exists. See pearl-ptt.lua for how
-- these are used.
return {
  COMMANDCENTER_ROOT = "$SCRIPT_DIR",
  NODE_BIN = "$NODE_BIN_DETECTED",
  SUPERWHISPER_BIN = "$SUPERWHISPER_DETECTED",
  HOMEBREW_PREFIX = "$BREW_PREFIX",
  -- Must point at a Superwhisper mode that's local-only (a Whisper/Parakeet
  -- voice model, type "voice", no language-model stage) — see
  -- .plans/push-to-talk-wispr.md. "default" is a placeholder: verify it on
  -- this machine (or set up a new mode) before relying on it.
  PEARL_SUPERWHISPER_MODE = "default",
}
EOF
    echo "  Wrote $HS_LOCAL"
    echo "    node: ${NODE_BIN_DETECTED:-not found}"
    echo "    superwhisper: $SUPERWHISPER_DETECTED"
    echo "    homebrew: $BREW_PREFIX"
  fi

  # Wires pearl-ptt.lua into Hammerspoon's own config, idempotently — same
  # check-before-write approach as the commands/ symlinks above. Append-only:
  # never touches anything already in init.lua. Checks loosely for
  # "pearl-ptt" rather than this exact dofile string, since an existing
  # setup may have wired it via `require` + a package.path tweak instead —
  # still valid, shouldn't be duplicated.
  HS_INIT="$HOME/.hammerspoon/init.lua"
  mkdir -p "$HOME/.hammerspoon"
  if [ -f "$HS_INIT" ] && grep -qF "pearl-ptt" "$HS_INIT"; then
    echo "  $HS_INIT already wired to pearl-ptt.lua"
  else
    {
      echo ""
      echo "-- Added by commandcenter's install.sh"
      echo "dofile(\"$SCRIPT_DIR/hammerspoon/pearl-ptt.lua\")"
    } >> "$HS_INIT"
    echo "  Appended pearl-ptt.lua to $HS_INIT"
    echo "    Reload Hammerspoon's config (menu bar icon -> Reload Config) to pick it up"
  fi
else
  echo ""
  echo "Skipping push-to-talk setup (pass --ptt or --all to enable)."
fi

if [ "$WITH_MEMORY" = true ]; then
  echo ""
  echo "Setting up Pearl's memory (Basic Memory, local-only)..."

  # Probed with `--version`, not `command -v`: an asdf shim answers
  # `command -v uv` even when no installed Python provides uv, then fails on
  # every call. Homebrew's uv is called by full path because asdf's shims
  # sit ahead of Homebrew on PATH, so a plain `uv` would still hit the broken
  # shim right after `brew install uv`.
  UV=""
  if uv --version >/dev/null 2>&1; then
    UV="uv"
  elif command -v brew >/dev/null 2>&1; then
    BREW_UV="$(brew --prefix)/bin/uv"
    if ! "$BREW_UV" --version >/dev/null 2>&1; then
      echo "  uv not found — installing it with Homebrew..."
      brew install uv || true
    fi
    if "$BREW_UV" --version >/dev/null 2>&1; then
      UV="$BREW_UV"
    fi
  fi

  if [ -z "$UV" ]; then
    echo "  Warning: uv isn't available and couldn't be installed — skipping memory setup."
    echo "    Install uv (https://docs.astral.sh/uv/), then re-run with --memory"
  else
    # --managed-python: uv's own CPython ships SQLite extension loading.
    # Many system/asdf builds don't, and without it sqlite-vec can't load and
    # search silently drops to keyword-only.
    if "$UV" tool list 2>/dev/null | grep -q "^basic-memory "; then
      echo "  basic-memory already installed"
    elif "$UV" tool install --managed-python basic-memory; then
      echo "  Installed basic-memory"
    else
      echo "  Warning: failed to install basic-memory."
      echo "    Run manually: $UV tool install --managed-python basic-memory"
    fi

    UV_BIN_DIR="$("$UV" tool dir --bin 2>/dev/null || true)"
    if [ "$UV_BIN_DIR" != "$HOME/.local/bin" ] && [ -n "$UV_BIN_DIR" ]; then
      echo "  Note: uv installs tools to $UV_BIN_DIR, not ~/.local/bin."
      echo "    Set PEARL_MEMORY_BIN=$UV_BIN_DIR/basic-memory in $SCRIPT_DIR/.env"
    fi

    mkdir -p "$HOME/.commandcenter/memory"
    echo "  Memory lives in ~/.commandcenter/memory (Markdown notes under notes/)"
    echo "  Restart Pearl (↻ in the dashboard) to give her the memory tools"
  fi
else
  echo ""
  echo "Skipping Pearl's memory setup (pass --memory or --all to enable)."
fi

if [ "$WITH_VSCODE_EXT" = true ]; then
  echo ""
  echo "Building and installing the Pair Pal VS Code extension..."

  # vsce package builds the .vsix entirely locally — nothing is uploaded or
  # published to the Marketplace (see .plans/vscode-walkthrough-bridge.md).
  if ! command -v code >/dev/null 2>&1; then
    echo "  Warning: the 'code' CLI isn't on PATH — can't install the extension."
    echo "    In VS Code: Cmd+Shift+P -> 'Shell Command: Install \"code\" command in PATH'"
  else
    (cd "$SCRIPT_DIR/vscode-extension" && npm install --no-fund --no-audit)
    VSIX_PATH="$SCRIPT_DIR/vscode-extension/pair-pal.vsix"
    if (cd "$SCRIPT_DIR/vscode-extension" && npx vsce package --out pair-pal.vsix); then
      if code --install-extension "$VSIX_PATH"; then
        echo "  Installed Pair Pal into VS Code"
        echo "  Set commandCenter.sessionId in VS Code settings to the review id you want to connect to"
      else
        echo "  Warning: 'code --install-extension' failed — install manually:"
        echo "    code --install-extension $VSIX_PATH"
      fi
    else
      echo "  Warning: vsce package failed — see vscode-extension/README.md for manual steps."
    fi
  fi
else
  echo ""
  echo "Skipping Pair Pal VS Code extension (pass --vscode-ext to enable — never included in --all)."
fi

echo ""
echo "Done."
echo ""
echo "Next steps:"
echo "  1. Edit $SCRIPT_DIR/.env — set JIRA_EMAIL, JIRA_API_TOKEN, JIRA_DOMAIN"
echo "     (DEV_ROOT was defaulted above — adjust if that's wrong)"
echo "  2. Optionally set PEARL_NAME in that same .env to rename the supervisor agent"
echo "     (defaults to \"Pearl\" if unset)"
if [ "$WITH_MCP" = true ]; then
  echo "  3. If the atlassian MCP server was just registered, authenticate it"
  echo "     (run 'claude' and approve the OAuth prompt on first use)"
else
  echo "  3. Pearl's Jira work needs the Atlassian MCP server — re-run with --mcp"
  echo "     (or --all) when you want it"
fi
if [ "$WITH_PTT" = true ]; then
  echo "  4. For push-to-talk voice input: set up a local-only Superwhisper mode"
  echo "     and grant Hammerspoon's Accessibility permission on first launch"
  echo "     — see .plans/push-to-talk-wispr.md"
else
  echo "  4. Push-to-talk voice input for Pearl wasn't set up — re-run with --ptt"
  echo "     (or --all) when you want it"
fi
if [ "$WITH_VSCODE_EXT" = true ]; then
  echo "  5. Pair Pal is installed — set commandCenter.sessionId in VS Code settings"
  echo "     to try it (see vscode-extension/README.md for a manual smoke checklist)"
else
  echo "  5. Pair Pal (agent presence in VS Code) wasn't installed — re-run with"
  echo "     --vscode-ext when you want it (always explicit, never part of --all)"
fi
echo "  6. Run: npm run dev"
echo "     This starts both the API (port 3789) and the Vite dev server (port 5173)"
echo "  7. Open http://localhost:5173"
