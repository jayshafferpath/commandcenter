import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let fakeHome;

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, homedir: () => fakeHome };
});

const {
  createMemory,
  deleteArgs,
  findMemoryBin,
  listArgs,
  MEMORY_FOLDER,
  MemoryError,
  MemoryExistsError,
  MemoryNotFoundError,
  memoryEnv,
  memoryRoot,
  readArgs,
  searchArgs,
  writeArgs,
} = await import("../api/lib/pearl-memory.js");

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), "pearl-memory-test-"));
});

afterEach(() => {
  rmSync(fakeHome, { recursive: true, force: true });
});

function installFakeBin(path) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "", "utf-8");
}

describe("memoryRoot", () => {
  it("lives under ~/.commandcenter alongside brain and slack state", () => {
    expect(memoryRoot()).toBe(join(fakeHome, ".commandcenter", "memory"));
  });
});

describe("findMemoryBin", () => {
  it("returns null when basic-memory isn't installed", () => {
    expect(findMemoryBin({})).toBeNull();
  });

  it("finds uv's default tool location", () => {
    const bin = join(fakeHome, ".local", "bin", "basic-memory");
    installFakeBin(bin);
    expect(findMemoryBin({})).toBe(bin);
  });

  it("prefers PEARL_MEMORY_BIN over the default location", () => {
    const bin = join(fakeHome, "custom", "basic-memory");
    installFakeBin(bin);
    installFakeBin(join(fakeHome, ".local", "bin", "basic-memory"));
    expect(findMemoryBin({ PEARL_MEMORY_BIN: bin })).toBe(bin);
  });

  it("returns null when PEARL_MEMORY_BIN points at nothing", () => {
    expect(findMemoryBin({ PEARL_MEMORY_BIN: join(fakeHome, "missing") })).toBeNull();
  });
});

describe("memoryEnv", () => {
  it("keeps config and notes under the memory root", () => {
    const env = memoryEnv({ root: "/mem", env: {} });
    expect(env.BASIC_MEMORY_CONFIG_DIR).toBe("/mem/config");
    expect(env.BASIC_MEMORY_HOME).toBe("/mem/notes");
  });

  it("pins local embeddings and blanks the OpenAI key so nothing leaves the machine", () => {
    const env = memoryEnv({ root: "/mem", env: { OPENAI_API_KEY: "sk-real" } });
    expect(env.BASIC_MEMORY_SEMANTIC_EMBEDDING_PROVIDER).toBe("fastembed");
    expect(env.BASIC_MEMORY_CLOUD_MODE).toBe("false");
    expect(env.OPENAI_API_KEY).toBe("");
  });

  it("doesn't inherit the API's own environment, like its Jira credentials", () => {
    const env = memoryEnv({ root: "/mem", env: { JIRA_API_TOKEN: "secret", HOME: "/Users/me" } });
    expect(env).not.toHaveProperty("JIRA_API_TOKEN");
    expect(env.HOME).toBe("/Users/me");
  });

  it("passes the CA bundle through only when it's set", () => {
    expect(memoryEnv({ root: "/mem", env: {} })).not.toHaveProperty("SSL_CERT_FILE");
    const env = memoryEnv({
      root: "/mem",
      env: { SSL_CERT_FILE: "/certs/ca.pem", REQUESTS_CA_BUNDLE: "/certs/ca.pem" },
    });
    expect(env.SSL_CERT_FILE).toBe("/certs/ca.pem");
    expect(env.REQUESTS_CA_BUNDLE).toBe("/certs/ca.pem");
  });
});

describe("CLI args", () => {
  it("searches in hybrid mode, locally, as JSON", () => {
    expect(searchArgs({ query: "why not headless?", limit: 5 })).toEqual([
      "tool", "search", "--mode", "hybrid", "--page-size", "5", "--local", "--json", "why not headless?",
    ]);
  });

  it("writes into the pearl folder, overwriting only when asked", () => {
    const args = writeArgs({ title: "Headless", content: "Use interactive.", overwrite: false });
    expect(args.slice(0, 8)).toEqual([
      "tool", "write", "--title", "Headless", "--directory", MEMORY_FOLDER, "--content", "Use interactive.",
    ]);
    expect(args).not.toContain("--overwrite");
    expect(writeArgs({ title: "Headless", content: "x", overwrite: true })).toContain("--overwrite");
  });

  it("reads by permalink", () => {
    expect(readArgs({ identifier: "main/pearl/headless" })).toEqual([
      "tool", "read", "--local", "--json", "main/pearl/headless",
    ]);
  });

  it("lists the pearl folder, paginated", () => {
    expect(listArgs({ page: 2, limit: 20 })).toEqual([
      "tool", "list", MEMORY_FOLDER, "--page", "2", "--page-size", "20", "--local", "--json",
    ]);
  });

  it("deletes by permalink", () => {
    expect(deleteArgs({ identifier: "main/pearl/headless" })).toEqual([
      "tool", "delete", "--identifier", "main/pearl/headless", "--local", "--json",
    ]);
  });
});

