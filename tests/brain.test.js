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

const {
  activeCanvas,
  brainDirFor,
  brainInstructions,
  canvasPathFor,
  ensureBrainDir,
  hasBrainContent,
  htmlCanvasPathFor,
  readBrain,
} = await import("../api/brain.js");

const PAGE = "<!doctype html><html><body><h1>Design</h1></body></html>";

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

describe("hasBrainContent", () => {
  it("is false until ensureBrainDir has run", () => {
    expect(hasBrainContent("job-1")).toBe(false);
  });

  it("is false for an empty canvas — every job gets one, most never use it", () => {
    ensureBrainDir("job-1");
    expect(hasBrainContent("job-1")).toBe(false);
  });

  it("is true once the agent actually writes something", () => {
    ensureBrainDir("job-1");
    writeFileSync(canvasPathFor("job-1"), "# notes", "utf-8");
    expect(hasBrainContent("job-1")).toBe(true);
  });

  it("is true when only canvas.html has content", () => {
    ensureBrainDir("job-1");
    writeFileSync(htmlCanvasPathFor("job-1"), PAGE, "utf-8");
    expect(hasBrainContent("job-1")).toBe(true);
  });

  it("is true when both canvases have content", () => {
    ensureBrainDir("job-1");
    writeFileSync(canvasPathFor("job-1"), "# notes", "utf-8");
    writeFileSync(htmlCanvasPathFor("job-1"), PAGE, "utf-8");
    expect(hasBrainContent("job-1")).toBe(true);
  });

  it("is false when both canvases exist but are empty", () => {
    ensureBrainDir("job-1");
    writeFileSync(htmlCanvasPathFor("job-1"), "", "utf-8");
    expect(hasBrainContent("job-1")).toBe(false);
  });
});

describe("activeCanvas", () => {
  it("is null when neither canvas exists", () => {
    expect(activeCanvas("job-1")).toBeNull();
  });

  it("is the Markdown canvas when there's no canvas.html", () => {
    ensureBrainDir("job-1");
    expect(activeCanvas("job-1")).toEqual({ format: "markdown", path: canvasPathFor("job-1") });
  });

  it("prefers a non-empty canvas.html over canvas.md", () => {
    ensureBrainDir("job-1");
    writeFileSync(canvasPathFor("job-1"), "# notes", "utf-8");
    writeFileSync(htmlCanvasPathFor("job-1"), PAGE, "utf-8");
    expect(activeCanvas("job-1")).toEqual({ format: "html", path: htmlCanvasPathFor("job-1") });
  });

  it("falls back to canvas.md once canvas.html is emptied", () => {
    ensureBrainDir("job-1");
    writeFileSync(canvasPathFor("job-1"), "# notes", "utf-8");
    writeFileSync(htmlCanvasPathFor("job-1"), "", "utf-8");
    expect(activeCanvas("job-1")).toEqual({ format: "markdown", path: canvasPathFor("job-1") });
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
    expect(brain.format).toBe("markdown");
    expect(brain.content).toBe("# notes");
    expect(typeof brain.updatedAt).toBe("string");
  });

  it("serves canvas.html, tagged as html, when it has content", () => {
    ensureBrainDir("job-1");
    writeFileSync(canvasPathFor("job-1"), "# notes", "utf-8");
    writeFileSync(htmlCanvasPathFor("job-1"), PAGE, "utf-8");
    const brain = readBrain("job-1");
    expect(brain.format).toBe("html");
    expect(brain.content).toBe(PAGE);
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
    expect(htmlCanvasPathFor("job-1")).toBe(
      join(fakeHome, ".commandcenter", "brain", "job-1", "canvas.html"),
    );
  });

  it("gives different jobs different dirs", () => {
    expect(brainDirFor("job-1")).not.toBe(brainDirFor("job-2"));
  });
});

describe("brainInstructions", () => {
  it("names this job's canvas path", () => {
    expect(brainInstructions("/tmp/foo/canvas.md")).toContain("/tmp/foo/canvas.md");
  });

  it("marks the canvas optional and points at the skill for how to use it", () => {
    const text = brainInstructions("/x");
    expect(text).toContain("Optional");
    expect(text).toContain("/cc-brain-view");
  });
});
