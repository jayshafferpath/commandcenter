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

local function runPearlSpeak(args, onComplete)
  local fullArgs = { PEARL_SPEAK }
  for _, a in ipairs(args) do
    table.insert(fullArgs, a)
  end
  local task = hs.task.new(NODE_BIN, onComplete, fullArgs)
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

-- Status pill (bottom-center, dark translucent, above other windows) so
-- there's visual feedback for a voice action that has no window of its
-- own. Pure UI: never gates `preflight`/`start`/`stop`/`voice`, and must
-- never be left on screen if any of them misbehave.
local overlayWidth, overlayHeight = 190, 40
local overlayCanvas = nil
local pulseTimer, dotsTimer, safetyTimer = nil, nil, nil

local function buildOverlay()
  local screenFrame = hs.screen.mainScreen():frame()
  local canvas = hs.canvas.new({
    x = screenFrame.x + (screenFrame.w - overlayWidth) / 2,
    y = screenFrame.y + screenFrame.h - overlayHeight - 56,
    w = overlayWidth,
    h = overlayHeight,
  })
  -- No mouseCallback is ever set on this canvas — per hs.canvas docs that's
  -- what makes it ignore mouse events entirely (click-through). clickActivating
  -- is just a second layer so a stray click can't steal focus either.
  canvas:level(hs.canvas.windowLevels.overlay)
  canvas:clickActivating(false)
  canvas[1] = {
    type = "rectangle",
    action = "fill",
    roundedRectRadii = { xRadius = overlayHeight / 2, yRadius = overlayHeight / 2 },
    fillColor = { red = 0, green = 0, blue = 0, alpha = 0.72 },
    frame = { x = 0, y = 0, w = overlayWidth, h = overlayHeight },
  }
  canvas[2] = {
    type = "circle",
    id = "dot",
    action = "fill",
    fillColor = { red = 0.95, green = 0.2, blue = 0.2, alpha = 1 },
    center = { x = 22, y = overlayHeight / 2 },
    radius = 5,
  }
  canvas[3] = {
    type = "text",
    id = "label",
    text = "",
    textColor = { white = 1, alpha = 0.95 },
    textSize = 14,
    textAlignment = "left",
    frame = { x = 38, y = 10, w = overlayWidth - 48, h = overlayHeight - 20 },
  }
  return canvas
end

local function stopOverlayTimers()
  if pulseTimer then pulseTimer:stop(); pulseTimer = nil end
  if dotsTimer then dotsTimer:stop(); dotsTimer = nil end
  if safetyTimer then safetyTimer:stop(); safetyTimer = nil end
end

local function hideOverlay()
  stopOverlayTimers()
  if overlayCanvas then overlayCanvas:hide() end
end

local function showListeningOverlay()
  overlayCanvas = overlayCanvas or buildOverlay()
  overlayCanvas["label"].text = "Listening…"
  overlayCanvas["dot"].fillColor = { red = 0.95, green = 0.2, blue = 0.2, alpha = 1 }
  overlayCanvas:show()
  local lit = true
  pulseTimer = hs.timer.doEvery(0.5, function()
    lit = not lit
    overlayCanvas["dot"].fillColor = { red = 0.95, green = 0.2, blue = 0.2, alpha = lit and 1 or 0.25 }
  end)
end

local function showTranscribingOverlay()
  -- Only follows a listening overlay that actually showed — if preflight
  -- failed there was never one to hand off from, and nothing should appear.
  if not overlayCanvas then return end
  if pulseTimer then pulseTimer:stop(); pulseTimer = nil end
  overlayCanvas["dot"].fillColor = { red = 0.95, green = 0.2, blue = 0.2, alpha = 0 }
  local dotCount = 0
  dotsTimer = hs.timer.doEvery(0.4, function()
    dotCount = (dotCount + 1) % 4
    overlayCanvas["label"].text = "Transcribing" .. string.rep(".", dotCount)
  end)
  -- `voice`'s own read-back poll is bounded to 10s; this is a backstop so a
  -- stuck poll loop or a task callback that never fires can't leave the
  -- pill on screen forever.
  safetyTimer = hs.timer.doAfter(11, hideOverlay)
end

local function pressed()
  -- Synchronous on purpose: we need to know preflight passed before
  -- telling Superwhisper to start recording at all.
  local preflightTask = runPearlSpeak({ "preflight" })
  preflightTask:waitUntilExit()
  if preflightTask:terminationStatus() ~= 0 then return end

  hs.execute("'" .. SUPERWHISPER_BIN .. "' start")
  showListeningOverlay()
end

local function released()
  hs.execute("'" .. SUPERWHISPER_BIN .. "' stop")
  showTranscribingOverlay()
  runPearlSpeak({ "voice" }, hideOverlay)
end

hs.hotkey.bind({}, "help", pressed, released)
