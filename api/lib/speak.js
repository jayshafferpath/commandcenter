// Shared speech mechanics, extracted out of pearl-speak.js so a second
// caller (the review-walkthrough loop — see .plans/interactive-review-loop.md
// and api/review-voice.js) can speak text aloud the same way Pearl does,
// without sharing Pearl's state dir or relay window name: two independent
// instances must never be able to hush() or reap each other's in-flight
// utterance. See the "Voice for review-walkthrough sessions" plan for why
// this is a factory (createVoice) rather than more module-level constants.
//
// Pearl's own push-to-talk/Superwhisper/chat-injection logic stays in
// pearl-speak.js untouched — none of that is generic, all of it is.

import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Ceiling for what gets spoken when condensing fails, so a summarize
// timeout can't turn into reading a whole multi-paragraph reply aloud.
const FALLBACK_MAX_CHARS = 250;

// Below this, a reply is already short enough to just speak — skipping the
// haiku round-trip saves the latency/cost on a short, already-terse line.
const SUMMARIZE_THRESHOLD_CHARS = 80;

const OSASCRIPT = "/usr/bin/osascript";
// Upper bound on one utterance's `say` call, independent of hush() — if
// say ever hangs, this is what still gets the relay window closed instead
// of leaking it forever. Well above anything summarizeForSpeech/
// truncateForSpeech would ever hand it.
const RELAY_WATCHDOG_SECONDS = 60;

