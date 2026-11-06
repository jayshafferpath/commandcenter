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
  brainDirFor,
  brainInstructions,
  canvasPathFor,
  ensureBrainDir,
  hasBrainDir,
  listSnapshots,
  readBrain,
  readSnapshot,
  snapshotIfChanged,
  __test__,
} = await import("../api/brain.js");

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), "brain-test-"));
});

afterEach(() => {
  rmSync(fakeHome, { recursive: true, force: true });
});

describe("ensureBrainDir", () => {
  it("creates the canvas file and snapshots dir", () => {
    ensureBrainDir("job-1");
    expect(existsSync(canvasPathFor("job-1"))).toBe(true);
    expect(existsSync(__test__.snapshotsDirFor("job-1"))).toBe(true);
  });

  it("does not clobber an existing canvas", () => {
    ensureBrainDir("job-1");
    writeFileSync(canvasPathFor("job-1"), "already here", "utf-8");
    ensureBrainDir("job-1");
    expect(readFileSync(canvasPathFor("job-1"), "utf-8")).toBe("already here");
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

describe("snapshotIfChanged", () => {
  it("is a no-op when the canvas doesn't exist", () => {
    expect(snapshotIfChanged("job-1")).toBe(false);
  });

  it("is a no-op for an empty canvas", () => {
    ensureBrainDir("job-1");
    expect(snapshotIfChanged("job-1")).toBe(false);
    expect(listSnapshots("job-1")).toHaveLength(0);
  });

  it("files a snapshot the first time the canvas has content", () => {
    ensureBrainDir("job-1");
    writeFileSync(canvasPathFor("job-1"), "# thinking v1", "utf-8");
    expect(snapshotIfChanged("job-1")).toBe(true);
    expect(listSnapshots("job-1")).toHaveLength(1);
  });

  it("does not re-snapshot unchanged content", () => {
    ensureBrainDir("job-1");
    writeFileSync(canvasPathFor("job-1"), "# thinking v1", "utf-8");
    snapshotIfChanged("job-1");
    expect(snapshotIfChanged("job-1")).toBe(false);
    expect(listSnapshots("job-1")).toHaveLength(1);
  });

  it("snapshots again once the content actually changes", () => {
    ensureBrainDir("job-1");
    writeFileSync(canvasPathFor("job-1"), "# thinking v1", "utf-8");
    snapshotIfChanged("job-1");
    writeFileSync(canvasPathFor("job-1"), "# thinking v2", "utf-8");
    expect(snapshotIfChanged("job-1")).toBe(true);
    expect(listSnapshots("job-1")).toHaveLength(2);
  });

  it("caps snapshots at MAX_SNAPSHOTS, pruning oldest first", () => {
    ensureBrainDir("job-1");
    for (let i = 0; i < __test__.MAX_SNAPSHOTS + 5; i += 1) {
      writeFileSync(canvasPathFor("job-1"), `version ${i}`, "utf-8");
      snapshotIfChanged("job-1");
    }
    const snapshots = listSnapshots("job-1");
    expect(snapshots).toHaveLength(__test__.MAX_SNAPSHOTS);
    // The oldest five (version 0-4) should have been pruned away — the
    // newest snapshot (the final write) must have survived.
    const latest = readSnapshot("job-1", snapshots[snapshots.length - 1]);
    expect(latest.content).toBe(`version ${__test__.MAX_SNAPSHOTS + 4}`);
  });
});

describe("readBrain", () => {
  it("returns null when there's no brain dir for this job", () => {
    expect(readBrain("job-1")).toBeNull();
  });

  it("returns content, updatedAt, and snapshotCount", () => {
    ensureBrainDir("job-1");
    writeFileSync(canvasPathFor("job-1"), "# notes", "utf-8");
    const brain = readBrain("job-1");
    expect(brain.content).toBe("# notes");
    expect(brain.snapshotCount).toBe(1);
    expect(typeof brain.updatedAt).toBe("string");
  });

  it("snapshots as a side effect of reading, so polling is what drives history", () => {
    ensureBrainDir("job-1");
    writeFileSync(canvasPathFor("job-1"), "# v1", "utf-8");
    readBrain("job-1");
    expect(listSnapshots("job-1")).toHaveLength(1);
  });
});

describe("listSnapshots / readSnapshot", () => {
  it("lists timestamps in chronological order", () => {
    ensureBrainDir("job-1");
    writeFileSync(canvasPathFor("job-1"), "v1", "utf-8");
    snapshotIfChanged("job-1");
    writeFileSync(canvasPathFor("job-1"), "v2", "utf-8");
    snapshotIfChanged("job-1");
    const snapshots = listSnapshots("job-1");
    expect(snapshots).toHaveLength(2);
    expect(snapshots[0] < snapshots[1]).toBe(true);
  });

  it("returns null for an unknown snapshot", () => {
    ensureBrainDir("job-1");
    expect(readSnapshot("job-1", "not-a-real-timestamp")).toBeNull();
  });

  it("round-trips a snapshot's content", () => {
    ensureBrainDir("job-1");
    writeFileSync(canvasPathFor("job-1"), "v1", "utf-8");
    snapshotIfChanged("job-1");
    const [ts] = listSnapshots("job-1");
    expect(readSnapshot("job-1", ts).content).toBe("v1");
  });
});

describe("brainDirFor / canvasPathFor", () => {
  it("scopes every path under the job id", () => {
    expect(brainDirFor("job-1")).toContain("job-1");
    expect(canvasPathFor("job-1")).toContain("job-1");
    expect(canvasPathFor("job-1")).toContain("canvas.md");
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
