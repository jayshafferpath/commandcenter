// Pearl's on-demand speech. The Stop hook (wired in only for her own
// session — see pearl.js's --settings arg) runs this with no subcommand and
// caches her condensed reply; it's only spoken when Jay asks via a hotkey
// (`say`), or when a turn was started by voice (`ask`, for a dictation tool
// that can shell out directly; `arm`, for one like Wispr Flow that can only
// autotype into the focused field — see .plans/push-to-talk-wispr.md).
// `hush` cuts speech off. Dispatched jobs never load this.

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { openSessionInIterm } from "./run-command.js";
import { SESSION } from "./pearl.js";

const TMUX = "/opt/homebrew/bin/tmux";

// Below this, a reply is already short enough to just speak — skipping the
// haiku round-trip saves the latency/cost on the common SOUL.md-style
// one-line confirmation.
const SUMMARIZE_THRESHOLD_CHARS = 80;

// Ceiling for what gets spoken when condensing fails, so a summarize
// timeout can't turn into reading a whole multi-paragraph reply aloud.
const FALLBACK_MAX_CHARS = 250;

const STATE_DIR = join(homedir(), ".pearl");
const LAST_REPLY_PATH = join(STATE_DIR, "last-reply.txt");
const SAY_PID_PATH = join(STATE_DIR, "say.pid");
// Set by `ask` so the reply to a spoken message is spoken back; the next
// Stop hook consumes it.
const SPEAK_NEXT_PATH = join(STATE_DIR, "speak-next");

