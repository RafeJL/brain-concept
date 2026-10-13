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

describe("brain systems", () => {
  it("creates, lists and shows a system a person names", () => {
    const dbPath = join(tempDir(), "brain.db");
    brain(dbPath, "add", repoFromFixture("articles-api"), "--name", "api", "--no-ai", "--no-hook");

    const set = brain(dbPath, "systems", "set", "Conduit", "api", "--summary", "A blogging platform.");
    const list = brain(dbPath, "systems");
    const show = brain(dbPath, "systems", "show", "conduit");

    expect(set).toContain("Created Conduit (confirmed): api");
    expect(list).toContain("Conduit (confirmed) · 1 repo: api\n  A blogging platform.");
    expect(show).toContain("Conduit (confirmed) · 1 repo\n\nA blogging platform.");
  }, 30_000);
});

describe("brain facts and brain gaps", () => {
  it("records a fact as the person at the keyboard, lists it, retires it, and lists what searches missed", () => {
    const dbPath = join(tempDir(), "brain.db");
    brain(dbPath, "add", repoFromFixture("articles-api"), "--name", "api", "--no-ai", "--no-hook");

    const added = brain(dbPath, "facts", "add", "api", "--kind", "rule", "--text", "Only an article's author can delete it.", "--ticket", "CONDUIT-7");
    const listed = brain(dbPath, "facts");
    const retired = brain(dbPath, "facts", "retire", "1");
    const after = brain(dbPath, "facts", "api");
    brain(dbPath, "search", "refund policy");
    const gaps = brain(dbPath, "gaps");

    expect(added).toContain("Recorded fact #1 on api, confirmed by");
    expect(listed).toMatch(/^api\s+Only an article's author can delete it\. \(rule · human-reviewed · .+ · ticket CONDUIT-7 · fact #1\)/);
    expect(retired).toContain("Retired fact #1.");
    expect(after).toBe("No facts on api yet.\n");
    expect(gaps).toContain('1×  "refund policy"  (brain_search, last');
  }, 30_000);
});
