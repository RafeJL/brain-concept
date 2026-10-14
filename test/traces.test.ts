import { describe, expect, it } from "vitest";
import { chainProblem, updateTraces } from "../src/ai/traces.js";
import type { RunRequest, RunResult, Runner } from "../src/ai/runner.js";
import { normalisePath } from "../src/core/http.js";
import { normaliseName } from "../src/core/links.js";
import type { Seam, SeamKind } from "../src/core/seams.js";
import { enrolRepo } from "../src/ingest/registry.js";
import { syncRepo } from "../src/ingest/sync.js";
import { LOCAL_CALLER, LocalAccessPolicy, type AccessPolicy } from "../src/serve/access.js";
import { findConsumers } from "../src/serve/tools/find-consumers.js";
import { tableKey } from "../src/serve/trace.js";
import { SqliteStore } from "../src/store/sqlite.js";
import { commit, makeRepo } from "./helpers.js";

const ROUTES = [
  "router.post('/api/orders', placeOrder);",
  "export async function placeOrder(req) {",
  "  await saveOrder(req.body);",
  "  bus.publish('OrderStarted', req.body);",
  "}",
  "",
].join("\n");
const DB = "export async function saveOrder(order) {\n  await db.insert('orders', order);\n}\n";
const JOB = "export class GraceJob {\n  tick() { const rows = db.select('orders'); bus.publish('GraceConfirmed', rows); }\n}\n";
const HANDLER = "subscribe('OrderStarted', clearBasket);\nfunction clearBasket(e) { return cache.delete(e.user); }\n";
const APP = "import { createOrder } from './api';\nexport function CheckoutPage() {\n  return button(() => createOrder(basket));\n}\n";
const API = "export function createOrder(basket) {\n  return post('/api/orders', basket);\n}\n";

function seam(repo: string, kind: SeamKind, name: string, path: string, line: number, commitSha: string): Seam {
  const http = kind.startsWith("http-");
  const [method, raw] = http ? name.split(" ") : [kind.split("-")[0]!, name];
  const key = http ? normalisePath(raw!) : normaliseName(kind.startsWith("event") ? "event" : "grpc", raw!);
  return { repo, path, kind, method: method!, rawPath: raw!, key, startLine: line, endLine: line, cites: [], commit: commitSha };
}

/** A web app calling an orders API that saves, publishes, and is read by a job; a basket handling the event. */
async function shop() {
  const store = new SqliteStore(":memory:");
  const dirs: Record<string, string> = {};
  const files: Record<string, Record<string, string>> = {
    web: { "src/app.js": APP, "src/api.js": API },
    orders: { "src/routes.ts": ROUTES, "src/db.ts": DB, "src/job.ts": JOB },
    basket: { "src/handler.ts": HANDLER },
  };
  for (const [name, f] of Object.entries(files)) {
    dirs[name] = makeRepo(f);
    await enrolRepo(store, { path: dirs[name], name });
    await syncRepo(store, name);
  }
  const at = (r: string) => store.getState(r)!.commit;
  store.replaceSeams("web", { commit: at("web"), paths: null, seams: [seam("web", "http-call", "POST /api/orders", "src/api.js", 2, at("web"))] });
  store.replaceSeams("orders", {
    commit: at("orders"),
    paths: null,
    seams: [
      seam("orders", "http-route", "POST /api/orders", "src/routes.ts", 1, at("orders")),
      seam("orders", "event-publish", "OrderStarted", "src/routes.ts", 4, at("orders")),
      seam("orders", "event-publish", "GraceConfirmed", "src/job.ts", 2, at("orders")),
    ],
  });
  store.replaceSeams("basket", { commit: at("basket"), paths: null, seams: [seam("basket", "event-subscribe", "OrderStarted", "src/handler.ts", 1, at("basket"))] });
  return { store, dirs, deps: { store, access: new LocalAccessPolicy() } };
}

const step = (file: string, start: number, end = start, calls?: string) => ({ file, start, end, ...(calls ? { calls } : {}) });

