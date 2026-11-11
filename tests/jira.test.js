import { beforeEach, describe, expect, it, vi } from "vitest";
import { transitionForEvent, NoMatchingTransitionError } from "../api/lib/jira.js";

function jsonResponse(body) {
  return { ok: true, json: async () => body, text: async () => JSON.stringify(body) };
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
  process.env.JIRA_EMAIL = "jay@example.com";
  process.env.JIRA_API_TOKEN = "token";
  process.env.JIRA_DOMAIN = "example.atlassian.net";
});

describe("transitionForEvent", () => {
  it("applies the matching transition and returns it", async () => {
    fetch
      .mockResolvedValueOnce(
        jsonResponse({ transitions: [{ id: "31", name: "Done" }, { id: "21", name: "In Progress" }] }),
      )
      .mockResolvedValueOnce(jsonResponse({}));

    const match = await transitionForEvent("JT-26", "done");

    expect(match).toEqual({ id: "31", name: "Done" });
    expect(fetch).toHaveBeenCalledTimes(2);
    const [transitionUrl, transitionInit] = fetch.mock.calls[1];
    expect(transitionUrl).toContain("/issue/JT-26/transitions");
    expect(transitionInit.method).toBe("POST");
    expect(JSON.parse(transitionInit.body)).toEqual({ transition: { id: "31" } });
  });

  it("throws NoMatchingTransitionError naming the ticket and the available transitions, without transitioning", async () => {
    fetch.mockResolvedValue(
      jsonResponse({ transitions: [{ id: "21", name: "In Progress" }, { id: "41", name: "Blocked" }] }),
    );

    let thrown;
    try {
      await transitionForEvent("JT-26", "done");
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(NoMatchingTransitionError);
    expect(thrown.key).toBe("JT-26");
    expect(thrown.available).toEqual(["In Progress", "Blocked"]);
    expect(thrown.message).toContain("JT-26");
    expect(thrown.message).toContain("In Progress");
    expect(thrown.message).toContain("Blocked");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("names '(none)' when the workflow offers no transitions at all", async () => {
    fetch.mockResolvedValue(jsonResponse({ transitions: [] }));

    await expect(transitionForEvent("JT-26", "done")).rejects.toThrow("(none)");
  });
});
