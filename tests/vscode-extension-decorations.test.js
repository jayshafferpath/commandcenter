import { describe, expect, it } from "vitest";
import {
  caretNameplate,
  normalizeRange,
  shouldShowPresence,
  toZeroBasedRange,
} from "../vscode-extension/src/decorations.js";

describe("normalizeRange", () => {
  it("defaults startCol/endCol to 1 and endLine to startLine", () => {
    expect(normalizeRange({ startLine: 10 })).toEqual({
      startLine: 10,
      startCol: 1,
      endLine: 10,
      endCol: 1,
    });
  });

  it("passes explicit values through unchanged", () => {
    expect(normalizeRange({ startLine: 318, startCol: 3, endLine: 360, endCol: 9 })).toEqual({
      startLine: 318,
      startCol: 3,
      endLine: 360,
      endCol: 9,
    });
  });
});

describe("toZeroBasedRange", () => {
  it("converts 1-based wire positions to 0-based vscode positions", () => {
    expect(toZeroBasedRange({ startLine: 1, startCol: 1, endLine: 1, endCol: 1 })).toEqual({
      start: { line: 0, character: 0 },
      end: { line: 0, character: 0 },
    });
  });

  it("never goes negative even for out-of-range input", () => {
    expect(toZeroBasedRange({ startLine: 0, startCol: 0 })).toEqual({
      start: { line: 0, character: 0 },
      end: { line: 0, character: 0 },
    });
  });
});

describe("shouldShowPresence", () => {
  it("is true for a move command", () => {
    expect(shouldShowPresence({ type: "move" })).toBe(true);
  });

  it("is false for a clear command or no command", () => {
    expect(shouldShowPresence({ type: "clear" })).toBe(false);
    expect(shouldShowPresence(null)).toBe(false);
    expect(shouldShowPresence(undefined)).toBe(false);
  });
});

describe("caretNameplate", () => {
  it("uses the command's label when present", () => {
    expect(caretNameplate({ label: "Pearl" }, "Command Center")).toBe("Pearl");
  });

  it("falls back when the command has no label", () => {
    expect(caretNameplate({}, "Command Center")).toBe("Command Center");
    expect(caretNameplate(null, "Command Center")).toBe("Command Center");
  });
});
