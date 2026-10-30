-- Push-to-talk glue for Pearl's voice input via Superwhisper.
--
-- Superwhisper has a real CLI (installed separately — see
-- .plans/push-to-talk-wispr.md): `start`/`stop` control recording in the
-- running app, and `read --json` returns the latest transcript. That's
-- enough to drive Pearl's chat the same way `ask` already does — no
-- autotype, no window-focus dependency, no guessing at when dictation
-- "landed".
--
-- IMPORTANT — do this in Superwhisper's own Settings before using this at
-- all: its shipped default mode transcribes through Superwhisper's own
-- CLOUD model and then cleans the result up with a cloud LLM call. That is
-- not acceptable for this integration. Set up (or edit) a mode that uses a
-- LOCAL voice model (a Whisper or Parakeet variant — NOT "S1-Voice") and is
-- type "voice" (no language-model stage at all, not "message"/"Pro").
-- Confirm by checking a recording afterward: `superwhisper read --json`
-- should show a `modelName` that is NOT "S1-Voice (Cloud)", and no
-- `languageModelName` field at all.
--
-- Setup:
--   1. Set COMMANDCENTER_ROOT, NODE_BIN, and SUPERWHISPER_BIN below to
--      match this machine (`which node` / `which superwhisper`, or for
--      superwhisper specifically, ~/.local/bin/superwhisper if its
--      install-cli.sh put it there).
--   2. Once you've set up a local-only mode in Superwhisper, put its mode
--      key here as PEARL_SUPERWHISPER_MODE so `preflight` pins it before
--      every recording — otherwise it just uses whatever mode is already
--      active, which could be a cloud one.
--   3. Pick a hotkey that isn't bound to anything else. Insert is the
--      default; macOS reports a PC keyboard's Insert as "help".
--   4. Reload Hammerspoon's config (menu bar icon → Reload Config).

local COMMANDCENTER_ROOT = os.getenv("HOME") .. "/dev/commandcenter"
local NODE_BIN = os.getenv("HOME") .. "/.asdf/shims/node"
local SUPERWHISPER_BIN = os.getenv("HOME") .. "/.local/bin/superwhisper"
-- "default" mode (key "default") is set up with a local Parakeet voice
-- model and no language-model stage — verified via its JSON under
-- ~/superwhisper/modes/. "pro" has the same local voice model but still
-- runs a cloud language-model cleanup pass; don't switch to that one here.
local PEARL_SUPERWHISPER_MODE = "default"

local PEARL_SPEAK = COMMANDCENTER_ROOT .. "/api/pearl-speak.js"

local function runPearlSpeak(args)
  local fullArgs = { PEARL_SPEAK }
  for _, a in ipairs(args) do
    table.insert(fullArgs, a)
  end
  local task = hs.task.new(NODE_BIN, nil, fullArgs)
  task:setEnvironment({
    PEARL_SUPERWHISPER_BIN = SUPERWHISPER_BIN,
    PEARL_SUPERWHISPER_MODE = PEARL_SUPERWHISPER_MODE,
    -- The CLI assumes ~/Documents/superwhisper; the app's data lives in
    -- ~/superwhisper here (its appFolderDirectory default).
    SUPERWHISPER_MODES = os.getenv("HOME") .. "/superwhisper/modes",
    HOME = os.getenv("HOME"),
    -- The asdf node shim execs `asdf`, which lives in Homebrew.
    PATH = "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin",
  })
  task:start()
  return task
end

local function pressed()
  -- Synchronous on purpose: we need to know preflight passed before
  -- telling Superwhisper to start recording at all.
  local preflightTask = runPearlSpeak({ "preflight" })
  preflightTask:waitUntilExit()
  if preflightTask:terminationStatus() ~= 0 then return end

  hs.execute("'" .. SUPERWHISPER_BIN .. "' start")
end

local function released()
  hs.execute("'" .. SUPERWHISPER_BIN .. "' stop")
  runPearlSpeak({ "voice" })
end

hs.hotkey.bind({}, "help", pressed, released)
