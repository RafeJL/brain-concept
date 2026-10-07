import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { searchWords, splitSections } from "../src/core/sections.js";
import type { WikiPage } from "../src/core/types.js";
import { enrolRepo, removeRepo } from "../src/ingest/registry.js";
import { syncRepo } from "../src/ingest/sync.js";
import { LOCAL_CALLER, LocalAccessPolicy, type AccessPolicy } from "../src/serve/access.js";
import { matchExpression, search } from "../src/serve/tools/search.js";
import { MIGRATIONS } from "../src/store/migrations.js";
import { SqliteStore } from "../src/store/sqlite.js";
import { commit, makeRepo, mapSeams, repoFromFixture, tempDir } from "./helpers.js";

const local = new LocalAccessPolicy();

function page(repo: string, slug: string, title: string, markdown: string, commitSha = "0".repeat(40)): WikiPage {
  return { repo, slug, title, markdown, commit: commitSha, claims: 1, removed: 0, model: "claude-sonnet-5", costUsd: 0.1, generatedAt: "2026-10-07T00:00:00Z" };
}

const BUILD = `# Build, run and test

Install with \`npm ci\` [package.json:1-3].

## Running the tests

\`npm test\` runs vitest over \`test/\` [package.json:5]. Integration tests need Docker [docker-compose.yml:1-9].

## Deploying

Pushing a tag deploys through GitHub Actions [.github/workflows/release.yml:1-20].
`;

const AUTH = `# Auth

## Token validation

The API validates the bearer token's issuer and audience [src/Auth/JwtSetup.cs:10-22].
`;

/** Enrolled, synced repos with the given pages stored as their wikis. */
async function withWikis(wikis: Record<string, WikiPage[]>) {
  const store = new SqliteStore(":memory:");
  for (const [name, pages] of Object.entries(wikis)) {
    await enrolRepo(store, { path: makeRepo({ "a.ts": "1" }), name });
    const { commit: sha } = await syncRepo(store, name);
    store.replacePages(name, pages.map((p) => ({ ...p, commit: sha })));
  }
  return store;
}

describe("splitSections", () => {
  it("splits at ## and ### headings, takes citations out of the text and keeps the files they name", () => {
    const sections = splitSections(BUILD);

    expect(sections.map((s) => s.heading)).toEqual(["", "Running the tests", "Deploying"]);
    expect(sections[1]).toEqual({
      heading: "Running the tests",
      body: "`npm test` runs vitest over `test/`. Integration tests need Docker.",
      paths: ["package.json", "docker-compose.yml"],
    });
  });

  it("ignores headings inside code blocks and drops headings with nothing under them", () => {
    const sections = splitSections("# T\n\n## Empty\n\n## Shell\n\n```sh\n## not a heading\nmake\n```\n");

    expect(sections.map((s) => s.heading)).toEqual(["Shell"]);
    expect(sections[0]!.body).toContain("## not a heading");
  });

  it("keeps the dot in .NET when tidying the space a citation leaves", () => {
    expect(splitSections("It targets .NET 10 [a.csproj:3].")[0]!.body).toBe("It targets .NET 10.");
  });
});

describe("searchWords", () => {
  it("also writes camelCase and PascalCase words apart", () => {
    expect(searchWords("src/OrdersController.cs")).toBe("src/OrdersController.cs src/Orders Controller.cs");
    expect(searchWords("/api/orderItems")).toBe("/api/orderItems /api/order Items");
    expect(searchWords("/health")).toBe("/health");
  });
});

describe("matchExpression", () => {
  it("ORs the meaningful words", () => {
    expect(matchExpression("How do I run the tests?")).toBe('"run" OR "tests"');
  });

  it("treats FTS syntax as plain words", () => {
    expect(matchExpression('"jwt" NEAR(auth*) -token')).toBe('"jwt" OR "near" OR "auth" OR "token"');
  });

  it("keeps stop words when they're all there is, and has nothing for a query without words", () => {
    expect(matchExpression("how")).toBe('"how"');
    expect(matchExpression("?! --")).toBeNull();
  });
});

