import { describe, expect, it } from "vitest";
import { checkPage } from "../src/ai/check.js";
import { generateWiki } from "../src/ai/generate.js";
import { inventory } from "../src/ai/inventory.js";
import { checkPlan, replanReason } from "../src/ai/plan.js";
import { limitRunner, type RunRequest, type RunResult, type Runner } from "../src/ai/runner.js";
import { normalisePath } from "../src/core/http.js";
import { withoutDiagrams } from "../src/core/sections.js";
import { BrainError, type FileRecord, type PlannedPage } from "../src/core/types.js";
import { confirmProposedNote, enrolRepo } from "../src/ingest/registry.js";
import { syncRepo } from "../src/ingest/sync.js";
import { LOCAL_CALLER, LocalAccessPolicy } from "../src/serve/access.js";
import { getPage } from "../src/serve/tools/get-page.js";
import { repoCard } from "../src/serve/tools/repo-card.js";
import { setNote } from "../src/serve/tools/set-note.js";
import { workImpact } from "../src/serve/tools/work-impact.js";
import { SqliteStore } from "../src/store/sqlite.js";
import { commit, makeRepo } from "./helpers.js";

/** A repo of four projects: large enough to be planned. */
const SHOP = {
  "README.md": "# shop\n\nA shop made of services.\n",
  "services/basket/package.json": '{ "name": "basket" }\n',
  "services/basket/src/basket.ts": "export class Basket {\n  checkout() {}\n}\n",
  "services/ordering/package.json": '{ "name": "ordering" }\n',
  "services/ordering/src/orders.ts": "export class OrderService {\n  place() {}\n}\n",
  "services/catalog/package.json": '{ "name": "catalog" }\n',
  "services/catalog/src/catalog.ts": "export class Catalog {\n  items() {}\n}\n",
  "web/package.json": '{ "name": "web" }\n',
  "web/src/app.ts": "export function app() {\n  return 'shop';\n}\n",
};

const page = (slug: string, kind: PlannedPage["kind"], covers: string[] = [], keyFiles: string[] = ["README.md"]): PlannedPage => ({
  slug,
  title: slug,
  kind,
  brief: `the ${slug}`,
  covers,
  keyFiles,
});

const PLAN: PlannedPage[] = [
  page("overview", "core"),
  page("build-run-test", "core"),
  page("api", "core"),
  page("product", "core"),
  page("basket", "area", ["services/basket"], ["services/basket/src/basket.ts"]),
  page("ordering", "area", ["services/ordering"], ["services/ordering/src/orders.ts"]),
  page("catalog", "area", ["services/catalog"], ["services/catalog/src/catalog.ts"]),
  page("web", "area", ["web"], ["web/src/app.ts"]),
  page("checkout", "flow", [], ["services/basket/src/basket.ts", "services/ordering/src/orders.ts"]),
  page("data-model", "data-model", [], ["services/ordering/src/orders.ts"]),
];

/** Where each page's one claim cites, so it passes the check. */
const CITES: Record<string, string> = {
  basket: "services/basket/src/basket.ts:1",
  ordering: "services/ordering/src/orders.ts:1",
  catalog: "services/catalog/src/catalog.ts:1",
  web: "web/src/app.ts:1",
  checkout: "services/basket/src/basket.ts:2",
  "data-model": "services/ordering/src/orders.ts:1",
};

function markdown(slug: string): string {
  return `# ${slug}\n\nThis page describes the ${slug} part of the shop [${CITES[slug] ?? "README.md:1"}].`;
}

const toPlanAnswer = (plan: readonly PlannedPage[]) => ({
  pages: plan.map((p) => ({ slug: p.slug, title: p.title, kind: p.kind, brief: p.brief, covers: p.covers, key_files: p.keyFiles })),
});

/**
 * Answers like Claude Code: the plan for a planning run, otherwise each page asked for. `fail`
 * makes a page run that includes that slug return malformed output.
 */
