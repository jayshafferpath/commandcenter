import { describe, expect, it } from "vitest";
import { isPrUrl } from "../api/lib/pr.js";

describe("isPrUrl", () => {
  it("accepts a GitHub PR URL", () => {
    expect(isPrUrl("https://github.com/pathccm/partner-service/pull/123")).toBe(true);
  });

  it("rejects non-PR GitHub URLs", () => {
    expect(isPrUrl("https://github.com/pathccm/partner-service/issues/123")).toBe(false);
    expect(isPrUrl("https://github.com/pathccm/partner-service")).toBe(false);
  });

  it("rejects anything that could break out of the shell quoting", () => {
    expect(isPrUrl("https://github.com/a/b/pull/1'; rm -rf ~; '")).toBe(false);
    expect(isPrUrl("https://github.com/a/b/pull/1 --repo x")).toBe(false);
    expect(isPrUrl("https://github.com/a/b/pull/1\nwhoami")).toBe(false);
  });

  it("rejects non-strings", () => {
    expect(isPrUrl(undefined)).toBe(false);
    expect(isPrUrl({ url: "https://github.com/a/b/pull/1" })).toBe(false);
  });
});