/** What Claude Code would answer for each repo, told apart by the files its prompt names. */
function answersFor(prompt: string): unknown[] {
  const exit = (ref: string) => new RegExp(`- (X\\d+): [^\\n]*${ref}`).exec(prompt)?.[1];
  if (prompt.includes("src/routes.ts:1")) {
    return [
      {
        entry: "E1",
        leads: [{ exit: exit("OrderStarted"), steps: [step("src/routes.ts", 2, 4)] }],
        tables: [{ name: "orders", access: "write", steps: [step("src/routes.ts", 3, 3, "saveOrder"), step("src/db.ts", 1, 2)] }],
      },
      { found: { kind: "job", name: "GraceJob", file: "src/job.ts", line: 1 }, leads: [{ exit: exit("GraceConfirmed"), steps: [step("src/job.ts", 1, 2)] }], tables: [{ name: "orders", access: "read", steps: [step("src/job.ts", 2)] }] },
    ];
  }
  if (prompt.includes("src/handler.ts:1")) return [{ entry: "E1", ends: true, steps: [step("src/handler.ts", 1, 2)] }];
  if (prompt.includes("src/api.js:2")) {
    return [{ found: { kind: "ui", name: "CheckoutPage", file: "src/app.js", line: 2 }, leads: [{ exit: exit("POST /api/orders"), steps: [step("src/app.js", 3, 3, "createOrder"), step("src/api.js", 1, 2)] }] }];
  }
  return [];
}

function traceRunner(answer: (prompt: string) => unknown[] = answersFor) {
  const requests: RunRequest[] = [];
  const runner: Runner = {
    async run<T>(request: RunRequest): Promise<RunResult<T>> {
      requests.push(request);
      return { output: { traces: answer(request.prompt) } as T, costUsd: 0.1, durationMs: 1, model: "m" };
    },
  };
  return { runner, requests };
}

async function traced() {
  const env = await shop();
  for (const repo of ["web", "orders", "basket"]) await updateTraces(env.store, traceRunner().runner, repo);
  return env;
}

describe("a chain from an entry point", () => {
  const lines: Record<string, string[]> = { "a.ts": ["handle(req) {", "  save(req);", "}"], "b.ts": ["function save(x) {", "  db.insert('orders', x);", "  publish('Saved');", "}"] };
  const linesOf = (path: string) => lines[path] ?? null;
  const exit = { exits: [{ path: "b.ts", startLine: 3, endLine: 3 } as Seam] };
  const A = { path: "a.ts", line: 1 };
  const s = (path: string, start: number, end: number, calls?: string) => ({ path, start, end, ...(calls ? { calls } : {}) });

  it("holds when it starts in the entry point's file, each step names what links it to the next, and it ends on the exit's line", () => {
    expect(chainProblem([s("a.ts", 1, 2, "save"), s("b.ts", 1, 3)], A, exit, linesOf)).toBeNull();
    expect(chainProblem([s("a.ts", 1, 2, "this.save"), s("b.ts", 1, 2)], A, { table: "dbo.orders" }, linesOf)).toBeNull();
  });

  it("may start in a handler file the entry point's declaration names, as in a routes file", () => {
    const routes: Record<string, string[]> = { "routes/api.php": ["Route::post('users/login', 'AuthController@login');"], "app/AuthController.php": ["function login() {", "  return User::where('email');", "}"] };
    const of = (path: string) => routes[path] ?? null;
    const start = { path: "routes/api.php", line: 1 };
    expect(chainProblem([s("app/AuthController.php", 1, 2)], start, { table: "User" }, of)).toBeNull();
    // An ORM table named through its model: users through User.
    expect(chainProblem([s("app/AuthController.php", 1, 2)], start, { table: "users" }, of)).toBeNull();
    expect(chainProblem([s("app/AuthController.php", 1, 2)], start, { table: "posts" }, of)).toBe("`posts` isn't in the last step's lines");
    expect(chainProblem([s("app/AuthController.php", 1, 2)], { ...start, path: "a.ts" }, { table: "User" }, (p) => routes[p] ?? linesOf(p))).toBe("starts in app/AuthController.php, which the entry point's declaration (a.ts:1) doesn't name");
  });

  it("fails when it starts elsewhere, a linking name is missing from either step, it ends off the exit's line, or a line doesn't exist", () => {
    expect(chainProblem([s("b.ts", 1, 3)], A, exit, linesOf)).toBe("starts in b.ts, which the entry point's declaration (a.ts:1) doesn't name");
    expect(chainProblem([s("a.ts", 1, 2), s("b.ts", 1, 3)], A, exit, linesOf)).toBe("step 1 doesn't name what links it to the next");
    expect(chainProblem([s("a.ts", 1, 2, "store"), s("b.ts", 1, 3)], A, exit, linesOf)).toBe("`store` isn't in step 1's lines");
    expect(chainProblem([s("a.ts", 1, 2, "req"), s("b.ts", 1, 3)], A, exit, linesOf)).toBe("`req` isn't in step 2's lines");
    expect(chainProblem([s("a.ts", 1, 3)], A, { exits: [{ path: "b.ts", startLine: 3, endLine: 3 } as Seam] }, linesOf)).toBe("doesn't end on the exit point's line (b.ts:3)");
    expect(chainProblem([s("a.ts", 1, 2, "save"), s("b.ts", 1, 1)], A, { table: "users" }, linesOf)).toBe("`users` isn't in the last step's lines");
    expect(chainProblem([s("a.ts", 1, 9)], A, null, linesOf)).toBe("cites a.ts:1-9, outside the file (3 lines)");
  });
});

