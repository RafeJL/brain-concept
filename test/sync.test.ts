import { describe, expect, it } from "vitest";
import { enrolRepo } from "../src/ingest/registry.js";
import { syncRepo } from "../src/ingest/sync.js";
import { SqliteStore } from "../src/store/sqlite.js";
import { commit, makeRepo, repoFromFixture, writeFiles } from "./helpers.js";

describe("sync", () => {
  it("indexes every file in the committed tree with its language", async () => {
    const store = new SqliteStore(":memory:");
    const dir = repoFromFixture("mixed-languages");
    await enrolRepo(store, { path: dir, name: "r" });

    const result = await syncRepo(store, "r");

    expect(result).toMatchObject({ added: 4, changed: 0, removed: 0, previousCommit: null });
    const languages = Object.fromEntries(store.getFiles("r").map((f) => [f.path, f.language]));
    expect(languages).toEqual({ "README.md": "Markdown", "logo.bin": null, "src/Api.cs": "C#", "src/app.ts": "TypeScript" });
    expect(store.getState("r")).toMatchObject({ commit: result.commit, fileCount: 4 });
  });

  it("only rewrites files whose content changed, and drops deleted files", async () => {
    const store = new SqliteStore(":memory:");
    const dir = makeRepo({ "keep.ts": "1", "edit.ts": "1", "gone.ts": "1" });
    await enrolRepo(store, { path: dir, name: "r" });
    const first = await syncRepo(store, "r");

    const second = commit(dir, { "edit.ts": "2", "new.ts": "1" }, "change", ["gone.ts"]);
    const result = await syncRepo(store, "r");

    expect(result).toMatchObject({ previousCommit: first.commit, commit: second, added: 1, changed: 1, removed: 1, unchanged: 1 });
    const files = Object.fromEntries(store.getFiles("r").map((f) => [f.path, f.commit]));
    expect(files).toEqual({ "keep.ts": first.commit, "edit.ts": second, "new.ts": second });
  });

  it("reads the tracked branch, not the working copy", async () => {
    const store = new SqliteStore(":memory:");
    const dir = makeRepo({ "a.ts": "1" });
    await enrolRepo(store, { path: dir, name: "r" });
    writeFiles(dir, { "uncommitted.ts": "draft", "a.ts": "edited but not committed" });

    await syncRepo(store, "r");

    expect(store.getFiles("r").map((f) => f.path)).toEqual(["a.ts"]);
  });

  it("is a no-op when nothing changed", async () => {
    const store = new SqliteStore(":memory:");
    await enrolRepo(store, { path: makeRepo({ "a.ts": "1", "b.ts": "2" }), name: "r" });
    await syncRepo(store, "r");

    const again = await syncRepo(store, "r");

    expect(again).toMatchObject({ added: 0, changed: 0, removed: 0, unchanged: 2 });
  });
});
