import { describe, expect, it } from "vitest";
import { enrolRepo } from "../src/ingest/registry.js";
import { syncRepo } from "../src/ingest/sync.js";
import { LOCAL_CALLER, LocalAccessPolicy, type AccessPolicy } from "../src/serve/access.js";
import { repoCard } from "../src/serve/tools/repo-card.js";
import { SqliteStore } from "../src/store/sqlite.js";
import { commit, makeRepo } from "./helpers.js";

const local = new LocalAccessPolicy();

describe("repo card", () => {
  it("names the indexed commit, freshness, tier and languages", async () => {
    const store = new SqliteStore(":memory:");
    await enrolRepo(store, { path: makeRepo({ "a.ts": "1", "b.ts": "2", "c.md": "3" }), name: "orders" });
    const { commit: sha } = await syncRepo(store, "orders");

    const result = await repoCard({ store, access: local }, LOCAL_CALLER, "orders", "concise");

    expect(result.ok).toBe(true);
    expect(result.text).toContain(`orders  @${sha.slice(0, 7)} · up to date · parser-built`);
    expect(result.text).toContain("Languages: TypeScript 2 · Markdown 1");
  });

  it("reports how many commits the index is behind the tracked branch", async () => {
    const store = new SqliteStore(":memory:");
    const dir = makeRepo({ "a.ts": "1" });
    await enrolRepo(store, { path: dir, name: "orders" });
    await syncRepo(store, "orders");
    commit(dir, { "a.ts": "2" });
    commit(dir, { "a.ts": "3" });

    const result = await repoCard({ store, access: local }, LOCAL_CALLER, "orders", "concise");

    expect(result.text).toContain("2 commits behind main");
  });

  it("detailed format includes the full commit and a language table", async () => {
    const store = new SqliteStore(":memory:");
    await enrolRepo(store, { path: makeRepo({ "a.ts": "12345" }), name: "orders" });
    const { commit: sha } = await syncRepo(store, "orders");

    const result = await repoCard({ store, access: local }, LOCAL_CALLER, "orders", "detailed");

    expect(result.text).toContain(`Indexed commit: ${sha}`);
    expect(result.text).toMatch(/TypeScript\s+1 files\s+5 B/);
  });

  it("asks for a sync when a repo is enrolled but not indexed", async () => {
    const store = new SqliteStore(":memory:");
    await enrolRepo(store, { path: makeRepo({ "a.ts": "1" }), name: "orders" });

    const result = await repoCard({ store, access: local }, LOCAL_CALLER, "orders", "concise");

    expect(result).toMatchObject({ ok: false });
    expect(result.text).toContain("brain sync orders");
  });

  it("answers the same way for unreadable and unknown repos, listing only readable ones", async () => {
    const store = new SqliteStore(":memory:");
    await enrolRepo(store, { path: makeRepo({ "a.ts": "1" }), name: "public-api" });
    await enrolRepo(store, { path: makeRepo({ "b.ts": "1" }), name: "secret-payroll" });
    await syncRepo(store, "secret-payroll");
    const onlyPublic: AccessPolicy = { readableRepos: async () => new Set(["public-api"]) };

    const denied = await repoCard({ store, access: onlyPublic }, LOCAL_CALLER, "secret-payroll", "concise");
    const unknown = await repoCard({ store, access: onlyPublic }, LOCAL_CALLER, "nope", "concise");

    expect(denied.ok).toBe(false);
    expect(denied.text).toBe('No readable repo named "secret-payroll". Repos you can read: public-api.');
    expect(unknown.text).toBe('No readable repo named "nope". Repos you can read: public-api.');
  });
});
