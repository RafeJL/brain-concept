import { describe, expect, it } from "vitest";
import { enrolRepo } from "../src/ingest/registry.js";
import { syncRepo } from "../src/ingest/sync.js";
import { LOCAL_CALLER, LocalAccessPolicy, type AccessPolicy } from "../src/serve/access.js";
import { repoCard } from "../src/serve/tools/repo-card.js";
import { SqliteStore } from "../src/store/sqlite.js";
import { commit, makeRepo, mapSeams, repoFromFixture } from "./helpers.js";

const local = new LocalAccessPolicy();

describe("repo card", () => {
  it("names the indexed commit, freshness and languages", async () => {
    const store = new SqliteStore(":memory:");
    await enrolRepo(store, { path: makeRepo({ "a.ts": "1", "b.ts": "2", "c.md": "3" }), name: "orders" });
    const { commit: sha } = await syncRepo(store, "orders");

    const result = await repoCard({ store, access: local }, LOCAL_CALLER, "orders", "concise");

    expect(result.ok).toBe(true);
    expect(result.text).toContain(`orders  @${sha.slice(0, 7)} · up to date`);
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

  it("says how to finish a repo that is enrolled but not indexed", async () => {
    const store = new SqliteStore(":memory:");
    await enrolRepo(store, { path: makeRepo({ "a.ts": "1" }), name: "orders" });

    const result = await repoCard({ store, access: local }, LOCAL_CALLER, "orders", "concise");

    expect(result).toMatchObject({ ok: false });
    expect(result.text).toContain("hasn't been indexed yet. Adding it again with brain_add_repo indexes it.");
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

/** Enrols, syncs and maps fixture repos under their own names. */
async function enrolled(...names: string[]) {
  const store = new SqliteStore(":memory:");
  for (const name of names) {
    await enrolRepo(store, { path: repoFromFixture(name), name });
    await syncRepo(store, name);
    await mapSeams(store, name);
  }
  return store;
}

describe("repo card neighbours", () => {
  it("names the repos it calls and the repos that call it, not counting its own tests", async () => {
    const store = await enrolled("orders-api", "shop-web");
    const deps = { store, access: local };

    const api = await repoCard(deps, LOCAL_CALLER, "orders-api", "concise");
    const web = await repoCard(deps, LOCAL_CALLER, "shop-web", "concise");

    expect(api.ok && api.data.neighbours).toEqual({ calls: [], calledBy: [{ repo: "shop-web", count: 1, suffix: false }] });
    expect(api.text).toContain("Called by: shop-web (1 call)");
    expect(web.ok && web.data.neighbours).toEqual({ calls: [{ repo: "orders-api", count: 1, suffix: false }], calledBy: [] });
    expect(web.text).toContain("Calls: orders-api (1 endpoint)");
  });

  it("doesn't link repos just because both use the root path", async () => {
    const store = await enrolled("status-api", "status-checks");

    const result = await repoCard({ store, access: local }, LOCAL_CALLER, "status-checks", "concise");

    // Both endpoints are called, but only /status names status-api; every web app serves "/".
    expect(result.ok && result.data.neighbours.calls).toEqual([{ repo: "status-api", count: 1, suffix: false }]);
  });

  it("doesn't link a repo's calls to its own routes with another repo serving the same path", async () => {
    // Two copies of an API: each one's tests call its own GET /api/orders/{id}, not the other's.
    const store = await enrolled("orders-api");
    await enrolRepo(store, { path: repoFromFixture("orders-api"), name: "orders-copy" });
    await syncRepo(store, "orders-copy");
    await mapSeams(store, "orders-copy", "orders-api");

    const result = await repoCard({ store, access: local }, LOCAL_CALLER, "orders-copy", "concise");

    expect(result.ok && result.data.neighbours).toEqual({ calls: [], calledBy: [] });
  });

  it("never names a repo the caller can't read", async () => {
    const store = await enrolled("orders-api", "shop-web");
    const onlyApi: AccessPolicy = { readableRepos: async () => new Set(["orders-api"]) };

    const result = await repoCard({ store, access: onlyApi }, LOCAL_CALLER, "orders-api", "concise");

    expect(result.text).not.toContain("shop-web");
    expect(result.text).toContain("Neighbours: none found among enrolled repos");
  });
});
