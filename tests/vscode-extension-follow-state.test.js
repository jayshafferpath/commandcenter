import { describe, expect, it } from "vitest";
import { nextBackoffMs, shouldReveal } from "../vscode-extension/src/followState.js";

describe("shouldReveal", () => {
  it("is true when follow is on and the command is a reveal-able move", () => {
    expect(shouldReveal(true, { type: "move", reveal: true })).toBe(true);
    expect(shouldReveal(true, { type: "move" })).toBe(true);
  });

  it("is false when follow is off, even for a move", () => {
    expect(shouldReveal(false, { type: "move", reveal: true })).toBe(false);
  });

  it("is false for a clear command regardless of follow state", () => {
    expect(shouldReveal(true, { type: "clear" })).toBe(false);
  });

  it("is false when the command explicitly opts out of revealing", () => {
    expect(shouldReveal(true, { type: "move", reveal: false })).toBe(false);
  });

  it("is false with no command", () => {
    expect(shouldReveal(true, null)).toBe(false);
  });
});

describe("nextBackoffMs", () => {
  it("doubles each attempt starting from the base delay", () => {
    expect(nextBackoffMs(1)).toBe(500);
    expect(nextBackoffMs(2)).toBe(1000);
    expect(nextBackoffMs(3)).toBe(2000);
  });

  it("caps at the max backoff", () => {
    expect(nextBackoffMs(10)).toBe(15_000);
  });

  it("treats a non-positive attempt as the first", () => {
    expect(nextBackoffMs(0)).toBe(500);
  });
});