describe("brain_search", () => {
  it("finds the section a question is about, with its pointer and readable text", async () => {
    const store = await withWikis({ shop: [page("shop", "build-run-test", "Build, run and test", BUILD)], auth: [page("auth", "auth", "Auth", AUTH)] });

    const result = await search({ store, access: local }, LOCAL_CALLER, { query: "how do I run the integration tests", format: "concise" });

    expect(result.ok).toBe(true);
    expect(result.ok && result.data.sections[0]).toMatchObject({ repo: "shop", slug: "build-run-test", heading: "Running the tests" });
    expect(result.text).toContain("shop · build-run-test › Running the tests");
    expect(result.text).toContain("Integration tests need Docker.");
    expect(result.text).not.toContain("[docker-compose.yml");
    expect(result.text).toContain('Read a section\'s page with brain_get, e.g. repo "shop", page "build-run-test".');
    expect(result.text).toMatch(/Indexed: shop @[0-9a-f]{7} · up to date/);
  });

  it("matches other forms of a word and the files a section cites", async () => {
    const store = await withWikis({ auth: [page("auth", "auth", "Auth", AUTH)] });
    const deps = { store, access: local };

    const stemmed = await search(deps, LOCAL_CALLER, { query: "validating", format: "concise" });
    const byFile = await search(deps, LOCAL_CALLER, { query: "jwt setup", format: "concise" });

    expect(stemmed.ok && stemmed.data.sections.map((s) => s.heading)).toEqual(["Token validation"]);
    expect(byFile.ok && byFile.data.sections.map((s) => s.heading)).toEqual(["Token validation"]);
  });

  it("finds endpoints by their path, once each, pointing at the declaring lines", async () => {
    const store = new SqliteStore(":memory:");
    await enrolRepo(store, { path: repoFromFixture("orders-api"), name: "orders-api" });
    await syncRepo(store, "orders-api");
    await mapSeams(store, "orders-api");

    const result = await search({ store, access: local }, LOCAL_CALLER, { query: "orders", format: "concise" });

    expect(result.ok && result.data.endpoints.map((s) => `${s.kind} ${s.method} ${s.rawPath}`).sort()).toEqual([
      "http-call GET /api/orders/{id}",
      "http-route DELETE /api/orders/{id}",
      "http-route GET /api/orders/{id}",
      "http-route GET /api/orders/{orderId}",
    ]);
    expect(result.text).toContain("GET /api/orders/{id} · orders-api · src/OrdersController.cs:4-5 (route)");
    expect(result.text).toContain("For every server and caller of an endpoint, use brain_find_consumers.");
    expect(result.text).toContain("No wiki yet, so not searched: orders-api");
  });

  it("never returns or counts a repo the caller can't read, and limits to the repos asked for", async () => {
    const store = await withWikis({
      "public-api": [page("public-api", "auth", "Auth", AUTH)],
      "secret-payroll": [page("secret-payroll", "auth", "Auth", AUTH)],
      shop: [page("shop", "build-run-test", "Build, run and test", BUILD)],
    });
    const notPayroll: AccessPolicy = { readableRepos: async () => new Set(["public-api", "shop"]) };

    const hidden = await search({ store, access: notPayroll }, LOCAL_CALLER, { query: "token", format: "concise" });
    const limited = await search({ store, access: local }, LOCAL_CALLER, { query: "token", repos: ["public-api"], format: "concise" });

    expect(hidden.ok && hidden.data.sectionTotal).toBe(1);
    expect(hidden.ok && hidden.data.matchedRepos).toEqual(["public-api"]);
    expect(hidden.text).not.toContain("secret-payroll");
    expect(limited.ok && limited.data.sections.map((s) => s.repo)).toEqual(["public-api"]);
  });

  it("says when nothing matches, naming repos that have no wiki to search", async () => {
    const store = await withWikis({ shop: [page("shop", "build-run-test", "Build, run and test", BUILD)] });
    await enrolRepo(store, { path: makeRepo({ "a.ts": "1" }), name: "billing" });

    const none = await search({ store, access: local }, LOCAL_CALLER, { query: "kafka", format: "concise" });
    const noWords = await search({ store, access: local }, LOCAL_CALLER, { query: "?!", format: "concise" });

    expect(none.text).toBe('No wiki sections or endpoints match "kafka" in 2 repos.\nNo wiki yet, so not searched: billing (brain sync <repo> writes one).');
    expect(noWords).toMatchObject({ ok: false, text: '"?!" has no words to search for.' });
  });

  it("pages through sections with offset", async () => {
    const many = Array.from({ length: 25 }, (_, i) => `## Topic ${i}\n\nThe cache is warmed here [a.ts:1].`).join("\n\n");
    // billing's one long section ranks below shop's short ones, so it isn't on the first page.
    const long = `## Billing\n\n${"Invoices are totalled and sent monthly. ".repeat(40)}The cache is cleared [b.ts:1].`;
    const store = await withWikis({
      shop: [page("shop", "notes", "Notes", `# Notes\n\n${many}`)],
      billing: [page("billing", "notes", "Notes", long)],
    });
    const deps = { store, access: local };

    const first = await search(deps, LOCAL_CALLER, { query: "cache", format: "concise" });
    const second = await search(deps, LOCAL_CALLER, { query: "cache", format: "concise", offset: 20 });

    expect(first.ok && first.data.sections.map((s) => s.repo)).toEqual(Array(8).fill("shop"));
    expect(first.text).toContain("Showing sections 1-8 of 26. Pass offset=8 for more.");
    // The header counts every repo that matched, not only those on this page.
    expect(first.text).toMatch(/^26 sections match "cache" across 2 repos\n/);
    expect(second.ok && second.data.sections).toHaveLength(6);
    expect(second.text).not.toContain("Showing sections");
  });
});

