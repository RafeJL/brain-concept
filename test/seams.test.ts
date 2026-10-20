import { describe, expect, it } from "vitest";
import { updateSeams, verifySeams, type FoundSeam } from "../src/ai/seams.js";
import { parseEndpoint } from "../src/core/http.js";
import { enrolRepo } from "../src/ingest/registry.js";
import { syncRepo } from "../src/ingest/sync.js";
import { LOCAL_CALLER, LocalAccessPolicy, type AccessPolicy } from "../src/serve/access.js";
import { findConsumers } from "../src/serve/tools/find-consumers.js";
import { impact } from "../src/serve/tools/impact.js";
import { repoCard } from "../src/serve/tools/repo-card.js";
import { SqliteStore } from "../src/store/sqlite.js";
import { commit, commitFixture, fixtureWorld, makeRepo, mapSeams, recordedRunner, recordedSeams, repoFromFixture } from "./helpers.js";

/** test/fixtures/repos/articles-api and articles-web, enrolled as "api" and "web", synced and mapped, once for the file. */
const twoRepos = fixtureWorld([
  ["api", "articles-api"],
  ["web", "articles-web"],
]);
const ordersAndShop = fixtureWorld(["orders-api", "shop-web"]);

/** The same two repos in their own folders, for a test that commits to them. */
async function ownRepos() {
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

/** Each kind of run's file headers: a whole file (from 1) or a part (from its first line). */
function filesIn(prompt: string): { file: string; from: number }[] {
  return [...prompt.matchAll(/===== FILE (.+?)(?: \(lines (\d+)-\d+\))? =====/g)].map((m) => ({ file: m[1]!, from: Number(m[2] ?? 1) }));
}

/**
 * A runner answering each kind of run as the brain asks it: the survey, screening (by `flag`,
 * everything unflagged unless given), and the HTTP and links mapping runs, which answer for every
 * file they were given unless `answerFiles` is false.
 */
function pipeline(options: {
  survey?: unknown;
  flag?: (file: string, from: number) => Partial<{ route: boolean; call: boolean; message: boolean }>;
  screenNothing?: boolean;
  http?: (prompt: string) => unknown[];
  links?: (prompt: string) => unknown[];
  answerFiles?: boolean;
}) {
  const { runner, requests } = recordedRunner(({ prompt: p }) => {
    if (p.startsWith("You are surveying")) return options.survey ?? { templates: [], inherited: [], config_files: [] };
    if (p.startsWith("You are screening"))
      return { files: options.screenNothing ? [] : filesIn(p).map(({ file, from }) => ({ file, from, route: false, call: false, message: false, ...(options.flag?.(file, from) ?? {}) })) };
    const seams = (p.includes("mapped separately") ? options.links : options.http)?.(p) ?? [];
    return { seams, files: options.answerFiles === false ? [] : filesIn(p).map(({ file, from }) => ({ file, from, outcome: "none" })) };
  });
  return { runner, requests, maps: () => requests.filter((r) => !/^You are (surveying|screening)/.test(r.prompt)) };
}

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
    const { store } = twoRepos();

    const routes = store.seams({ repos: ["api"] });

    expect(routes.map((s) => `${s.method} ${s.key} ${s.path}:${s.startLine}`)).toEqual([
      "GET /articles/{} src/articles.ts:3",
      "DELETE /articles/{} src/articles.ts:4",
    ]);
    expect(routes[0]?.commit).toBe(store.getState("api")?.commit);
    expect(store.getState("api")?.seamsCommit).toBe(store.getState("api")?.commit);
  });

  it("maps only changed files after a change, and drops the seams of deleted files", async () => {
    const { store, apiDir } = await ownRepos();

    commitFixture(apiDir, "articles-api-v2");
    await syncRepo(store, "api");
    const update = recordedRunner(recordedSeams("articles-api-v2"));
    const result = await updateSeams(store, update.runner, "api");
    const httpRun = update.requests.find((r) => r.prompt.includes("List every HTTP route"))!;

    expect(result).toMatchObject({ mode: "update", redone: ["src/articles.ts", "src/tags.ts"] });
    expect(httpRun.prompt).toContain("Only list entries declared in the files and parts given at the end");
    expect(httpRun.prompt).toContain("===== FILE src/tags.ts =====\n1| router.get(\"/tags\", list);");
    expect(store.seams({ repos: ["api"] }).map((s) => `${s.method} ${s.key}`)).toEqual(["PUT /articles/{}", "GET /tags"]);

    commit(apiDir, {}, "remove tags", ["src/tags.ts"]);
    await syncRepo(store, "api");
    const none = recordedRunner({ seams: [] });
    const after = await updateSeams(store, none.runner, "api");

    expect(none.requests).toHaveLength(0);
    expect(after.redone).toEqual([]);
    expect(store.seams({ repos: ["api"] }).map((s) => s.path)).toEqual(["src/articles.ts"]);
    expect(store.seamPieces("api").map((p) => p.path)).not.toContain("src/tags.ts");
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
    const httpRun = update.requests.find((r) => r.prompt.includes("List every HTTP route"))!;

    expect(httpRun.prompt).toContain("===== FILE Program.cs =====");
    expect(httpRun.prompt).toContain("===== FILE Tags.cs =====");
    expect(store.seams({ repos: ["api"] }).map((s) => s.key)).toEqual(["/v2/tags"]);
  });

  it("asks once more for what the check dropped, with the reasons, and keeps what then passes", async () => {
    const store = new SqliteStore(":memory:");
    const service = ['private readonly string baseUrl = "api/catalog/";', "", "", "", "", "", 'var items = await httpClient.GetAsync($"{baseUrl}items");'].join("\n");
    await enrolRepo(store, { path: makeRepo({ "CatalogService.cs": service }), name: "web" });
    await syncRepo(store, "web");
    const call = (...lines: number[]) => ({ kind: "call", method: "GET", path: "/api/catalog/items", runtime: false, cites: lines.map((l) => ({ file: "CatalogService.cs", start: l, end: l })) });
    const { runner, maps } = pipeline({ flag: () => ({ call: true }), http: (p) => (p.includes("dropped them") ? [call(7, 1)] : [call(7)]) });

    const result = await updateSeams(store, runner, "web");

    expect(maps().map((r) => r.prompt.includes("dropped them"))).toEqual([false, true]);
    expect(maps()[1]!.prompt).toContain('call GET /api/catalog/items (CatalogService.cs:7): "api" isn\'t in the cited lines');
    expect(result).toMatchObject({ retried: 1, dropped: [] });
    expect(store.seams({ repos: ["web"] }).map((s) => [s.key, s.startLine, s.cites])).toEqual([["/api/catalog/items", 7, [{ path: "CatalogService.cs", start: 1, end: 1 }]]]);
  });

  it("maps HTTP and other links in separate runs, and runs only the links run when only a manifest changed", async () => {
    const store = new SqliteStore(":memory:");
    const dir = makeRepo({ "Orders.cs": '[HttpGet("orders")]\nbus.Publish("OrderStarted");\n', "requirements.txt": "requests\n" });
    await enrolRepo(store, { path: dir, name: "orders" });
    await syncRepo(store, "orders");
    const event = { kind: "event-publish", name: "OrderStarted", runtime: false, cites: [{ file: "Orders.cs", start: 2, end: 2 }] };
    // Both runs give the same answer; each keeps only its own kinds, so nothing is stored twice.
    const full = pipeline({ flag: () => ({ route: true, message: true }), http: () => [route("GET", "/orders", ["Orders.cs", 1, 1]), event], links: () => [route("GET", "/orders", ["Orders.cs", 1, 1]), event] });

    await updateSeams(store, full.runner, "orders");

    expect(full.maps().map((r) => r.prompt.includes("HTTP routes and calls are mapped separately"))).toEqual([false, true]);
    // Manifests go to the links run unscreened: they can publish or depend on a package.
    expect(full.maps()[1]!.prompt).toContain("===== FILE requirements.txt =====");
    expect(full.maps()[0]!.prompt).not.toContain("requirements.txt");
    expect(store.seams({ repos: ["orders"] }).map((s) => `${s.kind} ${s.key}`)).toEqual(["http-route /orders", "event-publish orderstarted"]);

    commit(dir, { "requirements.txt": "requests\n@citation/ui\n" });
    await syncRepo(store, "orders");
    const update = pipeline({});
    await updateSeams(store, update.runner, "orders");

    // No survey (nothing it rests on changed), nothing to screen, and no HTTP run.
    expect(update.requests).toHaveLength(1);
    expect(update.requests[0]!.prompt).toContain("HTTP routes and calls are mapped separately");
  });

  it("maps only what screening flags, in pieces for long files, and records what became of each piece", async () => {
    const store = new SqliteStore(":memory:");
    const big = Array.from({ length: 700 }, (_, i) => (i === 649 ? '[HttpGet("reports")]' : `// line ${i + 1}`)).join("\n");
    const files = {
      "Orders.cs": '[HttpGet("orders")]\n',
      "Util.cs": "static class Util {}\n",
      "Bus.cs": 'bus.Publish("OrderStarted");\n',
      "Big.cs": big,
      "tests/OrdersTests.cs": 'await client.GetAsync("orders");\n',
    };
    await enrolRepo(store, { path: makeRepo(files), name: "shop" });
    await syncRepo(store, "shop");
    const flags: Record<string, object> = { "Orders.cs": { route: true }, "Bus.cs": { message: true }, "Big.cs:601": { route: true } };
    const { runner, maps, requests } = pipeline({
      flag: (file, from) => flags[from > 1 ? `${file}:${from}` : file] ?? {},
      http: () => [route("GET", "/orders", ["Orders.cs", 1, 1]), route("GET", "/reports", ["Big.cs", 650, 650])],
      links: () => [{ kind: "event-publish", name: "OrderStarted", runtime: false, cites: [{ file: "Bus.cs", start: 1, end: 1 }] }],
    });

    const result = await updateSeams(store, runner, "shop");
    const screening = requests.find((r) => r.prompt.startsWith("You are screening"))!;

    // Tests aren't screened or mapped; screening reads every other file, with no tools.
    expect(screening.prompt).not.toContain("tests/OrdersTests.cs");
    expect(screening.prompt).toContain("===== FILE Big.cs (lines 601-700) =====");
    expect(screening.explore).toBe(false);
    expect(maps()[0]!.prompt).not.toContain("Util.cs");
    expect(maps()[0]!.prompt).toContain("650| [HttpGet(\"reports\")]");
    expect(result.screened).toEqual({ pieces: 5, http: 2, links: 1 });
    expect(store.seamPieces("shop").map((p) => `${p.path}:${p.start} ${p.http} ${p.links}`)).toEqual([
      "Big.cs:1 unflagged unflagged",
      "Big.cs:601 mapped unflagged",
      "Bus.cs:1 unflagged mapped",
      "Orders.cs:1 mapped unflagged",
      "Util.cs:1 unflagged unflagged",
    ]);
  });

  it("asks again for a piece no run answered for, then records it as not mapped; a piece screening didn't answer is mapped", async () => {
    const store = new SqliteStore(":memory:");
    await enrolRepo(store, { path: makeRepo({ "Orders.cs": '[HttpGet("orders")]\n' }), name: "shop" });
    await syncRepo(store, "shop");
    // Screening answers nothing, so the piece counts as flagged; the mapping runs answer for no file.
    const { runner, maps } = pipeline({ screenNothing: true, answerFiles: false });

    const result = await updateSeams(store, runner, "shop");

    expect(maps().filter((r) => r.prompt.includes("List every HTTP route"))).toHaveLength(2);
    expect(result.unmapped).toEqual([{ path: "Orders.cs", start: 1, end: 1 }]);
    expect(store.seamPieces("shop")).toEqual([{ path: "Orders.cs", start: 1, end: 1, http: "unmapped", links: "unmapped" }]);
  });

  it("works out the routes derived classes get from a base class, from the survey, and checks them", async () => {
    const store = new SqliteStore(":memory:");
    const files = {
      "WebApiConfig.cs": 'config.Routes.MapHttpRoute("DefaultApi", "api/{controller}/{id}");\n',
      "EntityApiController.cs": ["public abstract class EntityApiController<T> : ApiController {", "  public IHttpActionResult Get() => Ok();", "  [HttpPost] public IHttpActionResult Post(T item) => Ok();", "}", ""].join("\n"),
      "EmployeeController.cs": "public class EmployeeController : EntityApiController<Employee> { }\n",
      "AuditedController.cs": "public abstract class AuditedController<T> : EntityApiController<T> { }\n",
      "NoteController.cs": "public class NoteController : AuditedController<Note> { }\n",
      "Helper.cs": "public class Helper : EntityApiController<Thing> { }\n",
    };
    await enrolRepo(store, { path: makeRepo(files), name: "atlas" });
    await syncRepo(store, "atlas");
    const cite = (file: string, line: number) => ({ file, start: line, end: line });
    const survey = {
      templates: [{ template: "api/{controller}/{id}", cites: [cite("WebApiConfig.cs", 1)] }, { template: "v9/{controller}", cites: [cite("WebApiConfig.cs", 1)] }],
      inherited: [
        {
          base: "EntityApiController<T>",
          suffix: "Controller",
          cites: [cite("EntityApiController.cs", 1)],
          routes: [
            { method: "GET", path: "api/{controller}", cites: [cite("EntityApiController.cs", 2), cite("WebApiConfig.cs", 1)] },
            { method: "POST", path: "api/{controller}", cites: [cite("EntityApiController.cs", 3), cite("WebApiConfig.cs", 1)] },
            // Not supported by its lines: "v9" appears nowhere.
            { method: "GET", path: "v9/{controller}", cites: [cite("EntityApiController.cs", 2)] },
          ],
        },
      ],
      config_files: ["Web.config"],
    };
    const { runner, maps } = pipeline({ survey, flag: () => ({}) });

    const result = await updateSeams(store, runner, "atlas");

    // A grandchild counts; an abstract class and a class without the suffix serve nothing.
    expect(store.seams({ repos: ["atlas"] }).map((s) => `${s.method} ${s.rawPath} ${s.path} ${s.derived ? "derived" : ""}`)).toEqual([
      "GET /api/Employee EmployeeController.cs derived",
      "POST /api/Employee EmployeeController.cs derived",
      "GET /api/Note NoteController.cs derived",
      "POST /api/Note NoteController.cs derived",
    ]);
    expect(result.derived).toBe(4);
    // Following one points at the base method that handles it, rather than tracing each copy.
    const followed = await findConsumers({ store, access: new LocalAccessPolicy() }, LOCAL_CALLER, { target: "GET /api/Employee", format: "concise", follow: true });
    expect(followed.text).toContain("inherited from a base class, so its handling is the base method at EntityApiController.cs:2");
    expect(store.linkSurvey("atlas")).toMatchObject({ templates: [{ template: "api/{controller}/{id}" }], inherited: [{ base: "EntityApiController", routes: [{}, {}] }], configFiles: [] });
    expect(maps()).toHaveLength(0);
  });

  it("tells mapping runs the survey's templates, base classes and settings files", async () => {
    const store = new SqliteStore(":memory:");
    const files = { "WebApiConfig.cs": 'routes.MapHttpRoute("api/{controller}/{action}");\n', "appsettings.json": '{ "OrdersUrl": "https://orders" }\n', "Client.cs": "await http.GetAsync(config[\"OrdersUrl\"]);\n" };
    await enrolRepo(store, { path: makeRepo(files), name: "web" });
    await syncRepo(store, "web");
    const survey = { templates: [{ template: "api/{controller}/{action}", cites: [{ file: "WebApiConfig.cs", start: 1, end: 1 }] }], inherited: [], config_files: ["appsettings.json"] };
    const { runner, maps } = pipeline({ survey, flag: () => ({ call: true }) });

    await updateSeams(store, runner, "web");

    expect(maps()[0]!.prompt).toContain("- api/{controller}/{action} (WebApiConfig.cs:1)");
    expect(maps()[0]!.prompt).toContain("live in: appsettings.json. When a URL or name comes from a setting");
  });

  it("runs no AI when only Markdown changed", async () => {
    const { store, apiDir } = await ownRepos();
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
    const { store, deps } = twoRepos();
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
    const { deps } = twoRepos();

    const result = await findConsumers(deps, LOCAL_CALLER, { target: "GET /articles/{slug}", format: "concise" });

    expect(result.ok).toBe(true);
    expect(result.text).toContain("GET /articles/{} · 1 server, 1 caller in 2 repos · llm-generated");
    expect(result.text).toContain("api · src/articles.ts:3 · GET /articles/{slug}");
    expect(result.text).toContain("web · src/agent.js:2 · GET /articles/{slug}");
    expect(result.text).toContain("1 call uses a URL only known at run time (web · src/agent.js:3)");
  });

  it("matches across a base path and filters by method", async () => {
    const { deps } = twoRepos();

    const withBase = await findConsumers(deps, LOCAL_CALLER, { target: "/api/articles/:slug", format: "concise" });
    const deletes = await findConsumers(deps, LOCAL_CALLER, { target: "DELETE /articles/:slug", format: "concise" });

    expect(withBase.text).toContain("2 servers, 1 caller");
    expect(withBase.text).toContain("suffix = matched ignoring a base path");
    expect(deletes.text).toContain("1 server, 0 callers in 1 repo");
  });

  it("never returns seams from repos the caller cannot read", async () => {
    const { store } = twoRepos();
    const onlyWeb: AccessPolicy = { readableRepos: async () => new Set(["web"]) };

    const result = await findConsumers({ store, access: onlyWeb }, LOCAL_CALLER, { target: "GET /articles/:slug", format: "concise" });

    expect(result.text).not.toContain("api ·");
    expect(result.text).toContain("0 servers, 1 caller in 1 repo");
  });

  it("points first at run-time URLs in the repos the answer involves", async () => {
    const { store, deps } = twoRepos();
    await enrolRepo(store, { path: repoFromFixture("shop-web"), name: "shop" });
    await syncRepo(store, "shop");
    await mapSeams(store, "shop", "shop-web");

    const result = await findConsumers(deps, LOCAL_CALLER, { target: "GET /articles/{slug}", format: "concise" });

    expect(result.text).toContain("2 calls use URLs only known at run time (web · src/agent.js:3, shop · src/api.ts:2)");
  });

  it("lists a repo calling its own endpoint after other callers, marked same repo", async () => {
    const { deps } = ordersAndShop();

    const result = await findConsumers(deps, LOCAL_CALLER, { target: "GET /api/orders/{id}", format: "concise" });

    expect(result.text).toContain("Called by\n  shop-web · src/api.ts:1 · GET /api/orders/{id}\n  orders-api · src/AdminClient.cs:1 · GET /api/orders/{id} · same repo");
  });

  it("says when nothing matched, and why that isn't proof", async () => {
    const { deps } = twoRepos();

    const result = await findConsumers(deps, LOCAL_CALLER, { target: "GET /nothing/here", format: "concise" });

    expect(result.text).toContain("No servers or callers found for GET /nothing/here.");
    expect(result.text).toContain("isn't proof");
  });
});

