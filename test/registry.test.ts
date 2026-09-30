import { describe, expect, it } from "vitest";
import { enrolRepo, removeRepo, setRepoRef } from "../src/ingest/registry.js";
import { syncRepo } from "../src/ingest/sync.js";
import { SqliteStore } from "../src/store/sqlite.js";
import { cloneRepo, commit, git, makeRepo, setRemote, tempDir } from "./helpers.js";

describe("registry", () => {
  it("enrols a repo by path, naming it after its folder and tracking main", async () => {
    const store = new SqliteStore(":memory:");
    const dir = makeRepo({ "README.md": "# hi" });

    const repo = await enrolRepo(store, { path: dir });

    expect(repo.name).toMatch(/^brain-test-/);
    expect(repo.ref).toBe("main");
    expect(store.listRepos().map((r) => r.name)).toEqual([repo.name]);
  });

  it("tracks origin's default branch in a clone, so a fetch brings new merges in", async () => {
    const store = new SqliteStore(":memory:");
    const clone = cloneRepo(makeRepo({ "README.md": "# origin" }));

    const repo = await enrolRepo(store, { path: clone, name: "cloned" });

    expect(repo.ref).toBe("origin/main");
  });

  it("set-ref changes what the next sync reads, and rejects refs that don't exist", async () => {
    const store = new SqliteStore(":memory:");
    const dir = makeRepo({ "a.ts": "1" });
    git(dir, "switch", "--quiet", "-c", "release");
    commit(dir, { "release.ts": "2" }, "release only");
    git(dir, "switch", "--quiet", "main");
    await enrolRepo(store, { path: dir, name: "r" });
    await syncRepo(store, "r");

    await setRepoRef(store, "r", "release");
    await syncRepo(store, "r");

    expect(store.getRepo("r")?.ref).toBe("release");
    expect(store.getFiles("r").map((f) => f.path)).toEqual(["a.ts", "release.ts"]);
    await expect(setRepoRef(store, "r", "nope")).rejects.toThrow(/does not resolve/);
  });

  it("strips credentials from the stored remote", async () => {
    const store = new SqliteStore(":memory:");
    const dir = makeRepo({ "a.txt": "a" });
    setRemote(dir, "https://someone:ghp_secret@github.com/acme/orders.git");

    const repo = await enrolRepo(store, { path: dir, name: "orders" });

    expect(repo.remote).toBe("https://github.com/acme/orders.git");
  });

  it("rejects folders that are not git repos, duplicate names and bad refs", async () => {
    const store = new SqliteStore(":memory:");
    const dir = makeRepo({ "a.txt": "a" });

    await expect(enrolRepo(store, { path: tempDir() })).rejects.toThrow(/not inside a git repository/);
    await enrolRepo(store, { path: dir, name: "orders" });
    await expect(enrolRepo(store, { path: dir, name: "orders" })).rejects.toThrow(/already enrolled/);
    await expect(enrolRepo(store, { path: dir, name: "other", ref: "nope" })).rejects.toThrow(/does not resolve/);
    await expect(enrolRepo(store, { path: dir, name: "bad name" })).rejects.toThrow(/not a valid repo name/);
  });

  it("removing a repo deletes its facts and nothing else", async () => {
    const store = new SqliteStore(":memory:");
    await enrolRepo(store, { path: makeRepo({ "a.ts": "1" }), name: "one" });
    await enrolRepo(store, { path: makeRepo({ "b.ts": "2" }), name: "two" });
    await syncRepo(store, "one");
    await syncRepo(store, "two");

    removeRepo(store, "one");

    expect(store.getFiles("one")).toEqual([]);
    expect(store.getState("one")).toBeUndefined();
    expect(store.getFiles("two")).toHaveLength(1);
    expect(() => removeRepo(store, "one")).toThrow(/No repo named/);
  });
});