function shopRunner(plan: readonly PlannedPage[] = PLAN, options: { fail?: string } = {}) {
  const requests: RunRequest[] = [];
  const runner: Runner = {
    async run<T>(request: RunRequest): Promise<RunResult<T>> {
      requests.push(request);
      const schema = request.schema as { properties: { pages: { items: { properties: { slug: { enum?: string[] }; key_files?: unknown } } } } };
      const item = schema.properties.pages.items.properties;
      const result = (output: unknown) => ({ output: output as T, costUsd: 0.1, durationMs: 1000, model: "claude-sonnet-5" });
      if (item.key_files) return result(toPlanAnswer(plan));
      const slugs = item.slug.enum ?? plan.map((p) => p.slug);
      if (options.fail && slugs.includes(options.fail)) throw new BrainError("malformed");
      return result({ pages: slugs.map((slug) => ({ slug, title: slug, markdown: markdown(slug) })) });
    },
  };
  return { runner, requests, planRuns: () => requests.filter((r) => r.prompt.includes("You are planning")), pageRuns: () => requests.filter((r) => !r.prompt.includes("You are planning")) };
}

async function shop(files: Record<string, string> = SHOP) {
  const store = new SqliteStore(":memory:");
  const dir = makeRepo(files);
  await enrolRepo(store, { path: dir, name: "shop" });
  await syncRepo(store, "shop");
  return { store, dir, deps: { store, access: new LocalAccessPolicy() } };
}

const file = (path: string, language: string | null = "TypeScript"): FileRecord => ({ repo: "r", path, blob: "b", bytes: 1, language, commit: "c" });

describe("the inventory", () => {
  it("calls a repo large only with many source files or several projects, not counting tests or vendored code", () => {
    const small = [file("package.json", "JSON"), ...Array.from({ length: 150 }, (_, i) => file(`src/f${i}.ts`)), ...Array.from({ length: 100 }, (_, i) => file(`test/t${i}.ts`))];
    expect(inventory(small)).toMatchObject({ sourceFiles: 150, large: false, projects: ["."] });
    expect(inventory([...small, ...Array.from({ length: 60 }, (_, i) => file(`lib/g${i}.ts`))]).large).toBe(true);
    const projects = ["a", "b", "c", "d"].map((p) => file(`services/${p}/package.json`, "JSON"));
    expect(inventory([...projects, file("node_modules/x/package.json", "JSON"), file("tests/e2e/package.json", "JSON")])).toMatchObject({ large: true, projects: ["services/a", "services/b", "services/c", "services/d"] });
    expect(inventory(projects.slice(0, 3)).large).toBe(false);
  });

  it("maps folders, projects and entry points for the planning run", () => {
    const map = inventory([file("src/Basket.API/Basket.API.csproj", "MSBuild"), ...["Program.cs", "A.cs", "B.cs"].map((f) => file(`src/Basket.API/${f}`, "C#"))]);
    expect(map.text).toContain("Projects (folders with a manifest): src/Basket.API");
    expect(map.text).toContain("- src/Basket.API: 3");
    expect(map.text).toContain("Likely entry points: src/Basket.API/Program.cs");
  });
});

describe("the page plan", () => {
  it("is refused when folders or files don't exist, slugs repeat, core pages are missing or it's over the caps", async () => {
    const { dir } = await shop();
    const raw = (plan: readonly PlannedPage[]) => toPlanAnswer(plan).pages;
    expect(checkPlan(raw(PLAN), dir)).toMatchObject({ problems: [] });
    const bad = [
      ...PLAN.filter((p) => p.slug !== "product"),
      page("basket", "area"),
      page("payments", "area", ["services/payments"], ["services/payments/pay.ts"]),
      ...["a", "b", "c", "d"].map((s) => page(`flow-${s}`, "flow")),
      ...Array.from({ length: 6 }, (_, i) => page(`extra-${i}`, "area")),
    ];
    expect(checkPlan(raw(bad), dir).problems).toEqual([
      '"basket" is planned twice',
      '"payments" covers services/payments, which isn\'t a folder',
      '"payments" starts from services/payments/pay.ts, which isn\'t a file',
      'the core page "product" is missing',
      "21 pages planned; at most 20",
      "5 flow pages; at most 3",
    ]);
  });

  it("is made again only for a new project or enough new code outside every page, or a changed note", () => {
    const added = (...paths: string[]) => paths.map((path) => ({ path, status: "A" as const }));
    expect(replanReason([], [], false)).toBe("no plan yet");
    expect(replanReason(PLAN, [], true)).toBe("the steering note changed");
    expect(replanReason(PLAN, added("services/payments/package.json"), false)).toBe("a new project at services/payments");
    expect(replanReason(PLAN, added("scripts/tidy.ts", "tests/x/package.json", "services/basket/src/more.ts"), false)).toBeNull();
    expect(replanReason(PLAN, added(...Array.from({ length: 10 }, (_, i) => `tools/t${i}.ts`)), false)).toBe("10 new source files outside every page");
    expect(replanReason(PLAN, null, false)).toBe("the history since the plan can't be compared");
  });
});

