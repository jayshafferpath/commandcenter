import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let fakeHome;

// voice.js resolves its root lazily via os.homedir(), same reason as
// brain.js's brainRoot() and review.js's reviewRoot().
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, homedir: () => fakeHome };
});

// Real system commands (say/osascript/afplay) must never fire during a
// test run — mocked the same way tests/speak.test.js and
// tests/pearl-speak.test.js mock them.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, execFileSync: vi.fn(() => "false\n"), spawn: vi.fn(() => ({ pid: 1, stdin: { write: vi.fn(), end: vi.fn() }, unref: vi.fn() })) };
});

const { hush, isValidVoiceId, speak, voiceInstructions } = await import("../api/voice.js");

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), "voice-test-home-"));
});

afterEach(() => {
  rmSync(fakeHome, { recursive: true, force: true });
});

describe("isValidVoiceId", () => {
  it("accepts a UUID", () => {
    expect(isValidVoiceId("6a8f07ea-31ae-4e95-b85d-1cb00f6a3fad")).toBe(true);
  });

  it("accepts a plain alphanumeric id", () => {
    expect(isValidVoiceId("job_123")).toBe(true);
  });

  it("rejects an id containing a double quote", () => {
    expect(isValidVoiceId('nope"; do bad things')).toBe(false);
  });

  it("rejects an id containing a path separator", () => {
    expect(isValidVoiceId("../../etc/passwd")).toBe(false);
  });

  it("rejects a non-string", () => {
    expect(isValidVoiceId(123)).toBe(false);
    expect(isValidVoiceId(null)).toBe(false);
  });

  it("rejects an empty string", () => {
    expect(isValidVoiceId("")).toBe(false);
  });
});

describe("speak and hush", () => {
  const realPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: realPlatform });
  });

  it("creates an independent state dir per id, on macOS", () => {
    Object.defineProperty(process, "platform", { value: "darwin" });

    const result = speak("job-a", "x".repeat(10)); // below the summarize threshold, no claude call
    expect(result.ok).toBe(true);
    expect(existsSync(join(fakeHome, ".commandcenter", "voice", "job-a"))).toBe(true);
    expect(existsSync(join(fakeHome, ".commandcenter", "voice", "job-b"))).toBe(false);
  });

  it("no-ops with a clear error off macOS", () => {
    Object.defineProperty(process, "platform", { value: "linux" });

    expect(speak("job-a", "hello")).toEqual({ ok: false, error: "Voice only works on macOS" });
    expect(hush("job-a")).toEqual({ ok: false, error: "Voice only works on macOS" });
  });
});

describe("voiceInstructions", () => {
  it("points at the id-scoped speak route and /cc-voice", () => {
    const text = voiceInstructions("job-123", "http://localhost:3789");
    expect(text).toContain("http://localhost:3789/api/voice/job-123/speak");
    expect(text).toContain("/cc-voice");
  });
});