describe("tracing each repo's entry points", () => {
  it("asks for every entry point with the exit points, finds jobs and UI actions, and keeps the chains that hold", async () => {
    const { store } = await shop();
    const { runner, requests } = traceRunner();

    const result = await updateTraces(store, runner, "orders");

    expect(requests[0]!.prompt).toContain("- E1: route POST /api/orders (src/routes.ts:1)");
    expect(requests[0]!.prompt).toMatch(/- X\d: publishes event OrderStarted \(src\/routes\.ts:4\)/);
    expect(requests[0]!.prompt).toContain("anywhere in the repository");
    expect(result).toMatchObject({ mode: "full", kept: 4, dropped: [], untriggered: [] });
    expect(store.traceLinks("orders").map((l) => [l.entryLabel, l.target])).toEqual([
      ["POST /api/orders", { type: "exit", ref: "event-publish OrderStarted" }],
      ["POST /api/orders", { type: "table", name: "orders", access: "write" }],
      ["GraceJob", { type: "exit", ref: "event-publish GraceConfirmed" }],
      ["GraceJob", { type: "table", name: "orders", access: "read" }],
    ]);
  });

  it("drops a chain that doesn't hold, asks once more for an entry point with none left, and counts exits nothing reaches", async () => {
    const { store } = await shop();
    const bad = () => [{ entry: "E1", leads: [{ exit: "X1", steps: [step("src/db.ts", 1, 2)] }] }];
    const { runner, requests } = traceRunner(bad);

    const result = await updateTraces(store, runner, "orders");

    // The answer, one more try for the entry point, then a second look for what nothing reached.
    expect(requests).toHaveLength(3);
    expect(requests[1]!.prompt).toContain("dropped by the automatic check");
    expect(requests[2]!.prompt).toContain("These exit points weren't reached by any chain");
    expect(new Set(result.dropped.map((d) => d.reason))).toEqual(new Set(["event-publish GraceConfirmed: starts in src/db.ts, which the entry point's declaration (src/routes.ts:1) doesn't name"]));
    expect(result.untriggered).toEqual(["event-publish GraceConfirmed", "event-publish OrderStarted"]);
    // Recorded with why, so the next sync doesn't pay to ask again while its code is unchanged.
    const again = traceRunner(bad);
    expect((await updateTraces(store, again.runner, "orders")).mode).toBe("none");
    expect(again.requests).toHaveLength(0);
    const text = (await findConsumers({ store, access: new LocalAccessPolicy() }, LOCAL_CALLER, { target: "POST /api/orders", format: "concise", follow: true })).text;
    expect(text).toContain("not mapped: no chain from it held at this commit (event-publish GraceConfirmed: starts in src/db.ts");
  });

  it("takes a found job's line from where its code name is, refuses a description, and finds what a first answer missed on a second look", async () => {
    const { store } = await shop();
    let call = 0;
    const { runner, requests } = traceRunner((prompt) => {
      call++;
      const exit = (ref: string) => new RegExp(`- (X\\d+): [^\\n]*${ref}`).exec(prompt)?.[1];
      // First the route, and a job named by a description; then, asked about what nothing reached, the job by its code name, a line off.
      if (call === 1) {
        return [
          { entry: "E1", leads: [{ exit: exit("OrderStarted"), steps: [step("src/routes.ts", 2, 4)] }] },
          { found: { kind: "job", name: "Grace period job", file: "src/job.ts", line: 1 }, leads: [{ exit: exit("GraceConfirmed"), steps: [step("src/job.ts", 1, 2)] }] },
          // A component that reaches nothing is skipped, not counted as dropped.
          { found: { kind: "ui", name: "Footer", file: "src/job.ts", line: 1 }, ends: true, steps: [step("src/job.ts", 1, 2)] },
        ];
      }
      return [{ found: { kind: "job", name: "GraceJob", file: "src/job.ts", line: 2 }, leads: [{ exit: exit("GraceConfirmed"), steps: [step("src/job.ts", 1, 2)] }] }];
    });

    const result = await updateTraces(store, runner, "orders");

    expect(result.dropped.map((d) => d.reason)).toEqual(['"Grace period job" isn\'t a name from the code']);
    expect(requests[1]!.prompt).toMatch(/These exit points weren't reached by any chain[^]*publishes event GraceConfirmed/);
    expect(result.untriggered).toEqual([]);
    expect(store.traceLinks("orders").find((l) => l.entryLabel === "GraceJob")).toMatchObject({ entryLine: 1, entryKind: "job" });
  });

  it("runs nothing for a repo that meets no other service, and nothing again when no code changed", async () => {
    const { store } = await traced();
    const { runner, requests } = traceRunner();
    expect((await updateTraces(store, runner, "orders")).mode).toBe("none");
    expect(requests).toHaveLength(0);
  });

  it("moves chains past lines added around them with no AI run, and follows again only the entry points whose cited lines changed", async () => {
    const { store, dirs } = await traced();
    commit(dirs.orders!, { "src/routes.ts": `// orders\n${ROUTES}` });
    await syncRepo(store, "orders");
    const shifted = traceRunner();
    expect((await updateTraces(store, shifted.runner, "orders")).mode).toBe("none");
    expect(shifted.requests).toHaveLength(0);
    expect(store.traceLinks("orders")[0]!.steps[0]).toMatchObject({ path: "src/routes.ts", start: 3, end: 5 });

    // The route's chains are stale now, but the job's aren't: only the route is asked about.
    const at = store.getState("orders")!.commit;
    commit(dirs.orders!, { "src/routes.ts": `// orders\n${ROUTES.replace("bus.publish", "events.publish")}` });
    await syncRepo(store, "orders");
    store.replaceSeams("orders", {
      commit: store.getState("orders")!.commit,
      paths: null,
      seams: [
        seam("orders", "http-route", "POST /api/orders", "src/routes.ts", 2, at),
        seam("orders", "event-publish", "OrderStarted", "src/routes.ts", 5, at),
        seam("orders", "event-publish", "GraceConfirmed", "src/job.ts", 2, at),
      ],
    });
    const changed = traceRunner(() => [{ entry: "E1", ends: true, steps: [step("src/routes.ts", 3, 6)] }]);
    await updateTraces(store, changed.runner, "orders");
    // The route, and a second look at OrderStarted, which it no longer reaches.
    expect(changed.requests).toHaveLength(2);
    expect(changed.requests[1]!.prompt).toMatch(/weren't reached by any chain[^]*OrderStarted/);
    expect(changed.requests[1]!.prompt).not.toMatch(/weren't reached by any chain[^]*GraceConfirmed/);
    expect(changed.requests[0]!.prompt).toContain("- E1: route POST /api/orders (src/routes.ts:2)");
    expect(changed.requests[0]!.prompt).not.toContain("anywhere in the repository");
    expect(store.traceLinks("orders").filter((l) => l.entryLabel === "GraceJob")).toHaveLength(2);
  });
});

describe("following a flow", () => {
  it("goes from the server through what it publishes to the handler, and through a table it writes to the job that reads it", async () => {
    const { deps } = await traced();

    const text = (await findConsumers(deps, LOCAL_CALLER, { target: "POST /api/orders", format: "concise", follow: true })).text;

    expect(text).toContain("Started from: web UI action CheckoutPage (src/app.js:2)");
    expect(text).toContain("What handling it sets off");
    expect(text).toContain("orders · POST /api/orders · src/routes.ts:1");
    expect(text).toContain("  → publishes OrderStarted (src/routes.ts:2-4)");
    expect(text).toContain("basket · handles OrderStarted · src/handler.ts:1 · ends here: reaches no other service or table (src/handler.ts:1-2)");
    expect(text).toContain("  → writes table orders via saveOrder (src/db.ts:1-2)");
    expect(text).toContain("orders · job GraceJob · src/job.ts:1");
    expect(text).toContain("→ publishes GraceConfirmed (src/job.ts:1-2)");
    expect(text).toContain("(nothing enrolled serves or handles it)");
  });

  it("starts from an event's handlers, says when an entry point isn't mapped, and only counts repos the caller can't read", async () => {
    const { store } = await traced();
    store.replaceTraceLinks("basket", null, []);
    const deps = { store, access: new LocalAccessPolicy() };
    expect((await findConsumers(deps, LOCAL_CALLER, { target: "event OrderStarted", format: "concise", follow: true })).text).toContain(
      "basket · handles OrderStarted · src/handler.ts:1 · not mapped yet",
    );

    const noBasket: AccessPolicy = { readableRepos: async (_c, candidates) => new Set(candidates.filter((r) => r !== "basket")) };
    const hidden = (await findConsumers({ store, access: noBasket }, LOCAL_CALLER, { target: "POST /api/orders", format: "concise", follow: true })).text;
    expect(hidden).toContain("continues in a repo you can't read");
    expect(hidden).not.toContain("basket ·");
  });

  it("shows a loop as a loop, and folds wide steps in concise answers but not detailed ones", async () => {
    const { store, deps } = await traced();
    // The basket's handler publishes the event it handles: a loop.
    const at = store.getState("basket")!.commit;
    store.replaceSeams("basket", { commit: at, paths: null, seams: [seam("basket", "event-subscribe", "OrderStarted", "src/handler.ts", 1, at), seam("basket", "event-publish", "OrderStarted", "src/handler.ts", 2, at)] });
    store.replaceTraceLinks("basket", null, [
      { repo: "basket", entry: "event-subscribe OrderStarted", entryKind: "event-subscribe", entryLabel: "OrderStarted", entryPath: "src/handler.ts", entryLine: 1, target: { type: "exit", ref: "event-publish OrderStarted" }, steps: [{ path: "src/handler.ts", start: 1, end: 2 }], commit: at },
    ]);
    expect((await findConsumers(deps, LOCAL_CALLER, { target: "event OrderStarted", format: "concise", follow: true })).text).toContain("goes back to a step above");

    const orders = store.getState("orders")!.commit;
    const base = { repo: "orders", entry: "http-route POST /api/orders", entryKind: "http-route" as const, entryLabel: "POST /api/orders", entryPath: "src/routes.ts", entryLine: 1, steps: [{ path: "src/routes.ts", start: 3, end: 3 }], commit: orders };
    const wide = [
      ...Array.from({ length: 7 }, (_, i) => ({ ...base, target: { type: "exit" as const, ref: `event-publish Event${i}` } })),
      ...Array.from({ length: 3 }, (_, i) => ({ ...base, target: { type: "table" as const, name: `t${i}`, access: "write" as const } })),
    ];
    store.replaceTraceLinks("orders", ["http-route POST /api/orders"], wide);
    const concise = (await findConsumers(deps, LOCAL_CALLER, { target: "POST /api/orders", format: "concise", follow: true })).text;
    expect(concise).toContain("+2 more things it reaches");
    // Tables the flow doesn't continue from go on one line in concise answers.
    expect(concise).toContain("  tables: writes t0, t1, t2");
    const detailed = (await findConsumers(deps, LOCAL_CALLER, { target: "POST /api/orders", format: "detailed", follow: true })).text;
    expect(detailed).toContain("publishes Event6");
    expect(detailed).toContain("→ writes table t2");
  });

  it("carries a table write on only to jobs that poll it, matching the table whatever its schema, quotes or case", async () => {
    const { store, deps } = await traced();
    const at = store.getState("orders")!.commit;
    // A route that reads the same table is set off by its own callers, not by the write.
    store.replaceTraceLinks("orders", ["http-route GET /api/orders"], [
      { repo: "orders", entry: "http-route GET /api/orders", entryKind: "http-route", entryLabel: "GET /api/orders", entryPath: "src/db.ts", entryLine: 1, target: { type: "table", name: "orders", access: "read" }, steps: [{ path: "src/db.ts", start: 2, end: 2 }], commit: at },
    ]);
    const job = store.traceLinks("orders").filter((l) => l.entryLabel === "GraceJob");
    store.replaceTraceLinks("orders", job.map((l) => l.entry), job.map((l) => (l.target.type === "table" ? { ...l, target: { ...l.target, name: "[dbo].[Orders]" } } : l)));

    const text = (await findConsumers(deps, LOCAL_CALLER, { target: "POST /api/orders", format: "concise", follow: true })).text;

    expect(text).toContain("orders · job GraceJob");
    expect(text).not.toContain("GET /api/orders ·");
    expect(tableKey("ordering.orders")).toBe(tableKey('"Orders"'));
  });

  it("ends a chain at a call named only at run time, saying where it goes can't be followed, not that it reaches nothing", async () => {
    const env = await shop();
    const at = env.store.getState("basket")!.commit;
    const cacheCall = { ...seam("basket", "http-call", "GET config:CacheUrl", "src/handler.ts", 2, at), key: null };
    env.store.replaceSeams("basket", { commit: at, paths: null, seams: [seam("basket", "event-subscribe", "OrderStarted", "src/handler.ts", 1, at), cacheCall] });
    const answer = (prompt: string) =>
      prompt.includes("src/handler.ts:1") ? [{ entry: "E1", leads: [{ exit: /- (X\d+): [^\n]*config:CacheUrl/.exec(prompt)?.[1], steps: [step("src/handler.ts", 1, 2)] }] }] : answersFor(prompt);
    for (const repo of ["web", "orders", "basket"]) await updateTraces(env.store, traceRunner(answer).runner, repo);

    const text = (await findConsumers(env.deps, LOCAL_CALLER, { target: "POST /api/orders", format: "concise", follow: true })).text;

    expect(text).toContain("→ calls GET config:CacheUrl (src/handler.ts:1-2)");
    expect(text).toContain("(named only at run time, so where it goes can't be followed)");
    expect(text).not.toContain("handles OrderStarted · src/handler.ts:1 · ends here");
  });

  it("explains that packages aren't traced", async () => {
    const { deps } = await traced();
    expect((await findConsumers(deps, LOCAL_CALLER, { target: "package left-pad", format: "concise", follow: true })).text).not.toContain("What handling");
  });
});
