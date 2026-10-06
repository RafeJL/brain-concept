import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runQueued } from "../src/core/queue.js";
import { tempDir } from "./helpers.js";

describe("runQueued", () => {
  it("folds a trigger that arrives mid-run into one more run, then releases the lock", async () => {
    const dir = tempDir();
    const outcomes: string[] = [];
    let runs = 0;

    const first = await runQueued(dir, "api", async () => {
      runs++;
      // Two more triggers (two hook firings) while the first run is going: one extra pass covers both.
      if (runs === 1) outcomes.push(await runQueued(dir, "api", async () => void runs++), await runQueued(dir, "api", async () => void runs++));
    });

    expect(first).toBe("ran");
    expect(outcomes).toEqual(["queued", "queued"]);
    expect(runs).toBe(2);
    expect(existsSync(join(dir, "api.lock"))).toBe(false);
    expect(existsSync(join(dir, "api.pending"))).toBe(false);
  });

  it("takes over a lock left by a process that has died", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "api.lock"), "999999999");
    let ran = false;

    expect(await runQueued(dir, "api", async () => void (ran = true))).toBe("ran");
    expect(ran).toBe(true);
  });

  it("keeps repos independent", async () => {
    const dir = tempDir();
    const inner: string[] = [];

    await runQueued(dir, "api", async () => {
      inner.push(await runQueued(dir, "web", async () => {}));
    });

    expect(inner).toEqual(["ran"]);
  });
});
