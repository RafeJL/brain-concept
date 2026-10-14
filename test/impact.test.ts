import { describe, expect, it } from "vitest";
import { enrolRepo } from "../src/ingest/registry.js";
import { syncRepo } from "../src/ingest/sync.js";
import { LOCAL_CALLER, LocalAccessPolicy, type AccessPolicy } from "../src/serve/access.js";
import { impact } from "../src/serve/tools/impact.js";
import { SqliteStore } from "../src/store/sqlite.js";
import { mapSeams, repoFromFixture } from "./helpers.js";

/** test/fixtures/repos/orders-api (C#) and shop-web (TS), which calls it. */
async function setup() {
  const store = new SqliteStore(":memory:");
  await enrolRepo(store, { path: repoFromFixture("orders-api"), name: "orders-api" });
  await enrolRepo(store, { path: repoFromFixture("shop-web"), name: "shop-web" });
  for (const name of ["orders-api", "shop-web"]) {
    await syncRepo(store, name);
    await mapSeams(store, name);
  }
  return { store, deps: { store, access: new LocalAccessPolicy() } };
}

describe("brain_impact", () => {
  it("lists a file's routes with their callers across repos, most-called first", async () => {
    const { deps } = await setup();

    const result = await impact(deps, LOCAL_CALLER, { repo: "orders-api", path: "src/OrdersController.cs", format: "concise" });

    expect(result.ok).toBe(true);
    expect(result.text).toContain("orders-api · src/OrdersController.cs · 2 routes, 2 callers in 2 repos · llm-generated");
    expect(result.text).toMatch(/GET \/api\/orders\/\{id\}\s+\(4-5\)\n {2}← orders-api · src\/AdminClient.cs:1 · same repo\n {2}← shop-web · src\/api.ts:1/);
    expect(result.text).toContain("No known callers: DELETE /api/orders/{id}");
    expect(result.text).toContain("1 call uses a URL only known at run time (shop-web · src/api.ts:2)");
  });

  it("merges an endpoint declared in code and in a spec into one entry, citing code first", async () => {
    const { deps } = await setup();

    const result = await impact(deps, LOCAL_CALLER, { repo: "orders-api", route: "GET /api/orders/{id}", format: "concise" });

    expect(result.text).toContain("orders-api · 1 route, 2 callers");
    expect(result.text).toContain("GET /api/orders/{id}  (src/OrdersController.cs:4-5)\n  also declared in docs/openapi.yaml:3-4");
  });

  it("filters to one endpoint", async () => {
    const { deps } = await setup();

    const result = await impact(deps, LOCAL_CALLER, { repo: "orders-api", route: "DELETE /api/orders/{id}", format: "detailed" });

    expect(result.text).toContain("1 route, 0 callers in 0 repos");
    expect(result.text).toContain("no known callers");
  });

  it("points a client file at brain_find_consumers instead", async () => {
    const { deps } = await setup();

    const result = await impact(deps, LOCAL_CALLER, { repo: "shop-web", path: "./src/api.ts", format: "concise" });

    expect(result.text).toBe(
      "No matching routes, events, gRPC methods or packages are mapped in shop-web · src/api.ts. It makes 2 HTTP calls; use brain_find_consumers on one to see who provides it.",
    );
  });

  it("hides unreadable repos, including their calls", async () => {
    const { store } = await setup();
    const onlyApi: AccessPolicy = { readableRepos: async () => new Set(["orders-api"]) };

    const hidden = await impact({ store, access: onlyApi }, LOCAL_CALLER, { repo: "shop-web", format: "concise" });
    const api = await impact({ store, access: onlyApi }, LOCAL_CALLER, { repo: "orders-api", format: "concise" });

    expect(hidden.text).toBe('No readable repo named "shop-web". Repos you can read: orders-api.');
    expect(api.text).not.toContain("shop-web");
  });
});
