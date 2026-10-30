import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanForSpeech,
  extractLastAssistantText,
  isAtChatPrompt,
  nextWatchState,
  summarizeForSpeech,
  truncateForSpeech,
} from "../api/pearl-speak.js";

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

  it("falls back to the opening sentence if the summarize call fails", () => {
    const longText = `First sentence here. ${"x".repeat(200)}`;
    execFileSync.mockImplementation(() => {
      throw new Error("timed out");
    });

    expect(summarizeForSpeech(longText)).toBe("First sentence here.");
  });

  it("falls back to the opening sentence if the summary comes back empty", () => {
    const longText = `First sentence here. ${"x".repeat(200)}`;
    execFileSync.mockReturnValue("   ");

    expect(summarizeForSpeech(longText)).toBe("First sentence here.");
  });
});

describe("truncateForSpeech", () => {
  it("keeps only the first sentence", () => {
    expect(truncateForSpeech("One. Two! Three?")).toBe("One.");
  });

  it("doesn't split on periods inside a word", () => {
    expect(truncateForSpeech("See pearl-speak.js now. Then more.")).toBe("See pearl-speak.js now.");
  });

  it("caps a long first sentence with an ellipsis", () => {
    expect(truncateForSpeech("x".repeat(300))).toBe(`${"x".repeat(250)}…`);
  });
});

describe("isAtChatPrompt", () => {
  it("is true when the prompt line sits between two border lines", () => {
    const pane = ["some output", "─────────────", "❯ ", "─────────────"].join("\n");
    expect(isAtChatPrompt(pane)).toBe(true);
  });

  it("is false for a bare cursor with no framing borders, like a permission dialog", () => {
    const pane = ["Do you want to proceed?", "❯ 1. Yes", "  2. No"].join("\n");
    expect(isAtChatPrompt(pane)).toBe(false);
  });

  it("is false when there's no prompt line at all", () => {
    expect(isAtChatPrompt("just some scrollback\nmore output")).toBe(false);
  });

  it("is false when the prompt line is the very first line (no border above it)", () => {
    const pane = ["❯ ", "─────────────"].join("\n");
    expect(isAtChatPrompt(pane)).toBe(false);
  });
});

describe("nextWatchState", () => {
  it("records a change and resets the quiet timer when the pane differs", () => {
    const state = nextWatchState({ lastPane: "a", lastChangeAt: 100 }, "b", 500, 700);
    expect(state).toEqual({ lastPane: "b", lastChangeAt: 500, shouldSubmit: false });
  });

  it("doesn't submit while still within the quiet window", () => {
    const state = nextWatchState({ lastPane: "b", lastChangeAt: 500 }, "b", 900, 700);
    expect(state.shouldSubmit).toBe(false);
  });

  it("submits once the pane has been unchanged for the quiet window", () => {
    const state = nextWatchState({ lastPane: "b", lastChangeAt: 500 }, "b", 1300, 700);
    expect(state.shouldSubmit).toBe(true);
  });

  it("never submits if the pane has never changed from the baseline", () => {
    const state = nextWatchState({ lastPane: "a", lastChangeAt: null }, "a", 10_000, 700);
    expect(state.shouldSubmit).toBe(false);
  });
});