export function cleanForSpeech(text) {
  return text
    .replace(/```[\s\S]*?```/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_`]/g, "")
    .replace(/[ \t]+/g, " ")
    .trim();
}

export function truncateForSpeech(text) {
  const firstSentence = text.match(/^[\s\S]*?[.!?](?=\s|$)/)?.[0] ?? text;
  return firstSentence.length <= FALLBACK_MAX_CHARS
    ? firstSentence
    : `${firstSentence.slice(0, FALLBACK_MAX_CHARS).trimEnd()}…`;
}

// Condenses a long reply down to its core idea before speaking it. Falls
// back to the reply's opening sentence on any failure (timeout, no auth,
// etc.) — losing the condensing is better than losing the message.
export function summarizeForSpeech(text) {
  if (text.length < SUMMARIZE_THRESHOLD_CHARS) return text;

  try {
    const summary = execFileSync(
      "claude",
      [
        "-p",
        // "Summarize" made haiku narrate from outside ("Pearl says..."); asking
        // for a first-person rewrite keeps the spoken line in the speaker's
        // own voice, Pearl's or a review session's either way.
        `Rewrite this message as one short spoken sentence, in the speaker's own first-person voice, talking directly to the listener. Don't describe the message or mention who wrote it. No preamble, no quotes, just the sentence:\n\n${text}`,
        "--model",
        "haiku",
      ],
      { encoding: "utf-8", timeout: 10_000 },
    ).trim();
    return summary || truncateForSpeech(text);
  } catch {
    return truncateForSpeech(text);
  }
}

export function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

// `application ... is running` (rather than a bare `tell application`,
// which auto-launches it) is what lets both this and a reaper skip cleanly
// instead of launching iTerm2 just to find out it isn't open.
export function isITermRunning() {
  try {
    return (
      execFileSync(OSASCRIPT, ["-e", 'application "iTerm2" is running'], {
        encoding: "utf-8",
      }).trim() === "true"
    );
  } catch {
    return false;
  }
}

// One independent speaking instance: its own pid/buffer/script files and
// its own relay window name, so hushing or reaping one instance can never
// touch another's in-flight utterance. `stateDir` must already exist (the
// caller creates it, same as every other per-id directory in this app).
export function createVoice({ stateDir, relaySessionName }) {
  const SAY_PID_PATH = join(stateDir, "say.pid");
  const SPEAK_BUFFER_PATH = join(stateDir, "speak-buffer.txt");
  const SPEAK_SCRIPT_PATH = join(stateDir, "speak-run.sh");

  function readPid() {
    try {
      const pid = Number.parseInt(readFileSync(SAY_PID_PATH, "utf-8"), 10);
      return Number.isInteger(pid) ? pid : null;
    } catch {
      return null;
    }
  }

  function isPidAlive(pid) {
    if (!pid) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  function hush() {
    const pid = readPid();
    rmSync(SAY_PID_PATH, { force: true });
    if (!pid) return;

    try {
      process.kill(pid);
    } catch {
      // Already finished speaking — nothing to stop.
    }
  }

  // Backgrounding `say` and capturing $! (not the shell's own $$) is what
  // puts say's real OS pid in SAY_PID_PATH, so hush()'s process.kill() still
  // stops the right process exactly as it does for a direct spawn — and
  // since `wait` unblocks as soon as that pid dies, hush() killing it is
  // also what makes the window close itself promptly on interrupt, not just
  // on natural completion. The watchdog subshell is the fallback for "say
  // hangs and nothing ever interrupts it": it force-kills the same pid
  // after RELAY_WATCHDOG_SECONDS, which unblocks `wait` the same way.
  function buildRelayScript(sayArgs, windowId) {
    return [
      "#!/bin/bash",
      `/usr/bin/say ${sayArgs.map(shQuote).join(" ")} < ${shQuote(SPEAK_BUFFER_PATH)} &`,
      "SAY_PID=$!",
      `echo $SAY_PID > ${shQuote(SAY_PID_PATH)}`,
      `( sleep ${RELAY_WATCHDOG_SECONDS}; kill -9 $SAY_PID ) 2>/dev/null &`,
      "WATCHDOG_PID=$!",
      "wait $SAY_PID 2>/dev/null",
      "kill $WATCHDOG_PID 2>/dev/null",
      `osascript -e 'tell application "iTerm2" to close (window id ${windowId})'`,
      "",
    ].join("\n");
  }

  // Two round trips: the window has to exist before we can address it by id
  // in the script that runs inside it (and that it closes itself with).
  function speakViaITermWindow(sayArgs, bufferContent) {
    writeFileSync(SPEAK_BUFFER_PATH, bufferContent);

    const windowId = execFileSync(
      OSASCRIPT,
      [
        "-e",
        `tell application "iTerm"
  set w to (create window with default profile)
  set bounds of w to {-3000, -3000, -2500, -2700}
  set name of current session of w to "${relaySessionName}"
  return id of w
end tell`,
      ],
      { encoding: "utf-8" },
    ).trim();

    writeFileSync(SPEAK_SCRIPT_PATH, buildRelayScript(sayArgs, windowId), { mode: 0o755 });

    execFileSync(OSASCRIPT, [
      "-e",
      `tell application "iTerm" to tell current session of (window id ${windowId}) to write text "bash ${SPEAK_SCRIPT_PATH}"`,
    ]);
  }

  function speakDirect(sayArgs, bufferContent) {
    const child = spawn("/usr/bin/say", sayArgs, {
      detached: true,
      stdio: ["pipe", "ignore", "ignore"],
    });
    writeFileSync(SAY_PID_PATH, String(child.pid));
    child.stdin.write(bufferContent);
    child.stdin.end();
    child.unref();
  }

  // `say` run as a direct child of a tmux-backed, headless process never
  // reaches a Personal Voice or Siri's "natural" voices — confirmed by ear
  // that the identical `say` invocation run inside a plain (non-tmux)
  // iTerm2 window does. Relaying through a throwaway iTerm2 window
  // sidesteps that, since it's `say` itself (unmodified) doing the speaking
  // either way. The window is moved off-screen so it never flashes onto
  // the display, but it's still a real GUI window — that appears to be
  // what the eligibility check actually wants, not foreground focus.
  function speak(text) {
    hush();

    // Siri/Personal voices aren't addressable via `say -v`; omitting -v uses
    // whatever's set as the system voice in Spoken Content. Same env knobs
    // Pearl uses — one human, one physical voice, not a second config.
    const voice = process.env.PEARL_VOICE?.trim();
    const rate = process.env.PEARL_SPEECH_RATE?.trim() || "210";
    // `say` has no volume flag; the embedded [[volm]] command is the only knob.
    const volume = process.env.PEARL_SPEECH_VOLUME?.trim() || "0.4";
    const tone = process.env.PEARL_SPEECH_TONE?.trim() || "/System/Library/Sounds/Hero.aiff";
    const voiceArgs = voice ? ["-v", voice] : [];
    const sayArgs = [...voiceArgs, "-r", rate];
    const bufferContent = `[[volm ${volume}]] ${text}`;

    // Sync so the tone finishes before speech starts; a missing sound file
    // shouldn't cost the message itself.
    // reliability-allow err-no-swallow: a missing/unreadable tone file is cosmetic — the message still needs to speak either way.
    try {
      execFileSync("/usr/bin/afplay", ["-v", volume, tone]);
    } catch {}

    // isITermRunning() keeps a closed iTerm2 from ever being launched just
    // to relay through it — direct spawn is the path whenever it's not
    // already open, not only when the relay itself errors out.
    if (isITermRunning()) {
      try {
        speakViaITermWindow(sayArgs, bufferContent);
        return;
      } catch {
        // Automation permission not granted yet, a transient AppleEvent
        // failure, anything else — fall back below. Not Personal-Voice-
        // capable, but it still speaks.
      }
    }
    speakDirect(sayArgs, bufferContent);
  }

  // Run once per invocation (caller's job, same as pearl-speak.js's main())
  // so a window orphaned by a crash doesn't sit there (off-screen, so
  // invisible) indefinitely. Gated on this instance's own pid being
  // dead/absent: a live `hush()` reaps too, and at that exact moment the
  // recorded say pid is still alive by definition — that's what's being
  // hushed. Sweeping on name alone would close that legitimate,
  // still-speaking window out from under it instead of leaving hush()'s
  // own kill to close it properly.
  function reapOrphanedRelayWindows() {
    if (!isITermRunning()) return;
    if (isPidAlive(readPid())) return;
    try {
      execFileSync(OSASCRIPT, [
        "-e",
        `tell application "iTerm2"
  repeat with w in windows
    try
      if (name of current session of w) is "${relaySessionName}" then close w
    end try
  end repeat
end tell`,
      ]);
    } catch {
      // reliability-allow err-no-swallow: best-effort cleanup of a cosmetic
      // leak (an invisible, off-screen window) — failing here shouldn't
      // block speech, and there's nothing more specific to log than
      // "osascript failed," already implied by this being unreachable.
    }
  }

  return { speak, hush, buildRelayScript, reapOrphanedRelayWindows };
}

export function voiceStatePaths(stateDir) {
  return {
    sayPidPath: join(stateDir, "say.pid"),
    speakBufferPath: join(stateDir, "speak-buffer.txt"),
    speakScriptPath: join(stateDir, "speak-run.sh"),
  };
}

export function voiceStateExists(stateDir) {
  return existsSync(join(stateDir, "say.pid"));
}
