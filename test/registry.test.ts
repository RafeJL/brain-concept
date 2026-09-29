import { describe, expect, it } from "vitest";
import { enrolRepo, removeRepo } from "../src/ingest/registry.js";
import { syncRepo } from "../src/ingest/sync.js";
import { SqliteStore } from "../src/store/sqlite.js";
import { makeRepo, setRemote, tempDir } from "./helpers.js";

describe("registry", () => {
  it("enrols a repo by path, naming it after its folder and tracking main", async () => {
    const store = new SqliteStore(":memory:");
    const dir = makeRepo({ "README.md": "# hi" });

    const repo = await enrolRepo(store, { path: dir });

    expect(repo.name).toMatch(/^brain-test-/);
    expect(repo.ref).toBe("main");
    expect(store.listRepos().map((r) => r.name)).toEqual([repo.name]);
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
