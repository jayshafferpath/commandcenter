import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", () => ({
  mkdirSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
}));

import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { announcePr, loadPostedUrls } from "../api/lib/slack-pr-announce.js";

const WEBHOOK_URL = "https://hooks.slack.com/triggers/T000/000/fake";

function makePr(overrides = {}) {
  return {
    title: "Add thing",
    url: "https://github.com/jayshafferpath/commandcenter/pull/1",
    repo: "jayshafferpath/commandcenter",
    number: 1,
    ...overrides,
  };
}

function enoent() {
  const err = new Error("ENOENT");
  err.code = "ENOENT";
  return err;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("fetch", vi.fn());
  process.env.SLACK_WORKFLOW_URL_PR_ANNOUNCE = WEBHOOK_URL;
});

describe("loadPostedUrls", () => {
  it("treats a missing state file as nothing posted", () => {
    readFileSync.mockImplementation(() => {
      throw enoent();
    });
    expect(loadPostedUrls()).toEqual(new Set());
  });

  it("throws on a corrupt state file rather than reading it as empty", () => {
    readFileSync.mockReturnValue("{not json");
    expect(() => loadPostedUrls()).toThrow();
  });

  it("throws on a read error other than a missing file", () => {
    readFileSync.mockImplementation(() => {
      const err = new Error("EACCES");
      err.code = "EACCES";
      throw err;
    });
    expect(() => loadPostedUrls()).toThrow("EACCES");
  });
});

describe("announcePr", () => {
  it("throws when the webhook env var is unset", async () => {
    delete process.env.SLACK_WORKFLOW_URL_PR_ANNOUNCE;
    await expect(announcePr(makePr())).rejects.toThrow("SLACK_WORKFLOW_URL_PR_ANNOUNCE");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("posts the flat payload and records the PR", async () => {
    readFileSync.mockImplementation(() => {
      throw enoent();
    });
    fetch.mockResolvedValue({ ok: true });
    const pr = makePr();

    expect(await announcePr(pr)).toBe("posted");

    const [url, options] = fetch.mock.calls[0];
    expect(url).toBe(WEBHOOK_URL);
    expect(JSON.parse(options.body)).toEqual({
      text: `:pr-review-request: Add thing\n${pr.url}`,
      title: "Add thing",
      url: pr.url,
      repo: "jayshafferpath/commandcenter",
      number: "1",
    });
    expect(mkdirSync).toHaveBeenCalledWith(expect.stringContaining(".commandcenter"), {
      recursive: true,
    });
    expect(JSON.parse(writeFileSync.mock.calls[0][1])).toEqual([pr.url]);
    expect(renameSync).toHaveBeenCalledTimes(1);
  });

  it("keeps previously posted URLs when recording a new one", async () => {
    const earlier = "https://github.com/x/y/pull/9";
    readFileSync.mockReturnValue(JSON.stringify([earlier]));
    fetch.mockResolvedValue({ ok: true });
    const pr = makePr();

    await announcePr(pr);

    expect(JSON.parse(writeFileSync.mock.calls[0][1])).toEqual([earlier, pr.url]);
  });

  it("does not repost a PR already recorded", async () => {
    const pr = makePr();
    readFileSync.mockReturnValue(JSON.stringify([pr.url]));

    expect(await announcePr(pr)).toBe("already_posted");
    expect(fetch).not.toHaveBeenCalled();
    expect(writeFileSync).not.toHaveBeenCalled();
  });

  it("does not record a PR whose POST failed, so asking again retries", async () => {
    readFileSync.mockReturnValue(JSON.stringify([]));
    fetch.mockResolvedValue({ ok: false, status: 500, text: async () => "boom" });

    await expect(announcePr(makePr())).rejects.toThrow("500");
    expect(writeFileSync).not.toHaveBeenCalled();
  });

  it("refuses to post when the state file is corrupt", async () => {
    readFileSync.mockReturnValue("{not json");

    await expect(announcePr(makePr())).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("posts once when the same PR is requested twice concurrently", async () => {
    readFileSync.mockReturnValue(JSON.stringify([]));
    let resolveFetch;
    fetch.mockReturnValue(
      new Promise((resolve) => {
        resolveFetch = resolve;
      }),
    );
    const pr = makePr();

    const first = announcePr(pr);
    const second = announcePr(pr);
    resolveFetch({ ok: true });

    expect(await first).toBe("posted");
    expect(await second).toBe("already_posted");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