describe("createMemory", () => {
  const root = () => join(fakeHome, "mem");

  it("runs the CLI from the memory root with the pinned env, never a shell", async () => {
    const execFileAsync = vi.fn(async () => ({ stdout: JSON.stringify({ results: [] }) }));
    const memory = createMemory({ bin: "/bin/basic-memory", root: root(), env: {}, execFileAsync });

    await memory.search({ query: "q", limit: 5 });

    const [bin, args, options] = execFileAsync.mock.calls[0];
    expect(bin).toBe("/bin/basic-memory");
    expect(args).toEqual(searchArgs({ query: "q", limit: 5 }));
    expect(options.cwd).toBe(root());
    expect(options.env.BASIC_MEMORY_SEMANTIC_EMBEDDING_PROVIDER).toBe("fastembed");
    expect(options.timeout).toBe(120_000);
  });

  it("maps search hits to the fields Pearl needs", async () => {
    const execFileAsync = vi.fn(async () => ({
      stdout: JSON.stringify({
        results: [
          {
            title: "Headless dispatch",
            permalink: "main/pearl/headless-dispatch",
            content: "Use interactive.",
            score: 1.2,
            updated_at: "2026-11-10T23:24:43-07:00",
            entity_id: 1,
          },
        ],
      }),
    }));
    const memory = createMemory({ bin: "/bin/bm", root: root(), env: {}, execFileAsync });

    expect(await memory.search({ query: "q", limit: 5 })).toEqual([
      {
        title: "Headless dispatch",
        permalink: "main/pearl/headless-dispatch",
        content: "Use interactive.",
        score: 1.2,
        updatedAt: "2026-11-10T23:24:43-07:00",
      },
    ]);
  });

  it("returns a write's action and near-duplicates", async () => {
    const execFileAsync = vi.fn(async () => ({
      stdout: JSON.stringify({
        action: "created",
        title: "Headless",
        permalink: "main/pearl/headless",
        similar_notes: [{ title: "Old headless note" }],
      }),
    }));
    const memory = createMemory({ bin: "/bin/bm", root: root(), env: {}, execFileAsync });

    expect(await memory.write({ title: "Headless", content: "x" })).toEqual({
      action: "created",
      title: "Headless",
      permalink: "main/pearl/headless",
      similarNotes: [{ title: "Old headless note" }],
    });
  });

  it("runs writes one at a time", async () => {
    let running = 0;
    let maxRunning = 0;
    const execFileAsync = vi.fn(async () => {
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
      return { stdout: JSON.stringify({ action: "created" }) };
    });
    const memory = createMemory({ bin: "/bin/bm", root: root(), env: {}, execFileAsync });

    await Promise.all([
      memory.write({ title: "a", content: "x" }),
      memory.write({ title: "b", content: "x" }),
      memory.write({ title: "c", content: "x" }),
    ]);

    expect(maxRunning).toBe(1);
  });

  it("keeps writing after a failed write", async () => {
    const execFileAsync = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("exit 1"), { stderr: "Error: note exists\n" }))
      .mockResolvedValueOnce({ stdout: JSON.stringify({ action: "created" }) });
    const memory = createMemory({ bin: "/bin/bm", root: root(), env: {}, execFileAsync });

    await expect(memory.write({ title: "a", content: "x" })).rejects.toThrow("note exists");
    await expect(memory.write({ title: "b", content: "x" })).resolves.toMatchObject({ action: "created" });
  });

  it("turns the CLI's already-exists error into one that points at overwrite", async () => {
    const stderr =
      'Error: {"error": "ALREADY_EXISTS", "message": "A note already exists at \'pearl/Headless.md\'.", "try_instead": "bm_edit(...)"}\n';
    const memory = createMemory({
      bin: "/bin/bm",
      root: root(),
      env: {},
      execFileAsync: vi.fn().mockRejectedValue(Object.assign(new Error("exit 1"), { stderr })),
    });

    const err = await memory.write({ title: "Headless", content: "x" }).catch((e) => e);
    expect(err).toBeInstanceOf(MemoryExistsError);
    expect(err.message).toContain("overwrite: true");
    expect(err.message).not.toContain("bm_edit");
  });

  it("raises a MemoryError naming the subcommand on failure or bad output", async () => {
    const failing = createMemory({
      bin: "/bin/bm",
      root: root(),
      env: {},
      execFileAsync: vi.fn().mockRejectedValue(Object.assign(new Error("boom"), { stderr: "" })),
    });
    await expect(failing.search({ query: "q", limit: 5 })).rejects.toThrow(MemoryError);
    await expect(failing.search({ query: "q", limit: 5 })).rejects.toThrow("basic-memory search failed: boom");

    const garbled = createMemory({
      bin: "/bin/bm",
      root: root(),
      env: {},
      execFileAsync: vi.fn(async () => ({ stdout: "not json" })),
    });
    await expect(garbled.read({ identifier: "x" })).rejects.toThrow("basic-memory read returned non-JSON output");
  });

  it("lists notes, dropping folders and mapping pagination fields", async () => {
    const execFileAsync = vi.fn(async () => ({
      stdout: JSON.stringify({
        nodes: [
          { type: "directory", name: "drafts" },
          {
            type: "file",
            title: "Headless dispatch",
            permalink: "main/pearl/headless-dispatch",
            updated_at: "2026-11-10T23:24:43-07:00",
          },
        ],
        page: 1,
        page_size: 20,
        total: 1,
        has_more: false,
      }),
    }));
    const memory = createMemory({ bin: "/bin/bm", root: root(), env: {}, execFileAsync });

    expect(await memory.list({ page: 1, limit: 20 })).toEqual({
      notes: [
        {
          title: "Headless dispatch",
          permalink: "main/pearl/headless-dispatch",
          updatedAt: "2026-11-10T23:24:43-07:00",
        },
      ],
      page: 1,
      limit: 20,
      total: 1,
      hasMore: false,
    });
    expect(execFileAsync.mock.calls[0][1]).toEqual(listArgs({ page: 1, limit: 20 }));
  });

  it("updates by permalink: reads the title, then overwrites", async () => {
    const execFileAsync = vi
      .fn()
      .mockResolvedValueOnce({
        stdout: JSON.stringify({ title: "Headless", permalink: "main/pearl/headless", content: "old" }),
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({ action: "updated", title: "Headless", permalink: "main/pearl/headless" }),
      });
    const memory = createMemory({ bin: "/bin/bm", root: root(), env: {}, execFileAsync });

    const result = await memory.update({ identifier: "main/pearl/headless", content: "new" });

    expect(result).toEqual({ action: "updated", title: "Headless", permalink: "main/pearl/headless" });
    expect(execFileAsync.mock.calls[0][1]).toEqual(readArgs({ identifier: "main/pearl/headless" }));
    expect(execFileAsync.mock.calls[1][1]).toEqual(writeArgs({ title: "Headless", content: "new", overwrite: true }));
  });

  it("raises MemoryNotFoundError updating an unknown permalink", async () => {
    const stderr = 'Error: {"error": "NOT_FOUND", "message": "No note at \'pearl/Ghost.md\'."}\n';
    const memory = createMemory({
      bin: "/bin/bm",
      root: root(),
      env: {},
      execFileAsync: vi.fn().mockRejectedValue(Object.assign(new Error("exit 1"), { stderr })),
    });

    await expect(memory.update({ identifier: "ghost", content: "x" })).rejects.toBeInstanceOf(MemoryNotFoundError);
  });

  it("deletes by permalink", async () => {
    const execFileAsync = vi.fn(async () => ({
      stdout: JSON.stringify({ action: "deleted", title: "Headless", file_path: "pearl/Headless.md" }),
    }));
    const memory = createMemory({ bin: "/bin/bm", root: root(), env: {}, execFileAsync });

    expect(await memory.remove({ identifier: "main/pearl/headless" })).toEqual({
      action: "deleted",
      title: "Headless",
      filePath: "pearl/Headless.md",
    });
    expect(execFileAsync.mock.calls[0][1]).toEqual(deleteArgs({ identifier: "main/pearl/headless" }));
  });

  it("raises MemoryNotFoundError deleting an unknown permalink", async () => {
    const stderr = 'Error: {"error": "NOT_FOUND", "message": "No note at \'pearl/Ghost.md\'."}\n';
    const memory = createMemory({
      bin: "/bin/bm",
      root: root(),
      env: {},
      execFileAsync: vi.fn().mockRejectedValue(Object.assign(new Error("exit 1"), { stderr })),
    });

    await expect(memory.remove({ identifier: "ghost" })).rejects.toBeInstanceOf(MemoryNotFoundError);
  });

  it("runs deletes and updates through the same serialized queue as writes", async () => {
    let running = 0;
    let maxRunning = 0;
    const execFileAsync = vi.fn(async (bin, args) => {
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
      if (args[1] === "read") return { stdout: JSON.stringify({ title: "a", permalink: "p" }) };
      return { stdout: JSON.stringify({ action: "created" }) };
    });
    const memory = createMemory({ bin: "/bin/bm", root: root(), env: {}, execFileAsync });

    await Promise.all([
      memory.write({ title: "a", content: "x" }),
      memory.remove({ identifier: "b" }),
      memory.update({ identifier: "c", content: "x" }),
    ]);

    expect(maxRunning).toBe(1);
  });

  it("keeps the mutation queue running after a failed delete", async () => {
    const execFileAsync = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("exit 1"), { stderr: "Error: boom\n" }))
      .mockResolvedValueOnce({ stdout: JSON.stringify({ action: "created" }) });
    const memory = createMemory({ bin: "/bin/bm", root: root(), env: {}, execFileAsync });

    await expect(memory.remove({ identifier: "a" })).rejects.toThrow(MemoryError);
    await expect(memory.write({ title: "b", content: "x" })).resolves.toMatchObject({ action: "created" });
  });
});
