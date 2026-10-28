import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanForSpeech, extractLastAssistantText, summarizeForSpeech } from "../api/pearl-speak.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, execFileSync: vi.fn() };
});

function line(obj) {
  return JSON.stringify(obj);
}

describe("extractLastAssistantText", () => {
  it("returns the text blocks from the last assistant message", () => {
    const lines = [
      line({ type: "user", message: { content: [{ type: "text", text: "do the thing" }] } }),
      line({ type: "assistant", message: { content: [{ type: "text", text: "On it." }] } }),
      line({ type: "assistant", message: { content: [{ type: "text", text: "Done." }] } }),
    ];

    expect(extractLastAssistantText(lines)).toBe("Done.");
  });

  it("joins multiple text blocks within the same assistant message", () => {
    const lines = [
      line({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "Bash" },
            { type: "text", text: "First." },
            { type: "text", text: "Second." },
          ],
        },
      }),
    ];

    expect(extractLastAssistantText(lines)).toBe("First.\nSecond.");
  });

  it("returns an empty string when the last assistant message has no text", () => {
    const lines = [
      line({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash" }] } }),
    ];

    expect(extractLastAssistantText(lines)).toBe("");
  });

  it("skips blank lines and lines that aren't valid JSON", () => {
    const lines = [
      "",
      "not json",
      line({ type: "assistant", message: { content: [{ type: "text", text: "Hi." }] } }),
    ];

    expect(extractLastAssistantText(lines)).toBe("Hi.");
  });

  it("returns an empty string when there's no assistant message at all", () => {
    expect(extractLastAssistantText([line({ type: "user", message: {} })])).toBe("");
  });
});

describe("cleanForSpeech", () => {
  it("drops fenced code blocks entirely", () => {
    expect(cleanForSpeech("Here: ```js\nconst x = 1;\n``` done")).toBe("Here: done");
  });

  it("strips markdown emphasis markers", () => {
    expect(cleanForSpeech("**bold** and _italic_ and `code`")).toBe("bold and italic and code");
  });

  it("replaces markdown links with their label", () => {
    expect(cleanForSpeech("see [the PR](https://example.com/1)")).toBe("see the PR");
  });

  it("collapses runs of whitespace left behind by stripping", () => {
    expect(cleanForSpeech("a   b")).toBe("a b");
  });
});

describe("summarizeForSpeech", () => {
  afterEach(() => {
    execFileSync.mockReset();
  });

  it("speaks short text as-is, skipping the haiku round-trip", () => {
    const text = "Done.";
    expect(summarizeForSpeech(text)).toBe(text);
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it("condenses long text via claude -p --model haiku", () => {
    const longText = "x".repeat(200);
    execFileSync.mockReturnValue("The core idea.\n");

    expect(summarizeForSpeech(longText)).toBe("The core idea.");
    expect(execFileSync).toHaveBeenCalledWith(
      "claude",
      expect.arrayContaining(["-p", "--model", "haiku"]),
      expect.objectContaining({ encoding: "utf-8" }),
    );
  });

  it("falls back to the original text if the summarize call fails", () => {
    const longText = "x".repeat(200);
    execFileSync.mockImplementation(() => {
      throw new Error("timed out");
    });

    expect(summarizeForSpeech(longText)).toBe(longText);
  });

  it("falls back to the original text if the summary comes back empty", () => {
    const longText = "x".repeat(200);
    execFileSync.mockReturnValue("   ");

    expect(summarizeForSpeech(longText)).toBe(longText);
  });
});