describe("a large repo's wiki", () => {
  it("is planned from the inventory, then written a few pages a run, side by side, each run given the plan", async () => {
    const { store } = await shop();
    const { runner, planRuns, pageRuns } = shopRunner();

    const wiki = await generateWiki(store, runner, "shop");

    expect(planRuns()).toHaveLength(1);
    expect(planRuns()[0]!.prompt).toContain("- services/basket: 1");
    expect(pageRuns()).toHaveLength(3);
    expect(pageRuns().every((r) => r.prompt.includes("- checkout (flow): checkout: the checkout"))).toBe(true);
    expect(pageRuns()[1]!.prompt).toContain('- slug "basket" (area), title "basket": the basket. Covers services/basket. Start from services/basket/src/basket.ts.');
    expect(pageRuns()[0]!.prompt).toContain("The product page (slug \"product\"");
    expect(pageRuns()[1]!.prompt).not.toContain("The product page (slug \"product\"");
    expect(wiki.plan).toMatchObject({ reason: "a full rewrite", problems: [] });
    expect(store.pages("shop").map((p) => [p.slug, p.kind])).toEqual(PLAN.map((p) => [p.slug, p.kind]));
    expect(store.wikiPlan("shop")).toEqual(PLAN);
    expect(store.getState("shop")?.planCommit).toBe(wiki.commit);
  });

  it("says how many of its pages are written as each run finishes, for an enrolment's progress", async () => {
    const { store } = await shop();
    const seen: string[] = [];

    await generateWiki(store, shopRunner().runner, "shop", { onPages: (done, total) => seen.push(`${done}/${total}`) });

    // The plan's 10 pages, then three runs of at most four, finishing in any order.
    expect(seen[0]).toBe("0/10");
    expect(seen).toHaveLength(4);
    expect(seen.at(-1)).toBe("10/10");
  });

  it("keeps the pages of the runs that worked when one run fails", async () => {
    const { store } = await shop();
    const { runner } = shopRunner(PLAN, { fail: "ordering" });

    const wiki = await generateWiki(store, runner, "shop");

    expect(store.pages("shop").map((p) => p.slug)).toEqual(PLAN.map((p) => p.slug).filter((s) => !["basket", "ordering", "catalog", "web"].includes(s)));
    expect(wiki.reports.find((r) => r.slug === "ordering")).toMatchObject({ published: false });
    expect(store.getState("shop")?.pagesFailedAt).toBe(wiki.commit);
  });

  it("plans again for a new project and writes only its page; a stray file plans nothing", async () => {
    const { store, dir } = await shop();
    await generateWiki(store, shopRunner().runner, "shop");

    commit(dir, { "services/payments/package.json": '{ "name": "payments" }\n', "services/payments/src/pay.ts": "export function pay() {}\n" });
    await syncRepo(store, "shop");
    const grown = [...PLAN, page("payments", "area", ["services/payments"], ["services/payments/src/pay.ts"])];
    const next = shopRunner(grown);
    const wiki = await generateWiki(store, next.runner, "shop");

    expect(wiki.plan).toMatchObject({ reason: "a new project at services/payments", added: ["payments"], retired: [] });
    expect(next.planRuns()[0]!.prompt).toContain("The wiki already has the pages below. Keep them");
    expect(next.pageRuns()).toHaveLength(1);
    expect(next.pageRuns()[0]!.prompt).toContain('- slug "payments" (area)');
    expect(wiki.carried).toHaveLength(PLAN.length);
    expect(store.pages("shop").at(-1)).toMatchObject({ slug: "payments", kind: "area" });

    commit(dir, { "scripts/tidy.ts": "export {};\n" });
    await syncRepo(store, "shop");
    const quiet = shopRunner(grown);
    expect((await generateWiki(store, quiet.runner, "shop")).plan).toBeNull();
    expect(quiet.requests).toHaveLength(0);
  });

  it("plans a wiki written before plans existed around its pages, and writes only the new ones", async () => {
    const { store } = await shop();
    const commitSha = store.getState("shop")!.commit;
    const old = ["overview", "build-run-test", "api", "product", "basket"].map((slug) => ({
      repo: "shop", slug, title: slug, kind: (slug === "basket" ? "area" : "core") as PlannedPage["kind"], markdown: markdown(slug),
      commit: commitSha, claims: 1, removed: 0, model: "m", costUsd: 0, generatedAt: "then",
    }));
    store.replacePages("shop", old);
    const { runner, planRuns, pageRuns } = shopRunner();

    const wiki = await generateWiki(store, runner, "shop");

    expect(planRuns()[0]!.prompt).toContain("- basket (area): basket");
    expect(wiki.plan).toMatchObject({ reason: "no plan yet", added: ["ordering", "catalog", "web", "checkout", "data-model"] });
    expect(pageRuns().flatMap((r) => (r.schema as { properties: { pages: { items: { properties: { slug: { enum: string[] } } } } } }).properties.pages.items.properties.slug.enum)).toEqual([
      "ordering", "catalog", "web", "checkout", "data-model",
    ]);
    expect(store.pages("shop")).toHaveLength(PLAN.length);
  });

  it("is listed by kind, summed up on the card, and points work at its area and flow pages", async () => {
    const { store, deps } = await shop();
    await generateWiki(store, shopRunner().runner, "shop");

    const list = (await getPage(deps, LOCAL_CALLER, { repo: "shop" })).text;
    expect(list).toContain("Areas:\n  basket                   basket: This page describes the basket part of the shop.");
    expect(list).toContain("Flows:\n  checkout");
    expect(list).toContain('start with "overview"');
    expect((await repoCard(deps, LOCAL_CALLER, "shop", "concise")).text).toContain("Wiki: 10 pages: 4 core, 4 areas, 1 flow, data model · brain_get lists them; start with overview");
    expect((await workImpact(deps, LOCAL_CALLER, { work: "checkout the basket", format: "concise" })).text).toContain("for a technical plan, read: flow checkout, area basket");
  });
});

