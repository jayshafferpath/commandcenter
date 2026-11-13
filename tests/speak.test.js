import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanForSpeech,
  createVoice,
  isITermRunning,
  shQuote,
  summarizeForSpeech,
  truncateForSpeech,
} from "../api/lib/speak.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, execFileSync: vi.fn(), spawn: vi.fn() };
});

let dirA;
let dirB;

beforeEach(() => {
  dirA = mkdtempSync(join(tmpdir(), "speak-test-a-"));
  dirB = mkdtempSync(join(tmpdir(), "speak-test-b-"));
});

afterEach(() => {
  rmSync(dirA, { recursive: true, force: true });
  rmSync(dirB, { recursive: true, force: true });
  execFileSync.mockReset();
});

// These are pure/stateless and already covered in depth by
// tests/pearl-speak.test.js (which imports the very same functions,
// re-exported from pearl-speak.js) — just a smoke check that the move to
// api/lib/speak.js didn't change them.
describe("stateless exports", () => {
  it("cleanForSpeech strips markdown", () => {
    expect(cleanForSpeech("**bold**")).toBe("bold");
  });

  it("truncateForSpeech keeps the first sentence", () => {
    expect(truncateForSpeech("One. Two.")).toBe("One.");
  });

  it("summarizeForSpeech speaks short text as-is", () => {
    expect(summarizeForSpeech("Done.")).toBe("Done.");
  });

  it("shQuote wraps a value in single quotes", () => {
    expect(shQuote("210")).toBe("'210'");
  });

  it("isITermRunning is false when osascript fails", () => {
    execFileSync.mockImplementation(() => {
      throw new Error("not authorized");
    });
    expect(isITermRunning()).toBe(false);
  });
});

describe("createVoice", () => {
  it("builds a relay script that writes to its own stateDir's paths, not a hardcoded one", () => {
    const voice = createVoice({ stateDir: dirA, relaySessionName: "test-relay-a" });
    const script = voice.buildRelayScript(["-r", "210"], "123");
    expect(script).toContain(dirA);
    expect(script).not.toContain(dirB);
  });

  it("two instances use independent pid files — hushing one never touches the other's", () => {
    const voiceA = createVoice({ stateDir: dirA, relaySessionName: "test-relay-a" });
    const voiceB = createVoice({ stateDir: dirB, relaySessionName: "test-relay-b" });

    // Simulate both instances mid-speech, each with its own say.pid.
    writeFileSync(join(dirA, "say.pid"), "999999");
    writeFileSync(join(dirB, "say.pid"), "999998");

    // process.kill on a pid that doesn't exist throws — hush() swallows
    // that (same as "already finished speaking"), so this only verifies
    // which pid file gets removed, not that a real process was killed.
    voiceA.hush();

    expect(existsSync(join(dirA, "say.pid"))).toBe(false);
    expect(existsSync(join(dirB, "say.pid"))).toBe(true);
    expect(readFileSync(join(dirB, "say.pid"), "utf-8")).toBe("999998");

    voiceB.hush();
    expect(existsSync(join(dirB, "say.pid"))).toBe(false);
  });

  it("reapOrphanedRelayWindows only ever matches its own relay session name", () => {
    execFileSync.mockReturnValue("true\n"); // isITermRunning() -> true
    const voice = createVoice({ stateDir: dirA, relaySessionName: "test-relay-a" });

    voice.reapOrphanedRelayWindows();

    const osascriptCall = execFileSync.mock.calls.find((call) => call[0] === "/usr/bin/osascript" && call[1][1]?.includes("repeat with w in windows"));
    expect(osascriptCall[1][1]).toContain('"test-relay-a"');
    expect(osascriptCall[1][1]).not.toContain("pearl-voice-relay");
  });

  it("skips reaping entirely when iTerm2 isn't running", () => {
    execFileSync.mockReturnValue("false\n");
    const voice = createVoice({ stateDir: dirA, relaySessionName: "test-relay-a" });

    voice.reapOrphanedRelayWindows();

    const closeCalls = execFileSync.mock.calls.filter((call) => call[1]?.[1]?.includes("repeat with w in windows"));
    expect(closeCalls).toHaveLength(0);
  });
});
