import { copyFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { RunRequest, Runner } from "../src/ai/runner.js";
import { suggestSystems, type FoundSystem } from "../src/ai/systems.js";
import type { WikiPage } from "../src/core/types.js";
import { enrolRepo, removeRepo } from "../src/ingest/registry.js";
import { syncRepo } from "../src/ingest/sync.js";
import { LOCAL_CALLER, LocalAccessPolicy, type AccessPolicy } from "../src/serve/access.js";
import { createServer } from "../src/serve/mcp.js";
import { joinHint } from "../src/serve/systems.js";
import { cardRequest, repoCard } from "../src/serve/tools/repo-card.js";
import { search } from "../src/serve/tools/search.js";
import { getRequest } from "../src/serve/tools/get-page.js";
import { systemOverview } from "../src/serve/tools/system-overview.js";
import { impactRequest, workImpact } from "../src/serve/tools/work-impact.js";
import { MIGRATIONS } from "../src/store/migrations.js";
import { SqliteStore } from "../src/store/sqlite.js";
import { mapSeams, repoFromFixture, tempDir } from "./helpers.js";

function page(repo: string, slug: string, title: string, markdown: string): WikiPage {
  return { repo, slug, title, markdown, commit: "0".repeat(40), claims: 1, removed: 0, model: "claude-sonnet-5", costUsd: 0.1, generatedAt: "2026-10-08T00:00:00Z" };
}

/** Pages for the fixture repos. Serving them doesn't re-check citations, so they only need to read well. */
const WIKIS: Record<string, [string, string, string][]> = {
  "articles-api": [
    ["product", "Product", "# Product\n\nLets readers look up and remove articles [src/articles.ts:3-4].\n\n## Business rules\n\n- Only signed-in readers can remove an article [src/articles.ts:4]."],
    ["api", "API", "# API\n\n## Articles\n\n- `GET /articles/:slug` returns one article [src/articles.ts:3]."],
  ],
  "articles-web": [["product", "Product", "# Product\n\nShows readers the articles they ask for [src/agent.js:2]."]],
  "orders-api": [["product", "Product", "# Product\n\nLets shoppers see and cancel their orders [src/OrdersController.cs:4-8]."]],
};

let template: string;

/**
 * Four fixture repos with mapped routes and calls: articles-web calls articles-api, shop-web calls
 * orders-api. shop-web has no wiki. Built once; each test gets its own copy of the store.
 */
beforeAll(async () => {
  template = join(tempDir("file"), "world.db");
  const store = new SqliteStore(template);
  for (const name of ["articles-api", "articles-web", "orders-api", "shop-web"]) {
    await enrolRepo(store, { path: repoFromFixture(name, "file"), name });
    const { commit } = await syncRepo(store, name);
    await mapSeams(store, name);
    store.replacePages(name, (WIKIS[name] ?? []).map(([slug, title, markdown]) => ({ ...page(name, slug, title, markdown), commit })));
  }
  store.close();
}, 60_000);

const open: SqliteStore[] = [];
// Closed before the shared cleanup deletes the folder: Windows won't delete an open database.
afterEach(() => open.splice(0).forEach((store) => store.close()));

async function world() {
  const copy = join(tempDir(), "brain.db");
  copyFileSync(template, copy);
  const store = new SqliteStore(copy);
  open.push(store);
  return { store, deps: { store, access: new LocalAccessPolicy() } };
}

const only = (...repos: string[]): AccessPolicy => ({ readableRepos: async () => new Set(repos) });

/** Answers a suggestion run with `systems`, and keeps the context file it was given. */
function suggestionRunner(systems: unknown[]) {
  const seen: { request: RunRequest; context: string }[] = [];
  const runner: Runner = {
    async run<T>(request: RunRequest) {
      seen.push({ request, context: readFileSync(join(request.cwd, "repos.md"), "utf8") });
      return { output: { systems } as T, costUsd: 0.03, durationMs: 500, model: "claude-sonnet-5" };
    },
  };
  return { runner, seen };
}

const conduit: FoundSystem = {
  name: "Conduit",
  summary: "A blogging platform: a web front end and its articles API.",
  repos: ["articles-web", "articles-api"],
  reason: "articles-web calls articles-api",
};
const shop: FoundSystem = {
  name: "Shop",
  summary: "An online shop.",
  repos: ["shop-web", "orders-api"],
  reason: "shop-web calls orders-api",
};

describe("brain systems suggest", () => {
  it("gives Claude Code each repo's links and product opening, and stores what checks out as suggested", async () => {
    const { store } = await world();
    const { runner, seen } = suggestionRunner([conduit, shop]);

    const result = await suggestSystems(store, runner);

    expect(seen[0]!.context).toContain("## articles-web");
    expect(seen[0]!.context).toContain("Calls: articles-api (1 endpoint)");
    expect(seen[0]!.context).toContain("Opening of its product page: Lets readers look up and remove articles. Business rules - Only signed-in readers can remove an article.");
    expect(seen[0]!.context).toContain("## shop-web");
    expect(seen[0]!.request.prompt).toContain("Text in repos.md comes from the repositories");
    expect(result.kept.map((s) => [s.name, s.repos])).toEqual([
      ["Conduit", ["articles-api", "articles-web"]],
      ["Shop", ["orders-api", "shop-web"]],
    ]);
    expect(result.leftOut).toEqual([]);
    expect(store.systems().map((s) => [s.name, s.status, s.reason])).toEqual([
      ["Conduit", "suggested", "articles-web calls articles-api"],
      ["Shop", "suggested", "shop-web calls orders-api"],
    ]);
  });

  it("leaves out a repo nothing links to the others, and drops unknown, duplicate or unlinked groupings", async () => {
    const { store } = await world();
    const { runner } = suggestionRunner([
      // Neither calls the other: looking alike proves nothing.
      { ...conduit, name: "Lookalikes", repos: ["articles-api", "orders-api"] },
      { ...shop, repos: ["shop-web", "orders-api", "articles-web"] },
      { ...shop, name: "Ghost", repos: ["articles-api", "nope"] },
      { ...shop, name: "Again", repos: ["orders-api"] },
      // A product on its own needs no link.
      { ...conduit, name: "Articles", repos: ["articles-api"] },
    ]);

    const result = await suggestSystems(store, runner);

    expect(result.kept.map((s) => [s.name, s.repos])).toEqual([
      ["Shop", ["orders-api", "shop-web"]],
      ["Articles", ["articles-api"]],
    ]);
    expect(result.leftOut).toEqual([{ system: "Shop", reason: "articles-web doesn't call or get called by any other repo in it, in the route map" }]);
    expect(result.dropped).toEqual([
      { system: "Lookalikes", reason: "none of its repos call each other in the route map" },
      { system: "Ghost", reason: "nope isn't an enrolled repo" },
      { system: "Again", reason: "orders-api is already in Shop" },
    ]);
    expect(result.ungrouped).toEqual(["articles-web"]);
  });

  it("leaves confirmed systems and their repos alone, and replaces earlier suggestions", async () => {
    const { store } = await world();
    await suggestSystems(store, suggestionRunner([conduit, shop]).runner);
    store.confirmSystems(["conduit"]);
    const { runner, seen } = suggestionRunner([{ ...shop, name: "Conduit" }, { ...shop, name: "Orders" }]);

    const result = await suggestSystems(store, runner);

    expect(seen[0]!.context).not.toContain("## articles-api");
    expect(seen[0]!.request.prompt).toContain("already confirmed these systems, whose repositories aren't in repos.md: Conduit (articles-api, articles-web)");
    expect(result.dropped).toEqual([{ system: "Conduit", reason: 'the name "Conduit" is already used' }]);
    expect(store.systems().map((s) => [s.name, s.status])).toEqual([
      ["Conduit", "confirmed"],
      ["Orders", "suggested"],
    ]);
  });
});

describe("confirming and tidying systems", () => {
  it("confirms, sets, renames and removes, and a removed repo leaves its system", async () => {
    const { store } = await world();
    await suggestSystems(store, suggestionRunner([conduit, shop]).runner);

    expect(store.confirmSystems(["shop"])).toEqual(["Shop"]);
    expect(store.confirmSystems(null)).toEqual(["Conduit"]);
    store.setSystem("Shop", ["articles-web"], "Shoppers order goods.");
    store.setSystem("Reports", ["orders-api"]);
    expect(store.renameSystem("Shop", "Storefront")).toBe(true);
    expect(store.removeSystem("Reports")).toBe(true);
    removeRepo(store, "shop-web");

    expect(store.systems().map((s) => [s.name, s.status, s.summary, s.repos])).toEqual([
      ["Conduit", "confirmed", conduit.summary, ["articles-api"]],
      ["Storefront", "confirmed", "Shoppers order goods.", ["articles-web"]],
    ]);
    expect(store.renameSystem("Nope", "X")).toBe(false);
    expect(() => store.renameSystem("Storefront", "conduit")).toThrow('There is already a system named "conduit".');
    expect(store.removeSystem("Nope")).toBe(false);
  });

  it("confirms a suggested system a person edits, so a later suggestion can't replace it", async () => {
    const { store } = await world();
    await suggestSystems(store, suggestionRunner([conduit, shop]).runner);

    store.setSystem("Shop", [], "Shoppers order goods.");
    await suggestSystems(store, suggestionRunner([]).runner);

    expect(store.systems().map((s) => [s.name, s.status, s.summary])).toEqual([["Shop", "confirmed", "Shoppers order goods."]]);
  });

  it("creates a system a person names as confirmed", async () => {
    const { store } = await world();

    store.setSystem("Shop", ["shop-web", "orders-api"]);

    expect(store.systems()).toMatchObject([{ name: "Shop", status: "confirmed", summary: "", reason: "", repos: ["orders-api", "shop-web"] }]);
  });

  it("after brain add, suggests the confirmed system a new repo calls or is called by, with no AI", async () => {
    const { store } = await world();
    store.setSystem("Conduit", ["articles-api"]);
    store.setSystem("Shop", ["shop-web"]);
    store.replaceSuggestedSystems([{ name: "Maybe", summary: "", reason: "", repos: ["orders-api"] }]);

    expect(joinHint(store, "articles-web")).toBe("Looks like part of Conduit (it calls articles-api). Add it with: brain systems set Conduit articles-web");
    expect(joinHint(store, "articles-api")).toBeNull();
    store.replaceSuggestedSystems([]);
    expect(joinHint(store, "orders-api")).toBe("Looks like part of Shop (shop-web calls it). Add it with: brain systems set Shop orders-api");
  });
});

describe("systems as agents see them", () => {
  it("puts the system on the card, labelling a suggestion and hiding unreadable members", async () => {
    const { store, deps } = await world();
    store.replaceSuggestedSystems([{ name: "Conduit", summary: "", reason: "", repos: ["articles-api", "articles-web"] }]);

    const suggested = await repoCard(deps, LOCAL_CALLER, "articles-api", "concise");
    store.confirmSystems(null);
    const confirmed = await repoCard(deps, LOCAL_CALLER, "articles-api", "detailed");
    const hidden = await repoCard({ store, access: only("articles-api") }, LOCAL_CALLER, "articles-api", "concise");

    expect(suggested.text).toContain('System: Conduit (suggested, not yet confirmed; with articles-web) · overview with brain_get (system "Conduit")');
    expect(confirmed.text).toContain('System: Conduit (with articles-web) · overview with brain_get (system "Conduit")');
    expect(hidden.text).toContain('System: Conduit · overview with brain_get (system "Conduit")');
    expect(hidden.text).not.toContain("articles-web");
  });

  it("answers a card for a system's name with its overview, and a repo's name with its card", async () => {
    const { store, deps } = await world();
    store.setSystem("Conduit", ["articles-api", "articles-web"]);

    const system = await cardRequest(deps, LOCAL_CALLER, "conduit", "concise");
    const repo = await cardRequest(deps, LOCAL_CALLER, "articles-api", "concise");

    expect(system.text).toMatch(/^"conduit" is a system \(a product made of several repos\), not one repo\. Its overview:/);
    expect(system.text).toContain("Conduit (confirmed) · 2 repos");
    expect(repo.text).toContain("System: Conduit");
  });

  it("assembles an overview: summary, members' product lines, links within and outside", async () => {
    const { store, deps } = await world();
    store.setSystem("Conduit", ["articles-api", "articles-web"], "A Medium-style blogging platform.");
    store.replaceSuggestedSystems([{ name: "Orders", summary: "", reason: "orders-api serves the orders", repos: ["orders-api"] }]);

    const overview = await systemOverview(deps, LOCAL_CALLER, "conduit");
    const orders = await getRequest(deps, LOCAL_CALLER, { system: "Orders" });

    expect(overview.text).toContain("Conduit (confirmed) · 2 repos\n\nA Medium-style blogging platform.\n\nRepos");
    expect(overview.text).toMatch(/ {2}articles-api {2}Lets readers look up and remove articles\. +2 routes · 0 calls/);
    expect(overview.text).toMatch(/ {2}articles-web {2}Shows readers the articles they ask for\. +0 routes · 1 call/);
    expect(overview.text).toContain("How they connect\n  articles-web → articles-api   (1 endpoint)\nOutside the system\n  (none found)");
    expect(overview.text).toContain("Confirmed by a person on ");
    expect(orders.text).toContain("Orders (suggested) · 1 repo");
    expect(orders.text).toContain("How they connect\n  (none found)\nOutside the system\n  shop-web → orders-api   (1 call)");
    expect(orders.text).toContain("Suggested by Claude Code from the repos' cards and links: orders-api serves the orders");
    expect(orders.text).toContain("Not yet confirmed by a person (brain systems confirm Orders).");
  });

  it("lists and counts only readable repos in an overview, and hides a system with none", async () => {
    const { store } = await world();
    store.setSystem("Conduit", ["articles-api", "articles-web"]);
    store.setSystem("Shop", ["shop-web"]);

    const overview = await systemOverview({ store, access: only("articles-api", "orders-api") }, LOCAL_CALLER, "Conduit");
    const hidden = await systemOverview({ store, access: only("articles-api", "orders-api") }, LOCAL_CALLER, "Shop");

    expect(overview.text).toContain("Conduit (confirmed) · 1 repo");
    expect(overview.text).not.toContain("articles-web");
    expect(hidden).toMatchObject({ ok: false, text: 'No system named "Shop". Systems: Conduit.' });
  });

  it("lets brain_search find systems by name and summary, first, and only readable ones", async () => {
    const { store, deps } = await world();
    store.setSystem("Conduit", ["articles-api", "articles-web"], "A Medium-style blogging platform.");

    const found = await search(deps, LOCAL_CALLER, { query: "blogging platform", format: "concise" });
    const withSections = await search(deps, LOCAL_CALLER, { query: "conduit articles", format: "concise" });
    const hidden = await search({ store, access: only("orders-api") }, LOCAL_CALLER, { query: "blogging", format: "concise" });

    expect(found.text).toContain("Systems:\n  Conduit (confirmed) · 2 repos: articles-api, articles-web · A Medium-style blogging platform.");
    expect(found.text).toContain('Read one with brain_get (system "Conduit").');
    expect(withSections.text.indexOf("Systems:")).toBeLessThan(withSections.text.indexOf("articles-api · product"));
    expect(hidden.text).not.toContain("Conduit");
  });

  it("answers brain_get with system and brain_impact with work over the protocol", async () => {
    const { store } = await world();
    store.setSystem("Conduit", ["articles-api", "articles-web"]);
    const server = createServer({ store, access: new LocalAccessPolicy(), caller: LOCAL_CALLER });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(clientSide);

    const overview = await client.callTool({ name: "brain_get", arguments: { system: "Conduit" } });
    const work = await client.callTool({ name: "brain_impact", arguments: { work: "remove articles" } });
    const neither = await client.callTool({ name: "brain_get", arguments: {} });

    expect(JSON.stringify(overview.content)).toContain("Conduit (confirmed) · 2 repos");
    expect(JSON.stringify(work.content)).toContain('\\"remove articles\\" would most likely touch:');
    expect(neither.isError).toBe(true);
    expect(client.getInstructions()).toContain("For product questions");
  });
});

describe("brain_impact with work", () => {
  it("ranks repos by matching sections (product pages first) and routes, grouped by system, with callers", async () => {
    const { store, deps } = await world();
    store.setSystem("Conduit", ["articles-api", "articles-web"]);

    const result = await workImpact(deps, LOCAL_CALLER, { work: "let readers remove articles", format: "concise" });

    const lines = result.text.split("\n");
    expect(lines[0]).toBe('"let readers remove articles" would most likely touch:');
    expect(lines[2]).toBe("Conduit");
    expect(lines[3]).toMatch(/^ {2}articles-api {2}product › Product; product › Business rules; api › Articles; routes: (GET|DELETE) \/articles\/\{slug\}, (GET|DELETE) \/articles\/\{slug\}$/);
    expect(lines[4]).toBe("                + articles-web calls one of these routes, so it may need updating if the API changes");
    expect(result.text).not.toContain("orders-api");
    expect(result.text).toContain("Suggested from the wiki and route map; confirm with the owning team.");
  });

  it("ignores words nearly every description uses, such as \"let users\"", async () => {
    const { deps } = await world();

    const plain = await workImpact(deps, LOCAL_CALLER, { work: "remove articles", format: "concise" });
    const wordy = await workImpact(deps, LOCAL_CALLER, { work: "let users remove articles", format: "concise" });

    expect(wordy.ok && wordy.data.groups).toEqual(plain.ok && plain.data.groups);
  });

  it("puts repos in no system last, and labels suggested systems", async () => {
    const { store, deps } = await world();
    store.replaceSuggestedSystems([{ name: "Shop", summary: "", reason: "", repos: ["orders-api", "shop-web"] }]);

    const result = await workImpact(deps, LOCAL_CALLER, { work: "readers and shoppers orders articles", format: "concise" });

    expect(result.text).toContain("Shop (suggested system)\n  orders-api");
    expect(result.text.indexOf("Shop (suggested system)")).toBeLessThan(result.text.indexOf("Not in a system"));
    expect(result.text).toMatch(/Not in a system\n {2}articles-api/);
  });

  it("never names a repo the caller can't read, even as a caller", async () => {
    const { store } = await world();
    store.setSystem("Conduit", ["articles-api", "articles-web"]);

    const result = await workImpact({ store, access: only("articles-api") }, LOCAL_CALLER, { work: "remove articles", format: "concise" });

    expect(result.text).toContain("Conduit\n  articles-api");
    expect(result.text).not.toContain("articles-web");
  });

  it("says when nothing matches, and wants either work or a repo", async () => {
    const { deps } = await world();

    const nothing = await workImpact(deps, LOCAL_CALLER, { work: "quantum teleportation", format: "concise" });
    const both = await impactRequest(deps, LOCAL_CALLER, { work: "x", repo: "articles-api", format: "concise" });
    const neither = await impactRequest(deps, LOCAL_CALLER, { format: "concise" });

    expect(nothing.text).toBe('Nothing in the wikis or route map of 4 repos matches "quantum teleportation". Try the words the product uses.\nNo wiki yet, so only their routes were searched: shop-web (brain sync <repo> writes one).');
    expect(both.ok).toBe(false);
    expect(neither.text).toContain("Give a repo");
  });
});

describe("migration 10", () => {
  it("adds systems to a store made before them, searchable and removed with their repos", () => {
    const file = join(tempDir(), "brain.db");
    const old = new DatabaseSync(file);
    MIGRATIONS.slice(0, 9).forEach((m) => (typeof m === "string" ? old.exec(m) : m(old)));
    old.exec("PRAGMA user_version = 9; INSERT INTO repos (name, path, ref, enrolled_at) VALUES ('shop', '/x', 'main', 'now');");
    old.close();

    const store = new SqliteStore(file);
    store.setSystem("eShop", ["shop"], "Sells goods online.");
    store.renameSystem("eShop", "Storefront");

    expect(store.searchSystems('"goods"')).toEqual(["Storefront"]);
    expect(store.searchSystems('"eshop"')).toEqual([]);
    expect(store.searchSystems('"storefront"')).toEqual(["Storefront"]);
    store.removeRepo("shop");
    expect(store.systems()).toMatchObject([{ name: "Storefront", repos: [] }]);
    store.removeSystem("Storefront");
    expect(store.searchSystems('"goods"')).toEqual([]);
    store.close();
  });
});
