// Pearl's Stop hook: speaks her reply aloud in a British voice. Wired in
// only for her own session (see pearl.js's --settings arg) — dispatched
// jobs never load this.

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

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

function speak(text) {
  const voice = process.env.PEARL_VOICE?.trim() || "Daniel";
  const child = spawn("say", ["-v", voice], { stdio: ["pipe", "ignore", "ignore"] });
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
  if (text) speak(text);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
