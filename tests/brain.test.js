import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let fakeHome;

// brain.js resolves its root lazily via os.homedir() precisely so this works —
// a module-level constant would have frozen in the real home dir before this
// mock ever ran.
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, homedir: () => fakeHome };
});

const { brainDirFor, brainInstructions, canvasPathFor, ensureBrainDir, hasBrainDir, readBrain } =
  await import("../api/brain.js");

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), "brain-test-"));
});

afterEach(() => {
  rmSync(fakeHome, { recursive: true, force: true });
});

describe("ensureBrainDir", () => {
  it("creates an empty canvas file", () => {
    ensureBrainDir("job-1");
    expect(readFileSync(canvasPathFor("job-1"), "utf-8")).toBe("");
  });

  it("does not clobber an existing canvas", () => {
    ensureBrainDir("job-1");
    writeFileSync(canvasPathFor("job-1"), "already here", "utf-8");
    ensureBrainDir("job-1");
    expect(readFileSync(canvasPathFor("job-1"), "utf-8")).toBe("already here");
  });

  it("returns the job's brain dir", () => {
    expect(ensureBrainDir("job-1")).toBe(brainDirFor("job-1"));
    expect(existsSync(brainDirFor("job-1"))).toBe(true);
  });
});

describe("hasBrainDir", () => {
  it("is false until ensureBrainDir has run", () => {
    expect(hasBrainDir("job-1")).toBe(false);
  });

  it("is true once a canvas exists", () => {
    ensureBrainDir("job-1");
    expect(hasBrainDir("job-1")).toBe(true);
  });
});

describe("readBrain", () => {
  it("returns null when there's no brain dir for this job", () => {
    expect(readBrain("job-1")).toBeNull();
  });

  it("returns the current content and updatedAt", () => {
    ensureBrainDir("job-1");
    writeFileSync(canvasPathFor("job-1"), "# notes", "utf-8");
    const brain = readBrain("job-1");
    expect(brain.content).toBe("# notes");
    expect(typeof brain.updatedAt).toBe("string");
  });

  it("reflects a full rewrite", () => {
    ensureBrainDir("job-1");
    writeFileSync(canvasPathFor("job-1"), "# v1", "utf-8");
    writeFileSync(canvasPathFor("job-1"), "# v2", "utf-8");
    expect(readBrain("job-1").content).toBe("# v2");
  });
});

describe("brainDirFor / canvasPathFor", () => {
  it("scopes every path under the job id", () => {
    expect(brainDirFor("job-1")).toBe(join(fakeHome, ".commandcenter", "brain", "job-1"));
    expect(canvasPathFor("job-1")).toBe(
      join(fakeHome, ".commandcenter", "brain", "job-1", "canvas.md"),
    );
  });

  it("gives different jobs different dirs", () => {
    expect(brainDirFor("job-1")).not.toBe(brainDirFor("job-2"));
  });
});

describe("brainInstructions", () => {
  it("includes the canvas path and the rewrite-whole-file rule", () => {
    const text = brainInstructions("/tmp/foo/canvas.md");
    expect(text).toContain("/tmp/foo/canvas.md");
    expect(text).toContain("Rewrite the whole file");
  });

  it("tells the agent not to use it as a progress log", () => {
    expect(brainInstructions("/x").toLowerCase()).toContain("not a progress log");
  });

  it("documents the markdown + mermaid format with no raw HTML", () => {
    const text = brainInstructions("/x");
    expect(text).toContain("```mermaid");
    expect(text).toContain("No raw");
  });
});
