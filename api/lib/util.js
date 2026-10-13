import { execSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { isReviewStatus, LABEL_DISPLAY_ORDER } from "./labels.js";

export function glob(dir, pattern) {
  try {
    return readdirSync(dir).filter((f) => pattern.test(f));
  } catch {
    return [];
  }
}

// Resolve the display state for a ticket. Labels win when present; "PR open"
// is no longer a label, so it is derived from an open PR or a review-flavored
// Jira status via the optional second argument.
export function labelState(labels, { openPr = null, statusName = null } = {}) {
  for (const [label, display] of LABEL_DISPLAY_ORDER) {
    if (labels.includes(label)) return { label, display };
  }
  if (openPr || isReviewStatus(statusName)) {
    return { label: null, display: "PR open" };
  }
  return { label: null, display: "unknown" };
}

export function actionHint(stateLabel) {
  if (stateLabel === "ClaudeStackReady") return "awaiting review";
  if (stateLabel === "ClaudeFailed") return "investigate";
  return null;
}

export function detectWorkDir(workDir, relPath) {
  const explicit = join(workDir, relPath);
  if (existsSync(explicit)) return workDir;

  try {
    const repoRoot = execSync("git rev-parse --show-toplevel", {
      cwd: workDir,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();

    const inRepo = join(repoRoot, relPath);
    if (existsSync(inRepo)) return repoRoot;
  } catch {}

  return null;
}

export function extractRepoLabel(labels) {
  const repoLabel = (labels || []).find((l) => l.startsWith("repo:"));
  return repoLabel ? repoLabel.slice(5) : null;
}

// NEV-2355's subtasks (no label of their own) name their repo in the
// description instead, as a "Repo:" line — optionally bold and/or
// backticked, matching however a given ticket happens to format it.
export function extractRepoFromDescription(description) {
  if (!description) return null;
  const match = description.match(/^\*{0,2}Repo:\*{0,2}\s*`?([\w./-]+)`?\s*$/im);
  return match ? match[1] : null;
}

// Fallback chain for finding which repo a ticket belongs to, since most
// tickets (and nearly all subtasks) carry no repo: label themselves: the
// ticket's own label, then its parent's label, then a "Repo:" line in its
// own description. The first source that names a repo wins — even if that
// repo isn't cloned locally, so the caller can report precisely which
// source/path it checked rather than silently falling through.
export function resolveRepoRoot(devRoot, { labels, parentLabels, description } = {}) {
  if (!devRoot) return { root: null, name: null, source: null };

  const candidates = [
    { source: "label", name: extractRepoLabel(labels) },
    { source: "parent label", name: extractRepoLabel(parentLabels) },
    { source: "description", name: extractRepoFromDescription(description) },
  ];

  for (const { source, name } of candidates) {
    if (!name) continue;
    const root = join(devRoot, name);
    return { root: existsSync(root) ? root : null, name, source };
  }

  return { root: null, name: null, source: null };
}

export function repoNotFoundError(name, source, devRoot) {
  const path = join(devRoot, name);
  const label =
    source === "parent label"
      ? `repo:${name} (parent's label)`
      : source === "description"
        ? `Repo: ${name} (from description)`
        : `repo:${name}`;
  return `${label} → ${path} not found`;
}

export function topologicalSort(tickets, links) {
  const graph = new Map();
  const inDegree = new Map();

  for (const t of tickets) {
    graph.set(t.key, []);
    inDegree.set(t.key, 0);
  }

  for (const { from, to } of links) {
    if (graph.has(from) && graph.has(to)) {
      graph.get(from).push(to);
      inDegree.set(to, (inDegree.get(to) || 0) + 1);
    }
  }

  const queue = [];
  for (const [key, deg] of inDegree) {
    if (deg === 0) queue.push(key);
  }
  queue.sort();

  const sorted = [];
  while (queue.length) {
    const node = queue.shift();
    sorted.push(node);
    for (const neighbor of graph.get(node) || []) {
      inDegree.set(neighbor, inDegree.get(neighbor) - 1);
      if (inDegree.get(neighbor) === 0) queue.push(neighbor);
    }
    queue.sort();
  }

  return sorted;
}
