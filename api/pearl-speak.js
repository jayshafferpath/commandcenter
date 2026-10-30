// Pearl's on-demand speech. The Stop hook (wired in only for her own
// session — see pearl.js's --settings arg) runs this with no subcommand and
// caches her condensed reply; it's only spoken when Jay asks via a hotkey
// (`say`), or when a turn was started by voice (`ask`, for a dictation tool
// that can shell out directly with the text already known; `preflight` +
// `voice`, the push-to-talk pair driven by Superwhisper's CLI — see
// .plans/push-to-talk-wispr.md). `hush` cuts speech off. Dispatched jobs
// never load this.

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { SESSION } from "./lib/pearl-session.js";

const TMUX = "/opt/homebrew/bin/tmux";

// Superwhisper's CLI (installed separately via its install-cli.sh, not by
// the app bundle itself) lands in ~/.local/bin, not on the minimal PATH a
// global hotkey tool like Hammerspoon runs with — same reasoning as TMUX
// above. Overridable in case Jay's install lands somewhere else.
const SUPERWHISPER_BIN =
  process.env.PEARL_SUPERWHISPER_BIN?.trim() || join(homedir(), ".local/bin/superwhisper");

// Set this to a mode key (Superwhisper Settings → that mode → its key) once
// Jay has configured one with a local voice model and no language-model
// stage. `preflight` switches to it before every recording so Pearl's voice
// path can't silently end up on whatever mode happens to be active
// elsewhere — which, out of the box, uses Superwhisper's cloud model. Left
// unset, `preflight` just uses whatever mode is already active: the easier
// path to a mistake, but not this script's call to force without a key.
const SUPERWHISPER_MODE = process.env.PEARL_SUPERWHISPER_MODE?.trim() || "";

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
// Set by `preflight` right before Superwhisper starts recording; `voice`
// reads and clears it once that recording's transcript shows up.
const VOICE_BASELINE_PATH = join(STATE_DIR, "voice-baseline.json");

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
  // `say` has no volume flag; the embedded [[volm]] command is the only knob.
  const volume = process.env.PEARL_SPEECH_VOLUME?.trim() || "0.4";
  const tone = process.env.PEARL_SPEECH_TONE?.trim() || "/System/Library/Sounds/Hero.aiff";
  const voiceArgs = voice ? ["-v", voice] : [];

  // Sync so the tone finishes before speech starts; a missing sound file
  // shouldn't cost the message itself.
  try {
    execFileSync("/usr/bin/afplay", ["-v", volume, tone]);
    execFileSync("/usr/bin/afplay", ["-v", volume, tone]);
  } catch {}

  const child = spawn("/usr/bin/say", [...voiceArgs, "-r", rate], {
    detached: true,
    stdio: ["pipe", "ignore", "ignore"],
  });
  writeFileSync(SAY_PID_PATH, String(child.pid));
  child.stdin.write(`[[volm ${volume}]] ${text}`);
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

// Shared by `ask` (text already known) and `voice` (text fetched from
// Superwhisper after the fact) — the one place that actually injects
// something into Pearl's pane, so the isAtChatPrompt guard only needs
// maintaining here.
function sendToChat(message) {
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

function ask() {
  const message = process.argv.slice(3).join(" ").trim();
  if (!message) return;
  sendToChat(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Raw (not `--json`-wrapped-in-an-array — `read --json` is a single
// object) snapshot of Superwhisper's latest transcription, used as an
// opaque comparison token: `voice()` just needs to tell "a new one
// appeared" from "nothing's landed yet", not parse anything here.
function latestTranscriptSnapshot() {
  try {
    return execFileSync(SUPERWHISPER_BIN, ["read", "--json"], { encoding: "utf-8" });
  } catch {
    return "";
  }
}

// `rawResult`, not `llmResult` — Pearl should get what Jay actually said,
// not a mode's language-model cleanup pass (which, depending on how that
// mode is configured, might not even be a local call).
export function transcriptText(snapshot) {
  try {
    return (JSON.parse(snapshot)?.rawResult ?? "").trim();
  } catch {
    return "";
  }
}

// Run on key-down, before Superwhisper starts recording: refuses before
// any audio is captured, same as `ask` refuses before typing anything.
// Also pins the mode (if configured) and records what "nothing new yet"
// looks like, so `voice()` can recognize this recording's transcript once
// it lands instead of re-sending whatever was already in the history.
function preflight() {
  let pane;
  try {
    pane = capturePane();
  } catch {
    speak("I'm not running, Boss.");
    process.exitCode = 1;
    return;
  }

  if (!isAtChatPrompt(pane)) {
    speak("I'm stuck on a prompt, Boss. Check my window.");
    process.exitCode = 1;
    return;
  }

  if (SUPERWHISPER_MODE) {
    // Refuse rather than record: whatever mode is active instead could be
    // a cloud one, and audio must never leave the machine.
    try {
      execFileSync(SUPERWHISPER_BIN, ["switch", SUPERWHISPER_MODE]);
    } catch {
      speak("I couldn't switch Superwhisper to local mode, Boss. Not recording.");
      process.exitCode = 1;
      return;
    }
  }

  writeFileSync(VOICE_BASELINE_PATH, latestTranscriptSnapshot());
}

const VOICE_TIMEOUT_MS = 10_000;
const VOICE_POLL_INTERVAL_MS = 300;

// Run on key-up, after Superwhisper has been told to stop: polls for the
// just-finished transcription to show up, then sends it exactly like
// `ask` would. Bounded so a recording that never produced a transcript
// (silence, a dropped `start`) just times out instead of eventually
// sending something stale.
async function voice() {
  let baseline;
  try {
    baseline = readFileSync(VOICE_BASELINE_PATH, "utf-8");
  } catch {
    return;
  }
  rmSync(VOICE_BASELINE_PATH, { force: true });

  const deadline = Date.now() + VOICE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(VOICE_POLL_INTERVAL_MS);

    const latest = latestTranscriptSnapshot();
    if (!latest || latest === baseline) continue;

    const text = transcriptText(latest);
    if (text) sendToChat(text);
    return;
  }
}

const COMMANDS = {
  ask,
  preflight,
  voice,
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
