import { beforeEach, describe, expect, it, vi } from "vitest";

vi.stubGlobal("fetch", vi.fn());

import { NoTransitionError, transitionForEvent } from "../api/lib/jira.js";

function jsonResponse(body) {
  return { ok: true, json: async () => body };
}

beforeEach(() => {
  vi.resetAllMocks();
  process.env.JIRA_EMAIL = "test@example.com";
  process.env.JIRA_API_TOKEN = "token";
  process.env.JIRA_DOMAIN = "example.atlassian.net";
});

describe("transitionForEvent", () => {
  it("applies the matching transition and returns it", async () => {
    fetch
      .mockResolvedValueOnce(
        jsonResponse({
          transitions: [
            { id: "11", name: "To Do" },
            { id: "31", name: "Done" },
          ],
        }),
      )
      .mockResolvedValueOnce({ ok: true, text: async () => "" });

    const match = await transitionForEvent("JT-26", "done");

    expect(match).toEqual({ id: "31", name: "Done" });
    expect(fetch).toHaveBeenCalledTimes(2);
    const [, postCall] = fetch.mock.calls;
    expect(postCall[1].body).toBe(JSON.stringify({ transition: { id: "31" } }));
  });

  it("throws NoTransitionError naming the ticket and available transitions when nothing matches", async () => {
    fetch.mockResolvedValueOnce(
      jsonResponse({
        transitions: [
          { id: "11", name: "To Do" },
          { id: "21", name: "In Progress" },
        ],
      }),
    );

    await expect(transitionForEvent("JT-26", "done")).rejects.toThrow(NoTransitionError);

    fetch.mockResolvedValueOnce(
      jsonResponse({
        transitions: [
          { id: "11", name: "To Do" },
          { id: "21", name: "In Progress" },
        ],
      }),
    );
    try {
      await transitionForEvent("JT-26", "done");
      throw new Error("expected transitionForEvent to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(NoTransitionError);
      expect(err.key).toBe("JT-26");
      expect(err.available).toEqual(["To Do", "In Progress"]);
    }

    // No transition should have been applied.
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
