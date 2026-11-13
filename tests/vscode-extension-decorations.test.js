import { describe, expect, it } from "vitest";
import {
  caretNameplate,
  findVisibleEditorIndex,
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

describe("findVisibleEditorIndex", () => {
  const editorFor = (uriString) => ({ document: { uri: { toString: () => uriString } } });

  it("finds a plain editor showing the target uri", () => {
    const editors = [editorFor("file:///a.ts"), editorFor("file:///b.ts")];
    expect(findVisibleEditorIndex(editors, "file:///b.ts")).toBe(1);
  });

  it("finds the modified side of a diff editor showing the target uri", () => {
    const editors = [editorFor("file:///base-snapshot.ts"), editorFor("file:///repo/b.ts")];
    expect(findVisibleEditorIndex(editors, "file:///repo/b.ts")).toBe(1);
  });

  it("returns -1 when the target uri isn't visible anywhere", () => {
    const editors = [editorFor("file:///a.ts")];
    expect(findVisibleEditorIndex(editors, "file:///c.ts")).toBe(-1);
  });

  it("returns -1 for an empty editor list", () => {
    expect(findVisibleEditorIndex([], "file:///a.ts")).toBe(-1);
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
