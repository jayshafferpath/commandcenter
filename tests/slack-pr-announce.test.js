import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", () => ({
  mkdirSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
}));

vi.mock("../api/lib/pr.js", () => ({
  searchMyPrs: vi.fn(),
}));

import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { searchMyPrs } from "../api/lib/pr.js";
import {
  pollPrAnnouncements,
  selectPrsToAnnounce,
} from "../api/lib/slack-pr-announce.js";

const WEBHOOK_URL = "https://hooks.slack.com/triggers/T000/000/fake";

function makePr(overrides = {}) {
  return {
    repository: { nameWithOwner: "jayshafferpath/commandcenter" },
    number: 1,
    title: "Add thing",
    state: "OPEN",
    url: "https://github.com/jayshafferpath/commandcenter/pull/1",
    isDraft: false,
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("selectPrsToAnnounce", () => {
  it("skips drafts", () => {
    const draft = makePr({ isDraft: true });
    expect(selectPrsToAnnounce([draft], new Set())).toEqual([]);
  });

  it("skips PRs already in the posted set", () => {
    const pr = makePr();
    expect(selectPrsToAnnounce([pr], new Set([pr.url]))).toEqual([]);
  });

  it("includes a ready, unposted PR", () => {
    const pr = makePr();
    expect(selectPrsToAnnounce([pr], new Set())).toEqual([pr]);
  });

  it("posts a PR that was a draft last poll and is now ready, once it's no longer in the posted set", () => {
    const pr = makePr({ isDraft: false });
    expect(selectPrsToAnnounce([pr], new Set())).toEqual([pr]);
  });
});

describe("pollPrAnnouncements", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubGlobal("fetch", vi.fn());
    delete process.env.SLACK_WORKFLOW_URL_PR_ANNOUNCE;
  });

  it("does nothing when the webhook env var is unset", async () => {
    await pollPrAnnouncements();
    expect(searchMyPrs).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  describe("with the webhook configured", () => {
    beforeEach(() => {
      process.env.SLACK_WORKFLOW_URL_PR_ANNOUNCE = WEBHOOK_URL;
    });

    it("seeds the state file on first run and posts nothing", async () => {
      readFileSync.mockImplementation(() => {
        throw new Error("ENOENT");
      });
      const draft = makePr({
        url: "https://github.com/x/y/pull/2",
        isDraft: true,
      });
      const ready = makePr();
      searchMyPrs.mockReturnValue([ready, draft]);

      await pollPrAnnouncements();

      expect(fetch).not.toHaveBeenCalled();
      expect(writeFileSync).toHaveBeenCalledTimes(1);
      const written = JSON.parse(writeFileSync.mock.calls[0][1]);
      expect(written).toEqual(
        expect.arrayContaining([ready.url, draft.url]),
      );
      expect(renameSync).toHaveBeenCalledTimes(1);
    });

    it("posts a new ready PR and records it after a successful POST", async () => {
      readFileSync.mockReturnValue(JSON.stringify([]));
      const pr = makePr();
      searchMyPrs.mockReturnValue([pr]);
      fetch.mockResolvedValue({ ok: true });

      await pollPrAnnouncements();

      expect(fetch).toHaveBeenCalledTimes(1);
      const [url, options] = fetch.mock.calls[0];
      expect(url).toBe(WEBHOOK_URL);
      expect(JSON.parse(options.body)).toEqual({
        title: pr.title,
        url: pr.url,
        repo: "jayshafferpath/commandcenter",
        number: "1",
      });

      expect(writeFileSync).toHaveBeenCalledTimes(1);
      const written = JSON.parse(writeFileSync.mock.calls[0][1]);
      expect(written).toEqual([pr.url]);
    });

    it("does not repost a PR already in the posted set", async () => {
      const pr = makePr();
      readFileSync.mockReturnValue(JSON.stringify([pr.url]));
      searchMyPrs.mockReturnValue([pr]);

      await pollPrAnnouncements();

      expect(fetch).not.toHaveBeenCalled();
      expect(writeFileSync).not.toHaveBeenCalled();
    });

    it("skips a draft without posting or recording it", async () => {
      const draft = makePr({ isDraft: true });
      readFileSync.mockReturnValue(JSON.stringify([]));
      searchMyPrs.mockReturnValue([draft]);

      await pollPrAnnouncements();

      expect(fetch).not.toHaveBeenCalled();
      expect(writeFileSync).not.toHaveBeenCalled();
    });

    it("does not record a PR whose POST failed, so it retries next poll", async () => {
      const pr = makePr();
      readFileSync.mockReturnValue(JSON.stringify([]));
      searchMyPrs.mockReturnValue([pr]);
      fetch.mockResolvedValue({ ok: false, status: 500, text: async () => "boom" });

      await pollPrAnnouncements();

      expect(fetch).toHaveBeenCalledTimes(1);
      expect(writeFileSync).not.toHaveBeenCalled();
    });

    it("records each successful PR immediately, one at a time, so a crash mid-batch can't repost earlier ones", async () => {
      const prA = makePr({ url: "https://github.com/x/y/pull/1", number: 1 });
      const prB = makePr({ url: "https://github.com/x/y/pull/2", number: 2 });
      readFileSync.mockReturnValue(JSON.stringify([]));
      searchMyPrs.mockReturnValue([prA, prB]);
      fetch.mockResolvedValue({ ok: true });

      await pollPrAnnouncements();

      expect(writeFileSync).toHaveBeenCalledTimes(2);
      expect(JSON.parse(writeFileSync.mock.calls[0][1])).toEqual([prA.url]);
      expect(JSON.parse(writeFileSync.mock.calls[1][1])).toEqual([
        prA.url,
        prB.url,
      ]);
    });

    it("still posts and records later PRs after one earlier PR fails", async () => {
      const prA = makePr({ url: "https://github.com/x/y/pull/1", number: 1 });
      const prB = makePr({ url: "https://github.com/x/y/pull/2", number: 2 });
      readFileSync.mockReturnValue(JSON.stringify([]));
      searchMyPrs.mockReturnValue([prA, prB]);
      fetch
        .mockResolvedValueOnce({ ok: false, status: 500, text: async () => "boom" })
        .mockResolvedValueOnce({ ok: true });

      await pollPrAnnouncements();

      expect(writeFileSync).toHaveBeenCalledTimes(1);
      expect(JSON.parse(writeFileSync.mock.calls[0][1])).toEqual([prB.url]);
    });

    it("logs each successful post and each failure via the supplied logger", async () => {
      const prA = makePr({ url: "https://github.com/x/y/pull/1", number: 1 });
      const prB = makePr({ url: "https://github.com/x/y/pull/2", number: 2 });
      readFileSync.mockReturnValue(JSON.stringify([]));
      searchMyPrs.mockReturnValue([prA, prB]);
      fetch
        .mockResolvedValueOnce({ ok: true })
        .mockResolvedValueOnce({ ok: false, status: 500, text: async () => "boom" });

      const log = { info: vi.fn(), error: vi.fn() };
      await pollPrAnnouncements({ log });

      expect(log.info).toHaveBeenCalledWith(expect.stringContaining(prA.url));
      expect(log.error).toHaveBeenCalledWith(expect.stringContaining(prB.url));
    });

    it("creates the state directory before writing", async () => {
      readFileSync.mockReturnValue(JSON.stringify([]));
      searchMyPrs.mockReturnValue([makePr()]);
      fetch.mockResolvedValue({ ok: true });

      await pollPrAnnouncements();

      expect(mkdirSync).toHaveBeenCalledWith(
        expect.stringContaining(".commandcenter"),
        { recursive: true },
      );
    });
  });
});
