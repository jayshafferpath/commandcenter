// Brain View storage: a per-job canvas a dispatched agent rewrites in full
// each time it wants Jay to see its current thinking. Lives centrally under
// the user's home dir rather than the job's cwd, because a dispatched agent
// runs in whatever repo the ticket resolved to, not in this one.
//
//   ~/.commandcenter/brain/<jobId>/
//     canvas.md          current state, written by the agent
//     snapshots/
//       <iso-timestamp>.md
//
// The agent only ever touches canvas.md — it doesn't know versioning exists.
// Every read from the dashboard (GET /api/jobs/:id/brain) first calls
// snapshotIfChanged, which hashes the current content against the most
// recent snapshot and, on a mismatch, files the current content away as a
// new snapshot. That turns "poll and notice it changed" into a history a
// human can scrub, without the agent having to cooperate with it.

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CANVAS_FILENAME = "canvas.md";
const MAX_SNAPSHOTS = 200;

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

function snapshotsDirFor(jobId) {
  return join(brainDirFor(jobId), "snapshots");
}

function snapshotPathFor(jobId, ts) {
  return join(snapshotsDirFor(jobId), `${ts}.md`);
}

function hash(content) {
  return createHash("sha256").update(content).digest("hex");
}

// Called once, at dispatch time, before the job's composedPrompt (which
// needs the canvas path) and tmux invocation (which needs the dir for
// --add-dir) both exist.
export function ensureBrainDir(jobId) {
  const dir = brainDirFor(jobId);
  mkdirSync(snapshotsDirFor(jobId), { recursive: true });
  if (!existsSync(canvasPathFor(jobId))) {
    writeFileSync(canvasPathFor(jobId), "", "utf-8");
  }
  return dir;
}

export function hasBrainDir(jobId) {
  return existsSync(canvasPathFor(jobId));
}

// Snapshot timestamps sort correctly as plain strings because they're ISO
// 8601 with colons swapped for dashes (filesystem-safe, still
// lexicographically chronological). The counter suffix guards against two
// snapshots landing in the same millisecond (a fast rewrite loop, or this
// module's own tests) from colliding on the same filename or, worse,
// sorting out of order relative to each other.
let snapshotSeq = 0;
function tsNow() {
  const iso = new Date().toISOString().replace(/:/g, "-");
  snapshotSeq += 1;
  return `${iso}-${String(snapshotSeq).padStart(6, "0")}`;
}

function listSnapshotFiles(jobId) {
  try {
    return readdirSync(snapshotsDirFor(jobId))
      .filter((name) => name.endsWith(".md"))
      .sort();
  } catch {
    return [];
  }
}

// Prunes oldest-first once the cap is exceeded — a long-running job
// shouldn't grow its snapshot dir without bound just because the agent kept
// rewriting the canvas for hours.
function pruneSnapshots(jobId) {
  const files = listSnapshotFiles(jobId);
  const excess = files.length - MAX_SNAPSHOTS;
  if (excess <= 0) return;
  for (const name of files.slice(0, excess)) {
    try {
      unlinkSync(join(snapshotsDirFor(jobId), name));
    } catch {
      // Best-effort — a failed prune just leaves one extra snapshot file.
    }
  }
}

// Files the canvas's current content as a new snapshot if it differs from
// the most recent one on disk (or there's no snapshot yet and the canvas
// isn't empty). No-op when the canvas file doesn't exist at all.
export function snapshotIfChanged(jobId) {
  const canvasPath = canvasPathFor(jobId);
  if (!existsSync(canvasPath)) return false;

  const content = readFileSync(canvasPath, "utf-8");
  if (!content) return false;

  const files = listSnapshotFiles(jobId);
  const latest = files[files.length - 1];
  const latestContent = latest
    ? readFileSync(join(snapshotsDirFor(jobId), latest), "utf-8")
    : null;

  if (latestContent !== null && hash(latestContent) === hash(content)) {
    return false;
  }

  mkdirSync(snapshotsDirFor(jobId), { recursive: true });
  writeFileSync(snapshotPathFor(jobId, tsNow()), content, "utf-8");
  pruneSnapshots(jobId);
  return true;
}

// Current canvas state. Snapshotting happens here (not on a timer) so a
// snapshot is only ever taken when something is actually about to read it.
export function readBrain(jobId) {
  const canvasPath = canvasPathFor(jobId);
  if (!existsSync(canvasPath)) return null;

  snapshotIfChanged(jobId);

  return {
    content: readFileSync(canvasPath, "utf-8"),
    updatedAt: statSync(canvasPath).mtime.toISOString(),
    snapshotCount: listSnapshotFiles(jobId).length,
  };
}

export function listSnapshots(jobId) {
  return listSnapshotFiles(jobId).map((name) => name.slice(0, -".md".length));
}

export function readSnapshot(jobId, ts) {
  const path = snapshotPathFor(jobId, ts);
  if (!existsSync(path)) return null;
  return { content: readFileSync(path, "utf-8") };
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

export const __test__ = {
  brainRoot,
  MAX_SNAPSHOTS,
  canvasPathFor,
  snapshotsDirFor,
  snapshotPathFor,
  hash,
  tsNow,
  listSnapshotFiles,
  pruneSnapshots,
};
