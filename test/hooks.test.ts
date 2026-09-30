import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { hookStatus, installHook, removeHook, type HookCommand } from "../src/ingest/hooks.js";
import { enrolRepo } from "../src/ingest/registry.js";
import { syncRepo } from "../src/ingest/sync.js";
import { SqliteStore } from "../src/store/sqlite.js";
import { commitFixture, git, repoFromFixture, tempDir, waitFor } from "./helpers.js";

const BRAIN = fileURLToPath(new URL("../bin/brain.mjs", import.meta.url));

async function enrolled(dbPath = ":memory:") {
  const store = new SqliteStore(dbPath);
  const dir = repoFromFixture("articles-api");
  await enrolRepo(store, { path: dir, name: "api" });
  await syncRepo(store, "api");
  const command: HookCommand = { node: process.execPath, brain: BRAIN, logPath: join(tempDir(), "hooks.log") };
  return { store, dir, command, hookPath: join(dir, ".git", "hooks", "reference-transaction") };
}

describe("brain hooks", () => {
  it("installs a hook that watches the tracked ref, idempotently, and removes it", async () => {
    const { store, command, hookPath } = await enrolled();

    await installHook(store, "api", command);
    const first = readFileSync(hookPath, "utf8");
    await installHook(store, "api", command);

    expect(readFileSync(hookPath, "utf8")).toBe(first);
    expect(first).toContain("citation-brain: managed by `brain hooks`");
    expect(first).toContain("ref='refs/heads/main'");
    expect((await hookStatus(store, "api")).installed).toBe(true);

    expect(await removeHook(store, "api")).toBe(true);
    expect(existsSync(hookPath)).toBe(false);
    expect((await hookStatus(store, "api")).installed).toBe(false);
  });

  it("refuses to touch a reference-transaction hook it didn't write", async () => {
    const { store, command, hookPath } = await enrolled();
    writeFileSync(hookPath, "#!/bin/sh\necho theirs\n");

    await expect(installHook(store, "api", command)).rejects.toThrow(/already exists and isn't the brain's/);
    expect(await removeHook(store, "api")).toBe(false);
    expect(readFileSync(hookPath, "utf8")).toBe("#!/bin/sh\necho theirs\n");
    expect((await hookStatus(store, "api")).problem).toMatch(/already exists/);
  });

  it("refuses when core.hooksPath points at tracked files, such as husky's", async () => {
    const { store, dir, command } = await enrolled();
    git(dir, "config", "core.hooksPath", ".husky");

    await expect(installHook(store, "api", command)).rejects.toThrow(/core.hooksPath points inside the repository/);
    expect(existsSync(join(dir, ".husky", "reference-transaction"))).toBe(false);
  });

  it("re-syncs in the background when the tracked branch moves, and ignores other branches", async () => {
    const dbPath = join(tempDir(), "brain.db");
    const { store, dir, command } = await enrolled(dbPath);
    const before = store.getState("api")!.commit;
    await installHook(store, "api", { ...command, dbPath });

    git(dir, "switch", "--quiet", "-c", "feature");
    git(dir, "commit", "--quiet", "--allow-empty", "-m", "not on main");
    await new Promise((resolve) => setTimeout(resolve, 2500));
    expect(existsSync(command.logPath)).toBe(false);
    expect(store.getState("api")!.commit).toBe(before);

    git(dir, "switch", "--quiet", "main");
    const next = commitFixture(dir, "articles-api-v2");
    await waitFor(() => store.getState("api")?.commit === next, 30_000);

    expect(store.seams({ repos: ["api"] }).map((s) => `${s.method} ${s.key}`)).toEqual(["PUT /articles/{}", "GET /tags"]);
    expect(readFileSync(command.logPath, "utf8")).toContain("api: refs/heads/main moved");
    store.close();
  }, 60_000);
});
