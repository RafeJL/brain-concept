import { describe, expect, it } from "vitest";
import { updateSeams, verifySeams, type FoundSeam } from "../src/ai/seams.js";
import { parseEndpoint } from "../src/core/http.js";
import { enrolRepo } from "../src/ingest/registry.js";
import { syncRepo } from "../src/ingest/sync.js";
import { LOCAL_CALLER, LocalAccessPolicy, type AccessPolicy } from "../src/serve/access.js";
import { findConsumers } from "../src/serve/tools/find-consumers.js";
import { repoCard } from "../src/serve/tools/repo-card.js";
import { SqliteStore } from "../src/store/sqlite.js";
import { commit, commitFixture, makeRepo, mapSeams, recordedRunner, recordedSeams, repoFromFixture } from "./helpers.js";

/** test/fixtures/repos/articles-api and articles-web, enrolled as "api" and "web", synced and mapped. */
async function twoRepos() {
  const store = new SqliteStore(":memory:");
  const apiDir = repoFromFixture("articles-api");
  const webDir = repoFromFixture("articles-web");
  await enrolRepo(store, { path: apiDir, name: "api" });
  await enrolRepo(store, { path: webDir, name: "web" });
  for (const [name, fixture] of [["api", "articles-api"], ["web", "articles-web"]] as const) {
    await syncRepo(store, name);
    await mapSeams(store, name, fixture);
  }
  return { store, apiDir, webDir, deps: { store, access: new LocalAccessPolicy() } };
}

const route = (method: string, path: string, ...cites: [string, number, number][]): FoundSeam => ({
  kind: "route",
  method,
  path,
  runtime: false,
  cites: cites.map(([file, start, end]) => ({ file, start, end })),
});

describe("verifying the AI's routes and calls", () => {
  const files = {
    "Program.cs": 'app.UsePathBase("/api");\n',
    "TagsController.cs": ['[Route("tags")]', "public class TagsController {", "  [HttpGet] public IActionResult List() => Ok();", "  [HttpPost] public IActionResult Add() => Ok();", "}", ""].join("\n"),
    "notes.txt": Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n"),
    "agent.js": "export const remove = (slug) => requests.del(`/articles/${slug}`);\n",
  };
  const verify = (...found: unknown[]) => verifySeams(found, makeRepo(files), "api", "abc");

  it("keeps a route whose path is assembled from several files, and records where each part came from", () => {
    const { kept, dropped } = verify(route("GET", "/api/tags", ["TagsController.cs", 3, 3], ["TagsController.cs", 1, 1], ["Program.cs", 1, 1]));

    expect(dropped).toEqual([]);
    expect(kept).toEqual([
      {
        repo: "api",
        path: "TagsController.cs",
        kind: "http-route",
        method: "GET",
        rawPath: "/api/tags",
        key: "/api/tags",
        startLine: 3,
        endLine: 3,
        cites: [
          { path: "TagsController.cs", start: 1, end: 1 },
          { path: "Program.cs", start: 1, end: 1 },
        ],
        commit: "abc",
      },
    ]);
  });

  it("drops a seam the cited lines don't support, and says why", () => {
    const { kept, dropped } = verify(
      route("GET", "/api/tags", ["TagsController.cs", 3, 3], ["TagsController.cs", 1, 1]),
      route("DELETE", "/tags", ["TagsController.cs", 3, 4], ["TagsController.cs", 1, 1]),
      route("GET", "/tags", ["Missing.cs", 1, 1]),
      route("GET", "/tags", ["TagsController.cs", 9, 9]),
      route("GET", "/line", ["notes.txt", 1, 100]),
      { ...route("GET", "/x", ["TagsController.cs", 3, 3]), runtime: true },
      { kind: "route", method: "FETCH", path: "/tags", runtime: false, cites: [{ file: "TagsController.cs", start: 3, end: 3 }] },
      { kind: "route" },
    );

    expect(kept).toEqual([]);
    expect(dropped.map((d) => d.reason)).toEqual([
      '"api" isn\'t in the cited lines',
      "DELETE isn't in the cited lines",
      "cites Missing.cs, which doesn't exist at this commit",
      "cites TagsController.cs:9-9, outside the file (6 lines)",
      "cites 100 lines of notes.txt; too broad to support one claim",
      "a route's path must be known",
      'unknown method "FETCH"',
      "malformed entry",
    ]);
    expect(dropped[0]!.seam).toBe("route GET /api/tags (TagsController.cs:3)");
  });

  it("keeps a run-time call with only its call site, an implicit GET, and DELETE spelled del()", () => {
    const { kept } = verify(
      { kind: "call", method: "GET", path: "baseUrl + path", runtime: true, cites: [{ file: "Program.cs", start: 1, end: 1 }] },
      route("POST", "/tags", ["TagsController.cs", 4, 4], ["TagsController.cs", 1, 1]),
      { kind: "call", method: "DELETE", path: "/articles/{slug}", runtime: false, cites: [{ file: "agent.js", start: 1, end: 1 }] },
    );

    expect(kept.map((s) => [s.kind, s.method, s.key, s.rawPath])).toEqual([
      ["http-call", "GET", null, "baseUrl + path"],
      ["http-route", "POST", "/tags", "/tags"],
      ["http-call", "DELETE", "/articles/{}", "/articles/{slug}"],
    ]);
  });
});