describe("a small repo's wiki", () => {
  it("asks again, on their own, for the pages every wiki has when a full run leaves them out", async () => {
    const store = new SqliteStore(":memory:");
    await enrolRepo(store, { path: makeRepo({ "README.md": "# web\n\nA web app.\n" }), name: "web" });
    await syncRepo(store, "web");
    const requests: RunRequest[] = [];
    const runner: Runner = {
      async run<T>(request: RunRequest): Promise<RunResult<T>> {
        requests.push(request);
        const asked = (request.schema as { properties: { pages: { items: { properties: { slug: { enum?: string[] } } } } } }).properties.pages.items.properties.slug.enum ?? ["overview"];
        const pages = asked.map((slug) => ({ slug, title: slug, markdown: `# ${slug}\n\nThe web app is described in its readme [README.md:3].` }));
        return { output: { pages } as T, costUsd: 0.1, durationMs: 1, model: "m" };
      },
    };

    await generateWiki(store, runner, "web");

    expect(requests).toHaveLength(2);
    expect(requests[1]!.prompt).toContain("The wiki doesn't have these pages yet");
    expect(store.pages("web").map((p) => p.slug)).toEqual(["overview", "build-run-test", "api", "product"]);
  });
});

describe("the steering note", () => {
  it("is set with the person's words agreeing, and steers the plan and every page run", async () => {
    const { store, deps } = await shop();

    const set = await setNote(deps, LOCAL_CALLER, { repo: "shop", text: "Ordering matters most.", confirmedWith: "yes, set that" }, { person: "Rafe" });

    expect(set.text).toContain('Set shop\'s note, from Rafe: "Ordering matters most."');
    expect(store.getRepo("shop")?.note).toMatchObject({ text: "Ordering matters most.", by: "Rafe", with: "yes, set that" });
    const { runner, requests } = shopRunner();
    await generateWiki(store, runner, "shop");
    expect(requests.every((r) => r.prompt.includes("<note>\nOrdering matters most.\n</note>"))).toBe(true);
    expect(store.getState("shop")?.planNote).toBe("Ordering matters most.");
  });

  it("waits as proposed, steering nothing, without their words; confirmed later in the conversation or a terminal", async () => {
    const { store, deps } = await shop();
    const proposed = await setNote(deps, LOCAL_CALLER, { repo: "shop", text: "Ordering matters most" }, { person: "Rafe" });
    expect(proposed.text).toContain("Stored as a proposed note on shop");
    expect(store.getRepo("shop")).toMatchObject({ note: null, proposedNote: { text: "Ordering matters most", by: "Rafe" } });
    const { runner, requests } = shopRunner();
    await generateWiki(store, runner, "shop");
    expect(requests.some((r) => r.prompt.includes("Ordering matters most"))).toBe(false);

    const unworded = await setNote(deps, LOCAL_CALLER, { repo: "shop", confirmProposed: true }, { person: "Sam" });
    expect(unworded.ok).toBe(false);
    await setNote(deps, LOCAL_CALLER, { repo: "shop", confirmProposed: true, confirmedWith: "go with that" }, { person: "Sam" });
    expect(store.getRepo("shop")).toMatchObject({ note: { text: "Ordering matters most", by: "Sam", with: "go with that" }, proposedNote: null });

    await setNote(deps, LOCAL_CALLER, { repo: "shop", text: "Basket too" }, { person: "Rafe" });
    confirmProposedNote(store, "shop", "Sam");
    expect(store.getRepo("shop")).toMatchObject({ note: { text: "Basket too", by: "Sam" }, proposedNote: null });
  });
});

