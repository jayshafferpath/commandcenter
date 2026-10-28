// Pearl's Stop hook: speaks her reply aloud. Wired in only for her own
// session (see pearl.js's --settings arg) — dispatched jobs never load
// this.

import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";

// Below this, a reply is already short enough to just speak — skipping the
// haiku round-trip saves the latency/cost on the common SOUL.md-style
// one-line confirmation.
const SUMMARIZE_THRESHOLD_CHARS = 80;

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

// Condenses a long reply down to its core idea before speaking it, so
// Pearl doesn't read whole paragraphs aloud. Falls back to the original
// text on any failure (timeout, no auth, etc.) — losing the condensing is
// better than losing the message.
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
    return summary || text;
  } catch {
    return text;
  }
}

function speak(text) {
  const voice = process.env.PEARL_VOICE?.trim() || "Matilda (Premium)";
  const rate = process.env.PEARL_SPEECH_RATE?.trim() || "240";
  const child = spawn("say", ["-v", voice, "-r", rate], { stdio: ["pipe", "ignore", "ignore"] });
  child.stdin.write(text);
  child.stdin.end();
}

async function main() {
  if (process.platform !== "darwin") return;

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
  if (text) speak(summarizeForSpeech(text));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
