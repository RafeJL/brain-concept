import { describe, expect, it } from "vitest";
import { enrolRepo } from "../src/ingest/registry.js";
import { syncRepo } from "../src/ingest/sync.js";
import { LOCAL_CALLER, LocalAccessPolicy, type AccessPolicy } from "../src/serve/access.js";
import { parseEndpoint } from "../src/core/http.js";
import { findConsumers } from "../src/serve/tools/find-consumers.js";
import { repoCard } from "../src/serve/tools/repo-card.js";
import { SqliteStore } from "../src/store/sqlite.js";
import { commit, commitFixture, repoFromFixture } from "./helpers.js";

/** test/fixtures/repos/articles-api and articles-web, enrolled as "api" and "web". */
async function twoRepos() {
  const store = new SqliteStore(":memory:");
  const apiDir = repoFromFixture("articles-api");
  const webDir = repoFromFixture("articles-web");
  await enrolRepo(store, { path: apiDir, name: "api" });
  await enrolRepo(store, { path: webDir, name: "web" });
  await syncRepo(store, "api");
  await syncRepo(store, "web");
  return { store, apiDir, webDir, deps: { store, access: new LocalAccessPolicy() } };
}

describe("seam sync", () => {
  it("extracts seams tagged with repo, file, lines and commit", async () => {
    const { store } = await twoRepos();

    const routes = store.seams({ repos: ["api"] });

    expect(routes.map((s) => `${s.method} ${s.key} ${s.path}:${s.startLine}`)).toEqual([
      "GET /articles/{} src/articles.ts:3",
      "DELETE /articles/{} src/articles.ts:4",
    ]);
    expect(routes[0]?.commit).toBe(store.getState("api")?.commit);
  });

  it("replaces seams of changed files and drops seams of deleted files", async () => {
    const { store, apiDir } = await twoRepos();

    commitFixture(apiDir, "articles-api-v2");
    await syncRepo(store, "api");
    expect(store.seams({ repos: ["api"] }).map((s) => `${s.method} ${s.key}`)).toEqual(["PUT /articles/{}", "GET /tags"]);

    commit(apiDir, {}, "remove tags", ["src/tags.ts"]);
    await syncRepo(store, "api");
    expect(store.seams({ repos: ["api"] }).map((s) => s.path)).toEqual(["src/articles.ts"]);
  });

  it("re-extracts every file when the extractor version changes", async () => {
    const { store } = await twoRepos();
    const state = store.getState("api")!;
    // Simulate a store written by older extractors.
    store.applySync("api", { ...state, extractorVersion: 0, upsert: [], remove: [], extractedPaths: ["src/articles.ts"], seams: [] });
    expect(store.seams({ repos: ["api"] })).toEqual([]);

    const result = await syncRepo(store, "api");

    expect(result.fullExtract).toBe(true);
    expect(store.seams({ repos: ["api"] })).toHaveLength(2);
  });

  it("shows coverage on the repo card", async () => {
    const { deps } = await twoRepos();

    const card = await repoCard(deps, LOCAL_CALLER, "web", "concise");

    expect(card.text).toContain("Seams: 0 routes, 1 call (+1 with run-time URLs) via ts-calls");
  });
});

describe("brain_find_consumers", () => {
  it("parses targets in any style", () => {
    expect(parseEndpoint("GET /api/articles/:slug")).toEqual({ method: "GET", key: "/api/articles/{}" });
    expect(parseEndpoint("https://x.com/articles/{slug}", "delete")).toEqual({ method: "DELETE", key: "/articles/{}" });
    expect(parseEndpoint("/")).toBeNull();
  });

  it("finds the server and the caller across repos", async () => {
    const { deps } = await twoRepos();

    const result = await findConsumers(deps, LOCAL_CALLER, { target: "GET /articles/{slug}", format: "concise" });

    expect(result.ok).toBe(true);
    expect(result.text).toContain("GET /articles/{} · 1 server, 1 caller in 2 repos · parser-built");
    expect(result.text).toContain("api · src/articles.ts:3 · GET /articles/:slug");
    expect(result.text).toContain("web · src/agent.js:2 · GET `/articles/${slug}`");
    expect(result.text).toContain("1 call uses a URL only known at run time (web · src/agent.js:3)");
  });

  it("matches across a base path and filters by method", async () => {
    const { deps } = await twoRepos();

    const withBase = await findConsumers(deps, LOCAL_CALLER, { target: "/api/articles/:slug", format: "concise" });
    const deletes = await findConsumers(deps, LOCAL_CALLER, { target: "DELETE /articles/:slug", format: "concise" });

    expect(withBase.text).toContain("2 servers, 1 caller");
    expect(withBase.text).toContain("suffix = matched ignoring a base path");
    expect(deletes.text).toContain("1 server, 0 callers in 1 repo");
  });

  it("never returns seams from repos the caller cannot read", async () => {
    const { store } = await twoRepos();
    const onlyWeb: AccessPolicy = { readableRepos: async () => new Set(["web"]) };

    const result = await findConsumers({ store, access: onlyWeb }, LOCAL_CALLER, { target: "GET /articles/:slug", format: "concise" });

    expect(result.text).not.toContain("api ·");
    expect(result.text).toContain("0 servers, 1 caller in 1 repo");
  });

  it("points first at run-time URLs in the repos the answer involves", async () => {
    const { store, deps } = await twoRepos();
    await enrolRepo(store, { path: repoFromFixture("shop-web"), name: "shop" });
    await syncRepo(store, "shop");

    const result = await findConsumers(deps, LOCAL_CALLER, { target: "GET /articles/{slug}", format: "concise" });

    expect(result.text).toContain("2 calls use URLs only known at run time (web · src/agent.js:3, shop · src/api.ts:2)");
  });

  it("says when nothing matched, and why that isn't proof", async () => {
    const { deps } = await twoRepos();

    const result = await findConsumers(deps, LOCAL_CALLER, { target: "GET /nothing/here", format: "concise" });

    expect(result.text).toContain("No servers or callers found for GET /nothing/here.");
    expect(result.text).toContain("isn't proof");
  });
});
