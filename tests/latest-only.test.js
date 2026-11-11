import { describe, expect, it } from "vitest";
import { latestOnly } from "../ui/src/latestOnly.js";

function deferred() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}

describe("latestOnly", () => {
  it("applies the result of a single call", async () => {
    const applied = [];
    const run = latestOnly(async (x) => x, (r) => applied.push(r));
    await run("a");
    expect(applied).toEqual(["a"]);
  });

  it("drops an older response that lands after a newer one", async () => {
    const slow = deferred();
    const fast = deferred();
    const pending = [slow, fast];
    const applied = [];
    const run = latestOnly(() => pending.shift().promise, (r) => applied.push(r));

    const first = run(); // 10s loop request, slow
    const second = run(); // 3s loop request, newer
    fast.resolve("new");
    await second;
    slow.resolve("stale");
    await first;

    expect(applied).toEqual(["new"]);
  });

  it("lets sequential calls each apply", async () => {
    const applied = [];
    const run = latestOnly(async (x) => x, (r) => applied.push(r));
    await run(1);
    await run(2);
    expect(applied).toEqual([1, 2]);
  });
});
