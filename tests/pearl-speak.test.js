import { describe, expect, it } from "vitest";
import { cleanForSpeech, extractLastAssistantText } from "../api/pearl-speak.js";

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
