# Push-to-talk voice input for Pearl, via Wispr Flow

## Why Hex is being replaced

Hex's transcription accuracy wasn't good enough. Wispr Flow is the
replacement candidate — but it's a different kind of app, so the existing
Hex integration can't just be repointed at it.

## What Wispr Flow actually supports (researched, not assumed)

Wispr Flow was not installed on this machine (checked `/Applications`,
`~/Library/Preferences`, `~/Library/Application Support`,
`~/Library/Containers` — nothing). Everything below comes from
`wisprflow.ai` and `docs.wisprflow.ai`.

- **No scriptable hook.** No API, webhook, CLI, URL scheme, or "on
  transcript complete" action is documented anywhere — not in the main
  site, the developer-audience page, or the help center. The one
  "dictation API" mention on the developers page is undetailed and reads
  as the product's internal transcription pipeline, not something
  third-party scripts can call.
- **It only autotypes.** Flow's own description: "Flow types wherever your
  cursor is" / "no plugins required." It injects the transcribed text into
  whichever field currently has keyboard focus. The injection mechanism
  (simulated keystrokes vs. paste vs. accessibility API) isn't documented,
  but the effect is the same either way: text lands whole, pre-formatted
  into that one text input.
- **No auto-submit.** Nothing in the shortcuts article, the Command Mode
  article, or anywhere else mentions pressing Enter / submitting
  automatically after dictation. Flow stops at typing the text.
- **It has its own native global push-to-talk hotkey** (Settings →
  Shortcuts → "Push to talk"), independent of any app. Also supports
  hands-free mode, Command Mode (text editing/search inside the focused
  field — gated behind a paid plan, not relevant here), and a
  mouse-button binding. Up to 3-4 keys per binding; standalone letters not
  allowed; reserved system combos blocked.
- **Command Mode** (Settings → Experimental, requires subscription) lets
  you hold a shortcut and speak an *editing* instruction against the
  focused field's existing text ("make this more formal", "delete that").
  It can open a Perplexity search or a browser-based app-builder result,
  but nothing that shells out locally. Not useful for this integration.

So this is squarely the "autotype into the focused field, human submits"
case the task anticipated — Wispr Flow has nothing to hook.

## Architecture

Three pieces, matching what Flow can and can't do:

1. **`ask` stays the universal entrypoint**, unchanged. Any dictation tool
   that *can* shell out (or any other script, or Jay typing a one-off
   command) still drives Pearl through `pearl-speak.js ask "<text>"` —
   same `isAtChatPrompt` guard, same `tmux send-keys` + arm `speak-next`.

2. **New `arm` subcommand** is the autotype-glue entrypoint, for tools like
   Wispr Flow that can only type into whatever's focused:
   - Captures Pearl's pane and checks `isAtChatPrompt` *before* touching
     anything. If it fails, speaks a warning and stops — nothing is armed,
     nothing is raised blind.
   - Raises/focuses Pearl's iTerm window (reusing `openSessionInIterm`,
     already built for this in `run-command.js`) so Flow's autotype lands
     in the right window once Jay starts talking.
   - Arms `speak-next`, same as `ask`.
   - Then watches Pearl's pane: once it sees the pane change (Flow typing
     the transcript in) and then go quiet for 700ms, it re-checks
     `isAtChatPrompt` one more time and only then sends `Enter`. This is
     the "lightweight way to auto-press Enter" — built because Flow has no
     auto-submit setting to lean on instead.
   - Bounded to a 20s window. If nothing ever changes (Jay didn't end up
     dictating, or canceled), it just exits — no Enter sent, nothing left
     armed in a way that could fire incorrectly. Same if the final
     `isAtChatPrompt` check fails (e.g. something else grabbed the screen
     mid-dictation) — it backs off instead of submitting.
   - This never weakens the guard: the check runs twice (once before
     arming anything, once immediately before the only destructive action,
     sending Enter) instead of once.

3. **Hammerspoon is the hotkey glue**, bound to a *different* key than
   Flow's own push-to-talk — not the same key. Two reasons: there's no
   documented or reliable way to make one physical hotkey fire both Flow's
   native listener and a second tool's, and even if synthetic key
   injection into Flow's listener worked, it's unverified (Flow may use a
   low-level tap that ignores synthetic events) and not worth depending on
   for something safety-sensitive. So the sequence is two deliberate
   keystrokes:
   1. Press the Hammerspoon-bound key → runs `node pearl-speak.js arm`.
   2. Hold Flow's own push-to-talk key, talk, release.

   Hammerspoon over Keyboard Maestro or a macOS Shortcut: it's free, it's
   the standard tool for exactly this (global hotkey → shell out → done),
   and unlike Shortcuts it isn't limited to pre-existing menu-command-style
   key combos for its trigger. Not installed on this machine yet.

   Reference config lives at `hammerspoon/pearl-ptt.lua` in this repo —
   Jay copies/requires it into `~/.hammerspoon/init.lua`.

## What Jay has to do manually

Nothing here can be done by an agent — no GUI automation, no clicking
through System Settings:

1. Install Wispr Flow (not installed) and sign in/set up a plan.
2. In Flow's Settings → Shortcuts, set "Push to talk" to whatever key is
   comfortable to hold while dictating — this is entirely separate from
   the Hammerspoon key below.
3. Install Hammerspoon (`brew install --cask hammerspoon`), grant it
   Accessibility permission when macOS prompts (needed for the global
   hotkey and for raising/focusing windows).
4. Add `require("pearl-ptt")` (or paste its contents) into
   `~/.hammerspoon/init.lua`, pointing `COMMANDCENTER_ROOT` at this repo's
   path, and pick the hotkey in that file (defaults to **F13** — pick
   anything not already in use; it just needs to be distinct from Flow's
   own push-to-talk key).
5. Reload Hammerspoon's config after editing it.

## Why not try to auto-press Enter without the two-check guard

The whole point raised in the brief — "never weaken `isAtChatPrompt`
anywhere" — is why `arm`'s watcher doesn't just arm-and-forget: it
re-verifies right before the one irreversible action (sending Enter), so a
screen change mid-dictation (a permission dialog popping up, Pearl
crashing, anything) can't turn a stale "yes, chat prompt" into "inject
Enter into whatever's showing now."