describe("where a call is", () => {
  it("is the line its path is written on, not a shared wrapper or base URL the AI cited first", () => {
    const dir = makeRepo({
      "client.js": ['const API_ROOT = "https://x.example/api";', "const get = (url) => superagent.get(`${API_ROOT}${url}`);", "export const profile = (u) => get(`/profiles/${u}`);"].join("\n"),
    });
    const call = { kind: "call", method: "GET", path: "/api/profiles/{u}", runtime: false, cites: [2, 3, 1].map((line) => ({ file: "client.js", start: line, end: line })) };

    const [seam] = verifySeams([call], dir, "web", "abc").kept;

    expect([seam!.path, seam!.startLine]).toEqual(["client.js", 3]);
    expect(seam!.cites.map((c) => c.start)).toEqual([2, 1]);
  });

  it("stays in the calling file when the path is only spelled out in the route it names", () => {
    const dir = makeRepo({
      "views.py": "@blueprint.route('/api/profiles/<username>', methods=('GET',))\n",
      "test_profile.py": "resp = testapp.get(url_for('profile.get_profile', username='foo'))\n",
    });
    const call = {
      kind: "call",
      method: "GET",
      path: "/api/profiles/{username}",
      runtime: false,
      cites: [{ file: "test_profile.py", start: 1, end: 1 }, { file: "views.py", start: 1, end: 1 }],
    };

    const [seam] = verifySeams([call], dir, "api", "abc").kept;

    expect([seam!.path, seam!.startLine]).toEqual(["test_profile.py", 1]);
    expect(seam!.cites).toEqual([{ path: "views.py", start: 1, end: 1 }]);
  });
});

