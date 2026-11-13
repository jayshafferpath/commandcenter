import { describe, expect, it } from "vitest";
import { ambiguityKey, nextConnectionStep } from "../vscode-extension/src/discovery.js";

const matchFor = (reviewId) => ({ ok: true, match: { reviewId }, ambiguous: [] });
const noMatch = { ok: true, match: null, ambiguous: [] };

describe("nextConnectionStep", () => {
  it("stays idle when nothing is connected and nothing matches", () => {
    expect(nextConnectionStep(null, noMatch)).toEqual({ disconnect: false, connectTo: null });
  });

  it("connects when idle and a single review matches", () => {
    expect(nextConnectionStep(null, matchFor("rev-1"))).toEqual({ disconnect: false, connectTo: "rev-1" });
  });

  it("stays put when the connected review still matches", () => {
    expect(nextConnectionStep("rev-1", matchFor("rev-1"))).toEqual({ disconnect: false, connectTo: null });
  });

  it("disconnects when the connected review stops matching", () => {
    expect(nextConnectionStep("rev-1", noMatch)).toEqual({ disconnect: true, connectTo: null });
  });

  it("disconnects then connects when a different review takes over", () => {
    expect(nextConnectionStep("rev-1", matchFor("rev-2"))).toEqual({ disconnect: true, connectTo: "rev-2" });
  });

  it("disconnects on an ambiguous result rather than guessing", () => {
    const ambiguous = { ok: true, match: null, ambiguous: ["rev-1", "rev-2"] };
    expect(nextConnectionStep("rev-1", ambiguous)).toEqual({ disconnect: true, connectTo: null });
  });

  it("treats a missing response as no match", () => {
    expect(nextConnectionStep(null, undefined)).toEqual({ disconnect: false, connectTo: null });
  });
});

describe("ambiguityKey", () => {
  it("is null when there's no ambiguity", () => {
    expect(ambiguityKey(noMatch)).toBeNull();
    expect(ambiguityKey(matchFor("rev-1"))).toBeNull();
  });

  it("is order-independent so a reshuffled list isn't logged twice", () => {
    const a = ambiguityKey({ ambiguous: ["rev-2", "rev-1"] });
    const b = ambiguityKey({ ambiguous: ["rev-1", "rev-2"] });
    expect(a).toBe("rev-1,rev-2");
    expect(b).toBe(a);
  });
});