describe("diagrams", () => {
  const root = makeRepo({ "src/orders.ts": "export class OrderService {\n  place(basket) {\n    bus.publish('OrderPlaced');\n  }\n}\n", "src/basket.ts": "export class Basket {}\n" }, "file");
  const check = (body: string) => checkPage(`# Overview\n\nOrders are placed by the order service [src/orders.ts:1-2].\n\n\`\`\`mermaid\n${body}\n\`\`\``, root);

  it("keeps cited boxes and links between them, and removes the rest with the links to them", () => {
    const result = check(
      [
        "flowchart LR",
        "%% [src/orders.ts:1]",
        'orders["OrderService"]',
        "%% [src/basket.ts:1]",
        'basket["Basket"]',
        "%% [src/basket.ts:1]",
        'pay["Payments gateway"]',
        'ghost["Never cited"]',
        "%% comment saying anything",
        "basket --> orders",
        "orders --> pay",
        "%% [src/orders.ts:3]",
        "orders -->|OrderPlaced| basket",
      ].join("\n"),
    );

    expect(result.markdown).toContain('%% [src/orders.ts:1]\norders["OrderService"]\n%% [src/basket.ts:1]\nbasket["Basket"]\nbasket --> orders\n%% [src/orders.ts:3]\norders -->|OrderPlaced| basket\n```');
    expect(result.markdown).not.toContain("pay");
    expect(result.markdown).not.toContain("comment saying");
    expect(result.removed.map((r) => r.reason)).toEqual(['none of "Payments gateway" is in the cited lines', "no citation"]);
    expect(result.claims).toBe(1 + 5);
  });

  it("checks a sequence diagram's messages, and drops diagrams that mostly fail or can't be read", () => {
    const sequence = check(["sequenceDiagram", "participant B as Basket", "%% [src/orders.ts:2]", "B->>O: place(basket)", "%% [src/orders.ts:3]", "O-->>B: OrderPlaced"].join("\n"));
    expect(sequence.removed).toEqual([]);
    expect(sequence.markdown).toContain("B->>O: place(basket)");

    const failing = check(["sequenceDiagram", "%% [src/orders.ts:1]", "B->>O: Refunds issued", "C->>O: Invoices sent"].join("\n"));
    expect(failing.markdown).not.toContain("mermaid");
    expect(failing.removed.at(-1)?.reason).toBe("diagram dropped: only 0 of 2 elements are supported");

    expect(check("classDiagram\nclass Basket").markdown).not.toContain("mermaid");
    const code = checkPage("# Build\n\nRun the tests [src/orders.ts:1].\n\n```sh\nflowchart\n```", root);
    expect(code.markdown).toContain("```sh\nflowchart\n```");
  });

  it("keep a pointer to another page when it sits inside a cited sentence, as page runs are told", () => {
    const result = checkPage("# Ordering\n\nOrders are placed by `OrderService` [src/orders.ts:1] (see the basket page).\n\nSee the basket page for how baskets are kept.", root);
    expect(result.markdown).toContain("[src/orders.ts:1] (see the basket page).");
    expect(result.removed.map((r) => r.reason)).toEqual(["no citation"]);
  });

  it("are left out of what agents read unless they ask, and out of search", async () => {
    const { store, deps } = await shop();
    const commitSha = store.getState("shop")!.commit;
    const md = `# Overview\n\nA shop of services [README.md:1].\n\n\`\`\`mermaid\nflowchart LR\n%% [web/src/app.ts:1]\nweb["app"]\n\`\`\``;
    store.replacePages("shop", [{ repo: "shop", slug: "overview", title: "Overview", kind: "core", markdown: md, commit: commitSha, claims: 2, removed: 0, model: "m", costUsd: 0, generatedAt: "now" }]);

    expect((await getPage(deps, LOCAL_CALLER, { repo: "shop", page: "overview" })).text).not.toContain("flowchart");
    expect((await getPage(deps, LOCAL_CALLER, { repo: "shop", page: "overview", diagrams: true })).text).toContain('web["app"]');
    expect(store.searchSections({ repos: ["shop"], match: "flowchart", limit: 5 }).hits).toEqual([]);
    expect(withoutDiagrams(md)).toBe("# Overview\n\nA shop of services [README.md:1].\n\n");
  });
});