describe("mapping and updating a repo's routes and calls", () => {
  it("stores what passes, tagged with repo, file, lines and commit", async () => {
    const { store } = await twoRepos();

    const routes = store.seams({ repos: ["api"] });

    expect(routes.map((s) => `${s.method} ${s.key} ${s.path}:${s.startLine}`)).toEqual([
      "GET /articles/{} src/articles.ts:3",
      "DELETE /articles/{} src/articles.ts:4",
    ]);
    expect(routes[0]?.commit).toBe(store.getState("api")?.commit);
    expect(store.getState("api")?.seamsCommit).toBe(store.getState("api")?.commit);
  });

  it("maps only changed files after a change, and drops the seams of deleted files", async () => {
    const { store, apiDir } = await twoRepos();

    commitFixture(apiDir, "articles-api-v2");
    await syncRepo(store, "api");
    const update = recordedRunner(recordedSeams("articles-api-v2"));
    const result = await updateSeams(store, update.runner, "api");

    expect(result).toMatchObject({ mode: "update", redone: ["src/articles.ts", "src/tags.ts"] });
    expect(update.requests[0]!.prompt).toContain("Only list entries declared in these files");
    expect(update.requests[0]!.prompt).toContain("- src/tags.ts");
    expect(store.seams({ repos: ["api"] }).map((s) => `${s.method} ${s.key}`)).toEqual(["PUT /articles/{}", "GET /tags"]);

    commit(apiDir, {}, "remove tags", ["src/tags.ts"]);
    await syncRepo(store, "api");
    const none = recordedRunner({ seams: [] });
    const after = await updateSeams(store, none.runner, "api");

    expect(none.requests).toHaveLength(0);
    expect(after.redone).toEqual([]);
    expect(store.seams({ repos: ["api"] }).map((s) => s.path)).toEqual(["src/articles.ts"]);
  });

  it("maps a file again when a file its seams were built from changes", async () => {
    const store = new SqliteStore(":memory:");
    const dir = makeRepo({ "Program.cs": 'app.UsePathBase("/api");\n', "Tags.cs": '[HttpGet("tags")]\n' });
    await enrolRepo(store, { path: dir, name: "api" });
    await syncRepo(store, "api");
    await updateSeams(store, recordedRunner({ seams: [route("GET", "/api/tags", ["Tags.cs", 1, 1], ["Program.cs", 1, 1])] }).runner, "api");

    commit(dir, { "Program.cs": 'app.UsePathBase("/v2");\n' });
    await syncRepo(store, "api");
    const update = recordedRunner({ seams: [route("GET", "/v2/tags", ["Tags.cs", 1, 1], ["Program.cs", 1, 1])] });
    await updateSeams(store, update.runner, "api");

    expect(update.requests[0]!.prompt).toContain("- Program.cs\n- Tags.cs");
    expect(store.seams({ repos: ["api"] }).map((s) => s.key)).toEqual(["/v2/tags"]);
  });

  it("asks once more for what the check dropped, with the reasons, and keeps what then passes", async () => {
    const store = new SqliteStore(":memory:");
    const service = ['private readonly string baseUrl = "api/catalog/";', "", "", "", "", "", 'var items = await httpClient.GetAsync($"{baseUrl}items");'].join("\n");
    await enrolRepo(store, { path: makeRepo({ "CatalogService.cs": service }), name: "web" });
    await syncRepo(store, "web");
    const call = (...lines: number[]) => ({ kind: "call", method: "GET", path: "/api/catalog/items", runtime: false, cites: lines.map((l) => ({ file: "CatalogService.cs", start: l, end: l })) });
    // The HTTP run and its retry; the run for other links, alongside, finds none.
    const prompts: string[] = [];
    const runner = {
      async run<T>(request: { prompt: string }) {
        prompts.push(request.prompt);
        const answer = request.prompt.includes("mapped separately") ? [] : request.prompt.includes("An earlier pass") ? [call(7, 1)] : [call(7)];
        return { output: { seams: answer } as T, costUsd: 0.05, durationMs: 1000, model: "claude-sonnet-5" };
      },
    };

    const result = await updateSeams(store, runner as never, "web");

    expect(prompts).toHaveLength(3);
    expect(prompts.find((p) => p.includes("An earlier pass"))).toContain('call GET /api/catalog/items (CatalogService.cs:7): "api" isn\'t in the cited lines');
    expect(result).toMatchObject({ retried: 1, dropped: [] });
    expect(result.costUsd).toBeCloseTo(0.15);
    expect(store.seams({ repos: ["web"] }).map((s) => [s.key, s.startLine, s.cites])).toEqual([["/api/catalog/items", 7, [{ path: "CatalogService.cs", start: 1, end: 1 }]]]);
  });

  it("maps HTTP and other links in separate runs, and skips the HTTP run when only a manifest changed", async () => {
    const store = new SqliteStore(":memory:");
    const dir = makeRepo({ "Orders.cs": '[HttpGet("orders")]\nbus.Publish("OrderStarted");\n', "requirements.txt": "requests\n" });
    await enrolRepo(store, { path: dir, name: "orders" });
    await syncRepo(store, "orders");
    const event = { kind: "event-publish", name: "OrderStarted", runtime: false, cites: [{ file: "Orders.cs", start: 2, end: 2 }] };
    // Both runs give the same answer; each keeps only its own kinds, so nothing is stored twice.
    const full = recordedRunner({ seams: [route("GET", "/orders", ["Orders.cs", 1, 1]), event] });

    await updateSeams(store, full.runner, "orders");

    expect(full.requests.map((r) => r.prompt.includes("HTTP routes and calls are mapped separately"))).toEqual([false, true]);
    expect(store.seams({ repos: ["orders"] }).map((s) => `${s.kind} ${s.key}`)).toEqual(["http-route /orders", "event-publish orderstarted"]);

    commit(dir, { "requirements.txt": "requests\n@citation/ui\n" });
    await syncRepo(store, "orders");
    const update = recordedRunner({ seams: [] });
    await updateSeams(store, update.runner, "orders");

    expect(update.requests).toHaveLength(1);
    expect(update.requests[0]!.prompt).toContain("HTTP routes and calls are mapped separately");
  });

  it("runs no AI when only Markdown changed", async () => {
    const { store, apiDir } = await twoRepos();
    commit(apiDir, { "README.md": "# changed" });
    await syncRepo(store, "api");
    const { runner, requests } = recordedRunner({ seams: [] });

    const result = await updateSeams(store, runner, "api");

    expect(requests).toHaveLength(0);
    expect(result).toMatchObject({ mode: "update", redone: [], costUsd: 0 });
    expect(store.seams({ repos: ["api"] })).toHaveLength(2);
    expect(store.getState("api")?.seamsCommit).toBe(store.getState("api")?.commit);
  });

  it("shows coverage on the repo card, or that the repo hasn't been mapped", async () => {
    const { store, deps } = await twoRepos();
    await enrolRepo(store, { path: makeRepo({ "a.ts": "1" }), name: "new" });
    await syncRepo(store, "new");

    const card = await repoCard(deps, LOCAL_CALLER, "web", "concise");
    const unmapped = await repoCard(deps, LOCAL_CALLER, "new", "concise");

    expect(card.text).toContain("Seams: 0 routes, 1 call (+1 with run-time URLs) · llm-generated");
    expect(unmapped.text).toContain("Seams: not mapped yet (brain sync new)");
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
    expect(result.text).toContain("GET /articles/{} · 1 server, 1 caller in 2 repos · llm-generated");
    expect(result.text).toContain("api · src/articles.ts:3 · GET /articles/{slug}");
    expect(result.text).toContain("web · src/agent.js:2 · GET /articles/{slug}");
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
    await mapSeams(store, "shop", "shop-web");

    const result = await findConsumers(deps, LOCAL_CALLER, { target: "GET /articles/{slug}", format: "concise" });

    expect(result.text).toContain("2 calls use URLs only known at run time (web · src/agent.js:3, shop · src/api.ts:2)");
  });

  it("lists a repo calling its own endpoint after other callers, marked same repo", async () => {
    const store = new SqliteStore(":memory:");
    for (const name of ["orders-api", "shop-web"]) {
      await enrolRepo(store, { path: repoFromFixture(name), name });
      await syncRepo(store, name);
      await mapSeams(store, name);
    }

    const result = await findConsumers({ store, access: new LocalAccessPolicy() }, LOCAL_CALLER, { target: "GET /api/orders/{id}", format: "concise" });

    expect(result.text).toContain("Called by\n  shop-web · src/api.ts:1 · GET /api/orders/{id}\n  orders-api · tests/OrdersTests.cs:1 · GET /api/orders/{id} · same repo");
  });

  it("says when nothing matched, and why that isn't proof", async () => {
    const { deps } = await twoRepos();

    const result = await findConsumers(deps, LOCAL_CALLER, { target: "GET /nothing/here", format: "concise" });

    expect(result.text).toContain("No servers or callers found for GET /nothing/here.");
    expect(result.text).toContain("isn't proof");
  });
});
