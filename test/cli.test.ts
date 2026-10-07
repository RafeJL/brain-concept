import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SqliteStore } from "../src/store/sqlite.js";
import { repoFromFixture, tempDir } from "./helpers.js";

const BRAIN = fileURLToPath(new URL("../bin/brain.mjs", import.meta.url));

/** Runs the real CLI against its own store, as a person would. */
function brain(dbPath: string, ...args: string[]): string {
  return execFileSync(process.execPath, [BRAIN, ...args], { encoding: "utf8", env: { ...process.env, BRAIN_DB: dbPath } });
}

describe("brain add", () => {
  it("enrols, indexes and installs the hook in one step, then says what to do next", () => {
    const dbPath = join(tempDir(), "brain.db");
    const dir = repoFromFixture("articles-api");

    // --no-ai: the test checks the steps around the AI, without starting Claude Code.
    const out = brain(dbPath, "add", dir, "--name", "api", "--no-ai");

    expect(out).toContain("Added api, tracking main");
    expect(out).toMatch(/api: [0-9a-f]{7} \(\+\d+ ~0 -0, 0 unchanged\)/);
    expect(out).toContain("api: will re-sync in the background whenever main moves");
    expect(out).toContain("Next: brain sync api to have Claude Code write its wiki");
    expect(readFileSync(join(dir, ".git", "hooks", "reference-transaction"), "utf8")).toContain("sync 'api'");
    const store = new SqliteStore(dbPath);
    expect(store.getState("api")?.fileCount).toBeGreaterThan(0);
    store.close();
  }, 30_000);

  it("leaves hooks alone with --no-hook", () => {
    const dir = repoFromFixture("articles-api");

    brain(join(tempDir(), "brain.db"), "add", dir, "--no-ai", "--no-hook");

    expect(existsSync(join(dir, ".git", "hooks", "reference-transaction"))).toBe(false);
  }, 30_000);
});
