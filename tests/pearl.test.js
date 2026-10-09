import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __test__, readSoul, writeSoul } from "../api/pearl.js";

const { SESSION, briefing } = __test__;

describe("SESSION", () => {
  it("is a fixed, singleton session name derived from PEARL_NAME", () => {
    expect(SESSION).toBe("ccenter-pearl");
  });
});

describe("briefing", () => {
  const text = briefing({
    apiBase: "http://localhost:3789",
    repoRoot: "/Users/jay/dev/commandcenter",
  });

  it("mentions her name and role", () => {
    expect(text).toContain("Pearl");
    expect(text).toContain("supervisor");
  });

  it("includes the API base so she knows where to curl", () => {
    expect(text).toContain("http://localhost:3789");
  });

  it("includes the repo root for direct api/lib/jira.js access", () => {
    expect(text).toContain("/Users/jay/dev/commandcenter");
    expect(text).toContain("api/lib/jira.js");
  });

  it("is a single line — never typed into a TUI, but still safe either way", () => {
    expect(text).not.toContain("\n");
  });

  it("folds in SOUL.md's content when present, ahead of the technical briefing", () => {
    const dir = mkdtempSync(join(tmpdir(), "pearl-soul-"));
    writeSoul(dir, "Be terse.");
    const withSoul = briefing({ apiBase: "http://localhost:3789", repoRoot: dir });
    expect(withSoul).toContain("Be terse.");
    expect(withSoul.indexOf("Be terse.")).toBeLessThan(withSoul.indexOf("REST API"));
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("readSoul/writeSoul", () => {
  let dir;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pearl-soul-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns an empty string when SOUL.md doesn't exist yet", () => {
    expect(readSoul(dir)).toBe("");
  });

  it("round-trips written content", () => {
    writeSoul(dir, "# Pearl\n\nBe direct.");
    expect(readSoul(dir)).toBe("# Pearl\n\nBe direct.");
  });
});

describe("PEARL_NAME", () => {
  const ORIGINAL = process.env.PEARL_NAME;

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.PEARL_NAME;
    else process.env.PEARL_NAME = ORIGINAL;
    vi.resetModules();
  });

  it("renames the supervisor and derives her tmux session from the custom name", async () => {
    process.env.PEARL_NAME = "Marlowe";
    vi.resetModules();
    const mod = await import("../api/pearl.js");

    expect(mod.PEARL_NAME).toBe("Marlowe");
    expect(mod.__test__.SESSION).toBe("ccenter-marlowe");
    expect(
      mod.__test__.briefing({
        apiBase: "http://localhost:3789",
        repoRoot: "/tmp",
      }),
    ).toContain("You are Marlowe");
  });
});
