-- Push-to-talk glue for Pearl's voice input via Wispr Flow.
--
-- Wispr Flow has no scriptable hook (see .plans/push-to-talk-wispr.md) — it
-- only autotypes into whatever has keyboard focus. This hotkey is the
-- preflight step: it raises Pearl's window, refuses to arm anything unless
-- she's actually sitting at her chat prompt, and starts the watcher that
-- presses Enter once Flow's dictation lands. It is a *separate* key from
-- Flow's own push-to-talk hotkey (set in Flow's own Settings → Shortcuts) —
-- the two are never meant to share one physical key.
--
-- Setup:
--   1. require("pearl-ptt") from ~/.hammerspoon/init.lua (with this file on
--      Hammerspoon's require path — e.g. symlinked into ~/.hammerspoon/, or
--      add this repo's hammerspoon/ dir via package.path), or just paste
--      the body below into init.lua directly.
--   2. Set COMMANDCENTER_ROOT below to this repo's absolute path.
--   3. Pick a hotkey that's free and distinct from Flow's push-to-talk key.
--      F13 is the default — most keyboards have it unused.
--   4. Reload Hammerspoon's config (menu bar icon → Reload Config, or
--      hs.reload()).

local COMMANDCENTER_ROOT = os.getenv("HOME") .. "/dev/commandcenter"

hs.hotkey.bind({}, "F13", function()
  hs.task.new("/usr/bin/node", nil, { COMMANDCENTER_ROOT .. "/api/pearl-speak.js", "arm" }):start()
end)
