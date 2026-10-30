# Push-to-talk voice input for Pearl

## History of this design

First pass targeted **Wispr Flow** (replacing Hex for transcription
accuracy). Researched it, built an `arm` subcommand + autotype-watcher
around it, then learned a hard constraint applies here: local speech-to-text
may not be hooked to any external server/API. Wispr Flow's own privacy page
states transcription "always happens in the cloud" — no local mode exists
for it at all. That ruled it out outright; the `arm`/autotype-watcher
design was deleted, not adapted.

Second pass, and what's actually implemented, is **Superwhisper**.

## What Superwhisper actually supports (verified on this machine, not just docs)

- **A real CLI**, installed separately (`curl -fsSL
  https://superwhisper.com/install-cli.sh | bash`, lands in `~/.local/bin`
  on this machine) — the app bundle alone doesn't provide it on PATH.
  Relevant subcommands: `start` / `stop` (toggle recording in the running
  app), `read [ID] --json` (latest transcription if ID omitted, full
  metadata as a single JSON object — not array-wrapped), `switch [MODE]`
  (change the active mode), `mcp` (MCP server over stdio). Also deep links
  (`superwhisper://record/start` etc.) and an MCP server, neither of which
  this design ended up needing since the CLI covers it directly.
- **Local voice models exist and work**: confirmed via
  `~/superwhisper/modes/*.json` and real `read --json` output on this
  machine. Local: Whisper (all variants), Parakeet, Cohere Transcribe.
  Cloud: S1-Voice, Deepgram Nova, ElevenLabs Scribe.
- **Local is not the default, and not a global toggle.** It's set per mode,
  and every mode this app shipped with on this machine (`default`, `pro`,
  `system-meeting`) was configured with `voiceModelID: "sv-1"` —
  S1-Voice, the cloud model. Confirmed by actually reading a recording's
  JSON (`modelName: "S1-Voice (Cloud)"`) rather than trusting the general
  docs claim that free tier defaults to local. **Local-only requires
  explicitly setting up a mode with a local voice model and no
  language-model stage** (mode `type: "voice"`, not `"message"` — a
  `"message"`-type mode runs a cloud LLM cleanup pass regardless of which
  voice model transcribed it).

### A mistake made while verifying this

While testing the mechanics of `start`/`stop`, a real recording captured
actual ambient speech (ironically, about work) and — because no local mode
was configured yet — it went through Superwhisper's cloud transcription
*and* cloud LLM cleanup. That's exactly the thing this design exists to
prevent. The local audio file and sqlite history row for that recording are
still sitting on this machine (`~/superwhisper/recordings/`, plus the
sqlite db at `~/Library/Application Support/superwhisper/database/`); I
couldn't delete them — no `delete` subcommand in the CLI, and direct
file/db deletion was blocked by the permission system. Jay needs to deal
with that cleanup and, if it matters, Superwhisper's retention/deletion
options for whatever was already sent to their servers.

Lesson applied to the design below: nothing in this flow starts a
recording without a mode having been deliberately pinned first, and the
CLI mechanics were fully verified before any of this was wired to a
hotkey — not after.

## Architecture

1. **`ask` stays the universal entrypoint**, unchanged. Any dictation tool
   or script that can shell out with the text already in hand still drives
   Pearl through `pearl-speak.js ask "<text>"` — `isAtChatPrompt` guard,
   `tmux send-keys`, arms `speak-next`.

2. **New `preflight` / `voice` pair**, run on hotkey press/release:
   - `preflight` (key-down, before any recording starts): captures Pearl's
     pane and checks `isAtChatPrompt` *first* — refuses before Superwhisper
     ever starts listening, exits non-zero so the hotkey script knows not
     to call `start`. If `PEARL_SUPERWHISPER_MODE` is set, switches to that
     mode so this path can't end up on whatever mode happens to be active
     for Jay's general dictation elsewhere. Records a snapshot of
     Superwhisper's current latest transcript as a baseline.
   - `voice` (key-up, after Superwhisper has been told to stop): polls
     `superwhisper read --json` until it differs from the baseline (bounded
     to 10s, so a recording that produced nothing — silence, a dropped
     `start` — just times out instead of eventually sending something
     stale), pulls `rawResult` out of it, and sends that through the exact
     same `sendToChat` path `ask` uses — same `isAtChatPrompt` re-check
     right before injecting anything, same `speak-next` arming.
   - Uses `rawResult`, not `llmResult`: Pearl should get what Jay actually
     said, not a mode's language-model cleanup pass. This also sidesteps
     having to reason about whether that cleanup pass was local or cloud —
     the mode being `type: "voice"` (no language-model stage at all) is
     what actually guarantees that, not which field we read afterward.
   - No window-raising needed anywhere in this version. `tmux send-keys`
     works regardless of OS-level window focus — that dependency only
     existed in the Wispr Flow design because autotype required the right
     window to be focused.

3. **Hammerspoon is the hotkey glue** (same choice as the Wispr Flow design,
   for the same reasons — free, scriptable, not limited to pre-existing
   menu-command-style triggers like macOS Shortcuts). Binds a held hotkey:
   press runs `preflight` synchronously and only calls `superwhisper start`
   if it exits 0; release calls `superwhisper stop` then `voice`.
   Reference config: `hammerspoon/pearl-ptt.lua`.

## What Jay has to do manually

1. ~~Set up a local-only mode in Superwhisper.~~ Done — `default` mode
   (key `"default"`) uses a local Parakeet voice model
   (`nvidia_parakeet-v2_476MB`) with no language-model stage, confirmed via
   its JSON under `~/superwhisper/modes/`. `PEARL_SUPERWHISPER_MODE` in
   `hammerspoon/pearl-ptt.lua` is set to `"default"` accordingly. (`pro` got
   the same local voice model but still has a cloud language-model cleanup
   stage — don't point this integration at it.)
2. ~~Install Hammerspoon.~~ Done.
3. `~/.hammerspoon/init.lua` is wired up to `require` this repo's
   `hammerspoon/pearl-ptt.lua` directly (not a copy) — editing the file in
   this repo is editing the live config. Still needed: open Hammerspoon
   once and grant its Accessibility permission prompt when macOS shows it.
4. Reload Hammerspoon's config after that (menu bar icon → Reload Config)
   and confirm F13 (or whatever hotkey is chosen) is actually free on this
   keyboard.
5. Deal with the cleanup noted above — the accidental cloud-transcribed
   recording from testing is still local, and was already sent to
   Superwhisper's servers once.

Nothing past step 0 (researching/choosing the tool) could be done without
Jay's hands — no GUI automation, no clicking through model pickers or
Accessibility prompts.
