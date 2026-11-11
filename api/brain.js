// Brain View storage: a per-job canvas a dispatched agent rewrites in full
// whenever it wants to present something to the user. Lives centrally under the
// user's home dir rather than the job's cwd, because a dispatched agent
// runs in whatever repo the ticket resolved to, not in this one.
//
//   ~/.commandcenter/brain/<jobId>/canvas.md    Markdown (+ Mermaid)
//   ~/.commandcenter/brain/<jobId>/canvas.html  a full HTML page, sandboxed
//
// A sibling file rather than sniffing canvas.md for a leading <!doctype>:
// Markdown can legitimately start with a literal "<", and the agent picking
// a filename is a clearer signal than any guess about its content.

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CANVAS_FILENAME = "canvas.md";
const HTML_CANVAS_FILENAME = "canvas.html";

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

export function htmlCanvasPathFor(jobId) {
  return join(brainDirFor(jobId), HTML_CANVAS_FILENAME);
}

function hasContent(path) {
  return existsSync(path) && statSync(path).size > 0;
}

// A non-empty canvas.html wins over canvas.md: an agent that has started
// building a page wants that page shown, and emptying canvas.html is how it
// hands the view back to its Markdown. Falls back to canvas.md even when
// that's empty too, so an untouched canvas still reads as present-but-blank.
export function activeCanvas(jobId) {
  const htmlPath = htmlCanvasPathFor(jobId);
  if (hasContent(htmlPath)) return { format: "html", path: htmlPath };
  const markdownPath = canvasPathFor(jobId);
  if (existsSync(markdownPath)) return { format: "markdown", path: markdownPath };
  return null;
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

// Every dispatched job gets a canvas (see server.js /api/dispatch) and the
// agent decides for itself whether to use it — so "has a brain dir" would
// always be true and the dashboard would show a link on every session
// whether or not anything was ever written there. This checks for actual
// content instead, which is what makes the link opt-in in practice.
export function hasBrainContent(jobId) {
  return hasContent(htmlCanvasPathFor(jobId)) || hasContent(canvasPathFor(jobId));
}

export function readBrain(jobId) {
  const canvas = activeCanvas(jobId);
  if (!canvas) return null;
  return {
    format: canvas.format,
    content: readFileSync(canvas.path, "utf-8"),
    updatedAt: statSync(canvas.path).mtime.toISOString(),
  };
}

// Appended to every dispatched agent's composedPrompt. Just the path and a
// pointer: how to use the canvas lives in the /cc-brain-view skill. The path
// can't move there, since it's different for every job. Unconditional: the
// agent decides whether to use it, and a dashboard link only appears once
// the file has content (see hasBrainContent).
export function brainInstructions(canvasPath) {
  return [
    "---",
    "",
    `Optional: you have a Brain View canvas at ${canvasPath} that the user can watch while you work.`,
    "Most sessions never use it. If you want to show your thinking there, load /cc-brain-view first.",
  ].join("\n");
}
