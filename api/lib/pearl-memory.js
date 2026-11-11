// Pearl's persistent memory: Basic Memory (Markdown notes + SQLite +
// sqlite-vec, local FastEmbed embeddings), driven through its CLI and exposed
// as dashboard API routes. Chosen over Cognee after measuring both: ~0.5 GB
// vs ~3.3 GB on disk, ~3s vs ~23s per save, equal recall on paraphrased
// queries, and every memory is a Markdown file a human can open and audit.
//
// Not an MCP server: the org's managed MCP policy blocks servers that aren't
// on its allowlist, and API routes match how Pearl already uses the
// dashboard.
//
// Everything stays on this machine. The child gets a fixed environment
// rather than the API's own, because the installed package ships an OpenAI
// client and its docs recommend OpenAI embeddings, and because the API's
// environment carries Jira credentials the child has no use for.

import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

export const MEMORY_FOLDER = "pearl";

// The first call downloads the embedding model (~64 MB), so this has to
// cover that, not just a warm call (~3s).
const TOOL_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

// Passed through only when set: without them, the one-time model download
// fails behind a TLS-inspecting corporate proxy.
const CA_ENV_KEYS = ["SSL_CERT_FILE", "REQUESTS_CA_BUNDLE"];

const defaultExecFile = promisify(execFile);

export class MemoryError extends Error {}

// Its own type so the route can answer 409 with a fix Pearl can act on;
// the CLI's own message points at MCP tools she doesn't have.
export class MemoryExistsError extends MemoryError {}

// A function, not a constant, so tests can mock os.homedir() — same reason
// as brain.js's brainRoot().
export function memoryRoot() {
  return join(homedir(), ".commandcenter", "memory");
}

// `uv tool install` puts its executables in ~/.local/bin by default.
// PEARL_MEMORY_BIN overrides that for a non-default uv tool dir. Returns null
// when it isn't installed, which leaves memory off instead of failing.
export function findMemoryBin(env = process.env) {
  const candidate = env.PEARL_MEMORY_BIN?.trim() || join(homedir(), ".local", "bin", "basic-memory");
  return existsSync(candidate) ? candidate : null;
}

export function memoryEnv({ root = memoryRoot(), env = process.env } = {}) {
  const caEnv = Object.fromEntries(CA_ENV_KEYS.filter((key) => env[key]).map((key) => [key, env[key]]));
  return {
    HOME: env.HOME ?? homedir(),
    PATH: "/usr/bin:/bin",
    BASIC_MEMORY_CONFIG_DIR: join(root, "config"),
    BASIC_MEMORY_HOME: join(root, "notes"),
    BASIC_MEMORY_SEMANTIC_EMBEDDING_PROVIDER: "fastembed",
    BASIC_MEMORY_CLOUD_MODE: "false",
    // Blanked rather than omitted, so nothing upstream can supply one.
    OPENAI_API_KEY: "",
    ...caEnv,
  };
}

// --local forces local routing even if a cloud project were ever configured.
const TOOL_FLAGS = ["--local", "--json"];

export function searchArgs({ query, limit }) {
  return ["tool", "search", "--mode", "hybrid", "--page-size", String(limit), ...TOOL_FLAGS, query];
}

export function writeArgs({ title, content, overwrite }) {
  return [
    "tool",
    "write",
    "--title",
    title,
    "--directory",
    MEMORY_FOLDER,
    "--content",
    content,
    ...(overwrite ? ["--overwrite"] : []),
    ...TOOL_FLAGS,
  ];
}

export function readArgs({ identifier }) {
  return ["tool", "read", ...TOOL_FLAGS, identifier];
}

// Writes go one at a time: each CLI call is its own process against the same
// SQLite index, and two concurrent saves would otherwise race on it.
export function createMemory({ bin, root = memoryRoot(), env = process.env, execFileAsync = defaultExecFile }) {
  let writeChain = Promise.resolve();

  async function run(args) {
    mkdirSync(root, { recursive: true });
    let stdout;
    try {
      ({ stdout } = await execFileAsync(bin, args, {
        // Run from the memory root: the CLI reads a .env from its working
        // directory, and the dashboard's own .env holds Jira credentials.
        cwd: root,
        env: memoryEnv({ root, env }),
        timeout: TOOL_TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES,
      }));
    } catch (err) {
      const detail = err.stderr?.trim().split("\n").pop() || err.message;
      if (detail.includes('"ALREADY_EXISTS"')) {
        throw new MemoryExistsError("A note with this title already exists. Save again with overwrite: true to replace it.");
      }
      throw new MemoryError(`basic-memory ${args[1]} failed: ${detail}`);
    }
    try {
      return JSON.parse(stdout);
    } catch {
      throw new MemoryError(`basic-memory ${args[1]} returned non-JSON output`);
    }
  }

  return {
    async search({ query, limit }) {
      const result = await run(searchArgs({ query, limit }));
      return (result.results ?? []).map((hit) => ({
        title: hit.title,
        permalink: hit.permalink,
        content: hit.content,
        score: hit.score,
        updatedAt: hit.updated_at,
      }));
    },

    async read({ identifier }) {
      const note = await run(readArgs({ identifier }));
      return { title: note.title, permalink: note.permalink, content: note.content };
    },

    write({ title, content, overwrite = false }) {
      const result = writeChain.then(async () => {
        const saved = await run(writeArgs({ title, content, overwrite }));
        return {
          action: saved.action,
          title: saved.title,
          permalink: saved.permalink,
          similarNotes: saved.similar_notes ?? [],
        };
      });
      // A failed write mustn't wedge the queue for every write after it.
      // reliability-allow err-no-swallow: the caller still receives `result`'s rejection; only the queue's copy is detached.
      writeChain = result.catch(() => {});
      return result;
    },
  };
}
