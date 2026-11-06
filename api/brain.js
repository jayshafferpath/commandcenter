// Brain View storage: a per-job canvas a dispatched agent rewrites in full
// whenever it wants to present something to Jay. Lives centrally under the
// user's home dir rather than the job's cwd, because a dispatched agent
// runs in whatever repo the ticket resolved to, not in this one.
//
//   ~/.commandcenter/brain/<jobId>/canvas.md

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CANVAS_FILENAME = "canvas.md";

// A function, not a module-level constant, so tests can mock os.homedir()
// and have it take effect — a constant would freeze in whatever homedir()
// returned at import time, before any test gets a chance to mock it.
function brainRoot() {
  return join(homedir(), ".commandcenter", "brain");
}

export function brainDirFor(jobId) {
  return join(brainRoot(), jobId);
}

export function canvasPathFor(jobId) {
  return join(brainDirFor(jobId), CANVAS_FILENAME);
}

// Called once, at dispatch time, before the job's composedPrompt (which
// needs the canvas path) and tmux invocation (which needs the dir for
// --add-dir) both exist.
export function ensureBrainDir(jobId) {
  const dir = brainDirFor(jobId);
  mkdirSync(dir, { recursive: true });
  if (!existsSync(canvasPathFor(jobId))) {
    writeFileSync(canvasPathFor(jobId), "", "utf-8");
  }
  return dir;
}

export function hasBrainDir(jobId) {
  return existsSync(canvasPathFor(jobId));
}

export function readBrain(jobId) {
  const canvasPath = canvasPathFor(jobId);
  if (!existsSync(canvasPath)) return null;
  return {
    content: readFileSync(canvasPath, "utf-8"),
    updatedAt: statSync(canvasPath).mtime.toISOString(),
  };
}

// What gets appended to composedPrompt when brain: true — a separate
// section from the Pearl status footer, not folded into it, since this one
// is instructions for the agent's own behavior throughout the run rather
// than a one-time final action.
export function brainInstructions(canvasPath) {
  return [
    "---",
    "",
    "Brain View is on for this session: Jay is watching a live canvas at",
    `${canvasPath}`,
    "",
    "Rewrite the whole file each time you update it — it's your current",
    "state of thinking, not a log to append to. Use it for things you'd want",
    "Jay to see as you work: a design you're sketching out, a diagram, notes",
    "you're thinking through out loud. It's not a progress log — skip it if",
    "you have nothing worth showing.",
    "",
    "Format: Markdown, with fenced ```mermaid blocks for diagrams. No raw",
    "HTML.",
  ].join("\n");
}
