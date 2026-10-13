import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  extractRepoFromDescription,
  extractRepoLabel,
  repoNotFoundError,
  resolveRepoRoot,
} from "../api/lib/util.js";

describe("extractRepoLabel", () => {
  it("returns the name after repo:", () => {
    expect(extractRepoLabel(["repo:notifications", "other"])).toBe("notifications");
  });

  it("returns null when no repo: label is present", () => {
    expect(extractRepoLabel(["other"])).toBeNull();
  });

  it("returns null for missing/empty labels", () => {
    expect(extractRepoLabel(undefined)).toBeNull();
    expect(extractRepoLabel([])).toBeNull();
  });
});

describe("extractRepoFromDescription", () => {
  it("matches a plain Repo: line", () => {
    expect(extractRepoFromDescription("Repo: notifications\n\nSome body")).toBe("notifications");
  });

  it("matches a bold and backticked Repo: line", () => {
    expect(extractRepoFromDescription("**Repo:** `commandcenter`\n\nmore text")).toBe(
      "commandcenter",
    );
  });

  it("returns null when there is no Repo: line", () => {
    expect(extractRepoFromDescription("Just a description, no repo line.")).toBeNull();
  });

  it("returns null for empty/missing description", () => {
    expect(extractRepoFromDescription(null)).toBeNull();
    expect(extractRepoFromDescription("")).toBeNull();
  });
});

describe("resolveRepoRoot", () => {
  let devRoot;

  beforeEach(() => {
    devRoot = mkdtempSync(join(tmpdir(), "resolve-repo-root-"));
    mkdirSync(join(devRoot, "commandcenter"));
  });

  afterEach(() => {
    rmSync(devRoot, { recursive: true, force: true });
  });

  it("returns null root/name/source when devRoot is falsy", () => {
    expect(resolveRepoRoot(null, { labels: ["repo:commandcenter"] })).toEqual({
      root: null,
      name: null,
      source: null,
    });
  });

  it("resolves from the ticket's own label first", () => {
    const result = resolveRepoRoot(devRoot, {
      labels: ["repo:commandcenter"],
      parentLabels: ["repo:notifications"],
      description: "Repo: other",
    });
    expect(result).toEqual({
      root: join(devRoot, "commandcenter"),
      name: "commandcenter",
      source: "label",
    });
  });

  it("falls back to the parent's label when the ticket has none", () => {
    const result = resolveRepoRoot(devRoot, {
      labels: [],
      parentLabels: ["repo:commandcenter"],
      description: null,
    });
    expect(result).toEqual({
      root: join(devRoot, "commandcenter"),
      name: "commandcenter",
      source: "parent label",
    });
  });

  it("falls back to a Repo: line in the description when neither label is set", () => {
    const result = resolveRepoRoot(devRoot, {
      labels: [],
      parentLabels: [],
      description: "**Repo:** `commandcenter`\n\nmore text",
    });
    expect(result).toEqual({
      root: join(devRoot, "commandcenter"),
      name: "commandcenter",
      source: "description",
    });
  });

  it("names the repo but returns a null root when the matched clone doesn't exist", () => {
    const result = resolveRepoRoot(devRoot, {
      labels: ["repo:not-cloned"],
      parentLabels: [],
      description: null,
    });
    expect(result).toEqual({ root: null, name: "not-cloned", source: "label" });
  });

  it("returns null root/name/source when nothing names a repo", () => {
    const result = resolveRepoRoot(devRoot, { labels: [], parentLabels: [], description: null });
    expect(result).toEqual({ root: null, name: null, source: null });
  });

  it("stops at the first source that names a repo, even if a later source is cloned", () => {
    const result = resolveRepoRoot(devRoot, {
      labels: ["repo:not-cloned"],
      parentLabels: ["repo:commandcenter"],
      description: null,
    });
    expect(result).toEqual({ root: null, name: "not-cloned", source: "label" });
  });
});

describe("repoNotFoundError", () => {
  it("formats a plain label source", () => {
    expect(repoNotFoundError("notifications", "label", "/dev")).toBe(
      "repo:notifications → /dev/notifications not found",
    );
  });

  it("formats a parent label source", () => {
    expect(repoNotFoundError("notifications", "parent label", "/dev")).toBe(
      "repo:notifications (parent's label) → /dev/notifications not found",
    );
  });

  it("formats a description source", () => {
    expect(repoNotFoundError("notifications", "description", "/dev")).toBe(
      "Repo: notifications (from description) → /dev/notifications not found",
    );
  });
});