export function extractLastAssistantText(lines) {
  let lastAssistant = null;
  for (const line of lines) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry?.type === "assistant") lastAssistant = entry;
  }

  const blocks = lastAssistant?.message?.content;
  if (!Array.isArray(blocks)) return "";

  return blocks
    .filter((block) => block?.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

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

// Condenses a long reply down to its core idea before speaking it, so
// Pearl doesn't read whole paragraphs aloud. Falls back to the reply's
// opening sentence on any failure (timeout, no auth, etc.) — losing the
// condensing is better than losing the message.
export function summarizeForSpeech(text) {
  if (text.length < SUMMARIZE_THRESHOLD_CHARS) return text;

  try {
    const summary = execFileSync(
      "claude",
      [
        "-p",
        `Summarize the core idea of this in one short spoken sentence. No preamble, no quotes, just the sentence:\n\n${text}`,
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

function readPid() {
  try {
    const pid = Number.parseInt(readFileSync(SAY_PID_PATH, "utf-8"), 10);
    return Number.isInteger(pid) ? pid : null;
  } catch {
    return null;
  }
}

export function hush() {
  const pid = readPid();
  rmSync(SAY_PID_PATH, { force: true });
  if (!pid) return;

  try {
    process.kill(pid);
  } catch {
    // Already finished speaking — nothing to stop.
  }
}

function speak(text) {
  hush();

  // Siri voices aren't addressable via `say -v`; omitting -v uses the system voice set in Spoken Content.
  const voice = process.env.PEARL_VOICE?.trim();
  const rate = process.env.PEARL_SPEECH_RATE?.trim() || "210";
  const voiceArgs = voice ? ["-v", voice] : [];
  const child = spawn("/usr/bin/say", [...voiceArgs, "-r", rate], {
    detached: true,
    stdio: ["pipe", "ignore", "ignore"],
  });
  writeFileSync(SAY_PID_PATH, String(child.pid));
  child.stdin.write(text);
  child.stdin.end();
  child.unref();
}

function speakLastReply() {
  let text;
  try {
    text = readFileSync(LAST_REPLY_PATH, "utf-8").trim();
  } catch {
    return;
  }
  if (text) speak(text);
}

async function captureReply() {
  const stdin = await new Promise((res) => {
    let data = "";
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => res(data));
  });

  let hookInput;
  try {
    hookInput = JSON.parse(stdin);
  } catch {
    return;
  }

  const transcriptPath = hookInput?.transcript_path;
  if (!transcriptPath) return;

  let content;
  try {
    content = readFileSync(transcriptPath, "utf-8");
  } catch {
    return;
  }

  const text = cleanForSpeech(extractLastAssistantText(content.split("\n")));
  if (!text) return;

  const spoken = summarizeForSpeech(text);
  writeFileSync(LAST_REPLY_PATH, spoken);

  if (existsSync(SPEAK_NEXT_PATH)) {
    rmSync(SPEAK_NEXT_PATH, { force: true });
    speak(spoken);
  }
}

// Typing blind into a TUI is only safe when her chat input box is showing:
// a `❯` line framed by the box's top and bottom borders. A permission
// dialog or menu also uses `❯` for its cursor, but not between borders —
// injecting text plus Enter there could answer the dialog.
export function isAtChatPrompt(paneText) {
  const lines = paneText.split("\n");
  const promptIndex = lines.findLastIndex((line) => line.startsWith("❯"));
  if (promptIndex <= 0) return false;

  const isBorder = (line) => line?.startsWith("─") ?? false;
  return isBorder(lines[promptIndex - 1]) && isBorder(lines[promptIndex + 1]);
}

function capturePane() {
  return execFileSync(TMUX, ["capture-pane", "-p", "-t", SESSION], { encoding: "utf-8" });
}

function ask() {
  const message = process.argv.slice(3).join(" ").trim();
  if (!message) return;

  let pane;
  try {
    pane = capturePane();
  } catch {
    speak("I'm not running, Boss.");
    return;
  }

  if (!isAtChatPrompt(pane)) {
    speak("I'm stuck on a prompt, Boss. Check my window.");
    return;
  }

  hush();
  writeFileSync(SPEAK_NEXT_PATH, "");
  execFileSync(TMUX, ["send-keys", "-t", SESSION, "-l", message]);
  execFileSync(TMUX, ["send-keys", "-t", SESSION, "Enter"]);
}

const ARM_TIMEOUT_MS = 20_000;
const ARM_POLL_INTERVAL_MS = 400;
const ARM_QUIET_MS = 700;

// Pure decision step for the arm() watch loop: given the previous
// pane/timing state and a fresh pane snapshot, says whether the pane just
// changed, and whether it's been quiet long enough since its last change
// to treat Flow's autotype as finished.
export function nextWatchState({ lastPane, lastChangeAt }, pane, now, quietMs) {
  if (pane !== lastPane) {
    return { lastPane: pane, lastChangeAt: now, shouldSubmit: false };
  }
  return {
    lastPane,
    lastChangeAt,
    shouldSubmit: lastChangeAt !== null && now - lastChangeAt >= quietMs,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Watches for Wispr Flow's autotype to land and settle, then presses
// Enter — the "lightweight way to auto-press Enter" `arm()`'s doc comment
// promises, since Flow itself has no auto-submit setting. Bounded so a
// dictation that never happens (or never finishes) just times out quietly
// instead of leaving anything armed to fire later on its own.
async function waitForDictationThenSubmit(baselinePane) {
  const deadline = Date.now() + ARM_TIMEOUT_MS;
  let state = { lastPane: baselinePane, lastChangeAt: null };

  while (Date.now() < deadline) {
    await sleep(ARM_POLL_INTERVAL_MS);

    let pane;
    try {
      pane = capturePane();
    } catch {
      return;
    }

    state = nextWatchState(state, pane, Date.now(), ARM_QUIET_MS);
    if (!state.shouldSubmit) continue;

    // Re-check right before the one irreversible action — the pane could
    // have changed again (a dialog, a crash) since the snapshot above.
    if (!isAtChatPrompt(pane)) return;
    execFileSync(TMUX, ["send-keys", "-t", SESSION, "Enter"]);
    return;
  }
}

// Entry point for a dictation tool that can only autotype into whatever
// has keyboard focus (Wispr Flow): raise Pearl's window, refuse unless
// she's actually at her chat prompt, arm speak-next, then watch for the
// autotyped text to land and submit it.
async function arm() {
  let pane;
  try {
    pane = capturePane();
  } catch {
    speak("I'm not running, Boss.");
    return;
  }

  if (!isAtChatPrompt(pane)) {
    speak("I'm stuck on a prompt, Boss. Check my window.");
    return;
  }

  openSessionInIterm(SESSION);
  hush();
  writeFileSync(SPEAK_NEXT_PATH, "");
  await waitForDictationThenSubmit(pane);
}

const COMMANDS = {
  ask,
  arm,
  say: speakLastReply,
  hush,
};

async function main() {
  if (process.platform !== "darwin") return;

  mkdirSync(STATE_DIR, { recursive: true });
  const command = COMMANDS[process.argv[2]];
  if (command) return command();
  return captureReply();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
