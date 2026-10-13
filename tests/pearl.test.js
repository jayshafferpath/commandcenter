import { mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __test__, readSoul, refreshPearl, writeSoul } from "../api/pearl.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, execFileSync: vi.fn() };
});
vi.mock("../api/run-command.js", () => ({ openSessionInIterm: vi.fn(() => ({ ok: true })) }));

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

describe("refreshPearl", () => {
  let sessionAlive;

  beforeEach(() => {
    sessionAlive = true;
    execFileSync.mockReset();
    execFileSync.mockImplementation((cmd, args) => {
      if (cmd !== "tmux") return "";
      const [sub] = args;
      if (sub === "has-session") {
        if (!sessionAlive) throw new Error("can't find session");
        return "";
      }
      if (sub === "kill-session") {
        sessionAlive = false;
        return "";
      }
      if (sub === "new-session") {
        sessionAlive = true;
        return "";
      }
      return "";
    });
  });

  it("kills the existing session before spawning a fresh one", () => {
    const result = refreshPearl({
      cwd: "/tmp",
      apiBase: "http://localhost:3789",
      repoRoot: "/tmp",
    });

    const subcommands = execFileSync.mock.calls
      .filter(([cmd]) => cmd === "tmux")
      .map(([, args]) => args[0]);

    expect(subcommands.indexOf("kill-session")).toBeGreaterThanOrEqual(0);
    expect(subcommands.indexOf("kill-session")).toBeLessThan(subcommands.lastIndexOf("new-session"));
    expect(result.ok).toBe(true);
    expect(result.spawned).toBe(true);
  });

  it("behaves like a plain open when no session exists yet", () => {
    sessionAlive = false;

    const result = refreshPearl({
      cwd: "/tmp",
      apiBase: "http://localhost:3789",
      repoRoot: "/tmp",
    });

    const subcommands = execFileSync.mock.calls
      .filter(([cmd]) => cmd === "tmux")
      .map(([, args]) => args[0]);

    expect(subcommands).not.toContain("kill-session");
    expect(subcommands).toContain("new-session");
    expect(result.ok).toBe(true);
    expect(result.spawned).toBe(true);
  });

  it("surfaces a tmux kill failure instead of spawning over a session still running", () => {
    execFileSync.mockImplementation((cmd, args) => {
      const [sub] = args;
      if (sub === "has-session") return ""; // always reports alive
      if (sub === "kill-session") throw new Error("tmux: permission denied");
      return "";
    });

    const result = refreshPearl({
      cwd: "/tmp",
      apiBase: "http://localhost:3789",
      repoRoot: "/tmp",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("permission denied");

    const subcommands = execFileSync.mock.calls
      .filter(([cmd]) => cmd === "tmux")
      .map(([, args]) => args[0]);
    expect(subcommands).not.toContain("new-session");
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
