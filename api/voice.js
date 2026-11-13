// Generic voice for any dispatched agent (see .plans/interactive-review-loop.md
// and the "Voice for review-walkthrough sessions" plan, where this started
// before being generalized): speaks text aloud through the same say/relay
// mechanics Pearl uses, as its own independent instance per scope id — own
// state dir, own relay window name — so hushing or reaping one scope can
// never touch Pearl's or another scope's in-flight utterance. Thin by
// design, parallel to brain.js: no in-memory state, so nothing here needs
// caching across requests.
//
// Not tied to review sessions, jobs, or any other registry — any id an
// agent chooses gets its own isolated voice. The review-walkthrough skill
// happens to use its reviewId; a dispatched ticket job would use its jobId
// (see brainInstructions-style wiring in server.js's /api/dispatch).

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createVoice, summarizeForSpeech } from "./lib/speak.js";

// Scope ids flow straight into a directory path and into an AppleScript
// string literal (the relay window's name) — restricting the charset here
// is what keeps an arbitrary caller-chosen id from being able to break out
// of either. Same shape as every other id already used as a path segment
// in this app (UUIDs), just enforced rather than assumed, since this is the
// one place an id is agent-chosen text rather than always a server-
// generated UUID.
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

export function isValidVoiceId(id) {
  return typeof id === "string" && SAFE_ID.test(id);
}

function voiceDirFor(id) {
  return join(homedir(), ".commandcenter", "voice", id);
}

function relayNameFor(id) {
  return `cc-voice-${id}`;
}

function voiceFor(id) {
  const stateDir = voiceDirFor(id);
  mkdirSync(stateDir, { recursive: true });
  return createVoice({ stateDir, relaySessionName: relayNameFor(id) });
}

// Condenses first (same pipeline Pearl's captureReply uses: clean → summarize
// → speak — no cleanForSpeech pass here, since callers hand this plain
// narration prose, not a chat reply with markdown/code fences to strip)
// so a long message doesn't turn into several paragraphs read aloud.
export function speak(id, text) {
  if (process.platform !== "darwin") {
    return { ok: false, error: "Voice only works on macOS" };
  }
  const voice = voiceFor(id);
  voice.reapOrphanedRelayWindows();
  voice.speak(summarizeForSpeech(text));
  return { ok: true };
}

export function hush(id) {
  if (process.platform !== "darwin") {
    return { ok: false, error: "Voice only works on macOS" };
  }
  voiceFor(id).hush();
  return { ok: true };
}

// Appended to a dispatched agent's composedPrompt, same spirit as
// brain.js's brainInstructions — unconditional (every job gets it), the
// agent decides whether to use it. How to use it lives in /cc-voice, not
// here, so this stays short even as that skill grows.
export function voiceInstructions(id, apiBase) {
  return [
    "---",
    "",
    `Optional: you can speak text aloud, via POST ${apiBase}/api/voice/${id}/speak with {"text": "..."}.`,
    "Most sessions never use it. If you want to, load /cc-voice first.",
  ].join("\n");
}
