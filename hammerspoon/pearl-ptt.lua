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
--   install.sh auto-generates pearl-ptt.local.lua (gitignored, sibling to
--   this file) with COMMANDCENTER_ROOT/NODE_BIN/SUPERWHISPER_BIN/
--   HOMEBREW_PREFIX detected for this machine — it's never overwritten once
--   it exists, so hand-edits (e.g. a corrected path) survive a re-run. The
--   one thing that still needs a human:
--   1. Set up a local-only mode in Superwhisper, then put its mode key in
--      pearl-ptt.local.lua's PEARL_SUPERWHISPER_MODE so `preflight` pins it
--      before every recording — otherwise it uses whatever mode is already
--      active, which could be a cloud one.
--   2. Pick a hotkey that isn't bound to anything else. Insert is the
--      default; macOS reports a PC keyboard's Insert as "help".
--   3. Reload Hammerspoon's config (menu bar icon → Reload Config).

-- Loaded by file path (debug.getinfo), not `require`, so this works
-- regardless of whatever package.path Hammerspoon's own init.lua set up.
local function scriptDir()
  local source = debug.getinfo(1, "S").source:sub(2)
  return source:match("(.*/)") or "./"
end

local function loadLocalOverrides()
  local path = scriptDir() .. "pearl-ptt.local.lua"
  local file = io.open(path, "r")
  if not file then return {} end
  file:close()
  local ok, result = pcall(dofile, path)
  if ok and type(result) == "table" then return result end
  return {}
end

local overrides = loadLocalOverrides()

local COMMANDCENTER_ROOT = overrides.COMMANDCENTER_ROOT or (os.getenv("HOME") .. "/dev/commandcenter")
local NODE_BIN = overrides.NODE_BIN or (os.getenv("HOME") .. "/.asdf/shims/node")
local SUPERWHISPER_BIN = overrides.SUPERWHISPER_BIN or (os.getenv("HOME") .. "/.local/bin/superwhisper")
local HOMEBREW_PREFIX = overrides.HOMEBREW_PREFIX or "/opt/homebrew"
-- "default" mode (key "default") is set up with a local Parakeet voice
-- model and no language-model stage — verified via its JSON under
-- ~/superwhisper/modes/. "pro" has the same local voice model but still
-- runs a cloud language-model cleanup pass; don't switch to that one here.
local PEARL_SUPERWHISPER_MODE = overrides.PEARL_SUPERWHISPER_MODE or "default"

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
    PATH = HOMEBREW_PREFIX .. "/bin:/usr/bin:/bin:/usr/sbin:/sbin",
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