describe("search index upkeep", () => {
  it("follows page rewrites, seam updates, deleted files and removed repos", async () => {
    const store = new SqliteStore(":memory:");
    const dir = repoFromFixture("orders-api");
    await enrolRepo(store, { path: dir, name: "orders-api" });
    const { commit: sha } = await syncRepo(store, "orders-api");
    await mapSeams(store, "orders-api");
    const sections = (query: string) => store.searchSections({ repos: ["orders-api"], match: query, limit: 10 }).total;
    const seams = (query: string) => store.searchSeams({ repos: ["orders-api"], match: query, limit: 10 }).total;

    store.replacePages("orders-api", [page("orders-api", "auth", "Auth", AUTH, sha)]);
    expect(sections('"token"')).toBe(1);
    store.replacePages("orders-api", [page("orders-api", "build", "Build", BUILD, sha)]);
    expect(sections('"token"')).toBe(0);
    expect(sections('"docker"')).toBe(1);

    expect(seams('"health"')).toBe(1);
    commit(dir, {}, "drop health", ["src/Health.cs"]);
    await syncRepo(store, "orders-api");
    expect(seams('"health"')).toBe(0);
    expect(seams('"orders"')).toBe(4);

    removeRepo(store, "orders-api");
    expect(store.searchSections({ repos: ["orders-api"], match: '"docker"', limit: 10 }).total).toBe(0);
    expect(store.searchSeams({ repos: ["orders-api"], match: '"orders"', limit: 10 }).total).toBe(0);
  });

  it("indexes the pages and seams of a store made before search (migration 8), and drops the parser column (migration 9)", () => {
    const file = join(tempDir(), "brain.db");
    const old = new DatabaseSync(file);
    MIGRATIONS.slice(0, 7).forEach((m) => old.exec(m as string));
    old.exec(`
      PRAGMA user_version = 7;
      INSERT INTO repos (name, path, ref, enrolled_at) VALUES ('shop', '/x', 'main', 'now');
      INSERT INTO files (repo, path, blob, bytes, commit_sha) VALUES ('shop', 'src/Orders.cs', 'b', 1, 'c');
      INSERT INTO seams (repo, path, kind, method, raw_path, route_key, start_line, end_line, plugin, commit_sha)
        VALUES ('shop', 'src/Orders.cs', 'http-route', 'GET', '/api/orders', '/api/orders', 1, 1, 'claude', 'c');
    `);
    old.prepare("INSERT INTO pages (repo, slug, position, title, markdown, commit_sha, model, cost_usd, generated_at) VALUES ('shop', 'auth', 0, 'Auth', ?, 'c', 'm', 0, 'now')").run(AUTH);
    old.close();

    const store = new SqliteStore(file);

    expect(store.searchSections({ repos: ["shop"], match: '"token"', limit: 10 }).hits.map((h) => h.heading)).toEqual(["Token validation"]);
    expect(store.searchSeams({ repos: ["shop"], match: '"orders"', limit: 10 }).hits.map((h) => h.rawPath)).toEqual(["/api/orders"]);
    store.close();
    const after = new DatabaseSync(file);
    const columns = (after.prepare("PRAGMA table_info(seams)").all() as { name: string }[]).map((c) => c.name);
    after.close();
    expect(columns).not.toContain("plugin");
  });
});