describe("answers that say what a map didn't cover", () => {
  it("say where no run answered for a piece, instead of calling it none", async () => {
    const store = new SqliteStore(":memory:");
    await enrolRepo(store, { path: makeRepo({ "Orders.cs": '[HttpGet("orders")]\n' }), name: "shop" });
    await syncRepo(store, "shop");
    await updateSeams(store, pipeline({ flag: () => ({ route: true }), answerFiles: false }).runner, "shop");
    const deps = { store, access: new LocalAccessPolicy() };

    const empty = await impact(deps, LOCAL_CALLER, { repo: "shop", format: "concise" });
    const card = await repoCard(deps, LOCAL_CALLER, "shop", "concise");
    const nobody = await findConsumers(deps, LOCAL_CALLER, { target: "GET /orders", format: "concise" });

    expect(empty.text).toContain("No matching routes, events, gRPC methods or packages are mapped in shop.");
    expect(empty.text).toContain("Parts of the link map are unknown in shop (1 not mapped: Orders.cs:1): no run answered for them, so a missing route or caller there isn't proof there is none.");
    expect(card.text).toContain("Link map: partial. 1 files screened; 1 flagged pieces not mapped (Orders.cs:1)");
    expect(nobody.text).toContain("Parts of the link map are unknown in shop");
  });

  it("say when a map was made before coverage was recorded, and say nothing when it is complete", async () => {
    const { store, deps } = twoRepos();
    const at = store.getState("api")!.commit;
    // An older map: seams stored with no survey or pieces.
    store.replaceSeams("api", { commit: at, paths: null, seams: [] });
    const db = (store as unknown as { db: { prepare(sql: string): { run(...a: unknown[]): void } } }).db;
    db.prepare("UPDATE repo_state SET link_survey = NULL WHERE repo = ?").run("api");

    const older = await impact(deps, LOCAL_CALLER, { repo: "api", format: "concise" });
    const complete = await impact(deps, LOCAL_CALLER, { repo: "web", format: "concise" });
    const card = await repoCard(deps, LOCAL_CALLER, "api", "detailed");

    expect(older.text).toContain("api's link map was made before the brain recorded what it covered");
    expect(complete.text).not.toContain("link map was made before");
    expect(complete.text).not.toContain("unknown in");
    expect(card.text).toContain("Link map: coverage not recorded");
  });
});