describe("the integrations page", () => {
  it("adds the enrolled repos this one talks to, from the link map, when it's read", async () => {
    const { store, deps } = await shop();
    const commitSha = store.getState("shop")!.commit;
    await enrolRepo(store, { path: makeRepo({ "client.ts": "fetch('/api/orders');\n" }), name: "app" });
    await syncRepo(store, "app");
    const seam = (repo: string, kind: "http-route" | "http-call", path: string) => ({
      repo, path, kind, method: "GET", rawPath: "/api/orders", key: normalisePath("/api/orders"), startLine: 1, endLine: 1, cites: [], commit: store.getState(repo)!.commit,
    });
    store.replaceSeams("shop", { commit: commitSha, paths: null, seams: [seam("shop", "http-route", "services/ordering/src/orders.ts")] });
    store.replaceSeams("app", { commit: store.getState("app")!.commit, paths: null, seams: [seam("app", "http-call", "client.ts")] });
    const md = "# Integrations\n\nOrders are stored in a database [services/ordering/src/orders.ts:1].";
    store.replacePages("shop", [{ repo: "shop", slug: "integrations", title: "Integrations", kind: "integrations", markdown: md, commit: commitSha, claims: 1, removed: 0, model: "m", costUsd: 0, generatedAt: "now" }]);

    const text = (await getPage(deps, LOCAL_CALLER, { repo: "shop", page: "integrations" })).text;

    expect(text).toContain("## Other enrolled repos (from the brain's link map, checked against the code)\n- Used by app: 1 call");
  });
});

describe("running side by side", () => {
  it("never lets more than the cap run at once, and runs the rest in order", async () => {
    let running = 0;
    let most = 0;
    const order: number[] = [];
    const slow: Runner = {
      async run<T>(request: RunRequest): Promise<RunResult<T>> {
        running++;
        most = Math.max(most, running);
        await new Promise((resolve) => setTimeout(resolve, 20));
        order.push(Number(request.prompt));
        running--;
        return { output: {} as T, costUsd: 0, durationMs: 0, model: "m" };
      },
    };
    const limited = limitRunner(slow, 2);

    await Promise.all(Array.from({ length: 6 }, (_, i) => limited.run({ cwd: ".", prompt: String(i), schema: {}, model: "m" })));

    expect(most).toBe(2);
    expect(order.slice(2)).toEqual([2, 3, 4, 5]);
  });
});
