import { describe, expect, it } from "vitest";
import { generateWiki } from "../src/ai/generate.js";
import type { RunRequest, Runner } from "../src/ai/runner.js";
import { firstSentence } from "../src/core/sections.js";
import { enrolRepo } from "../src/ingest/registry.js";
import { syncRepo } from "../src/ingest/sync.js";
import { LOCAL_CALLER, LocalAccessPolicy } from "../src/serve/access.js";
import { getPage } from "../src/serve/tools/get-page.js";
import { repoCard } from "../src/serve/tools/repo-card.js";
import { SqliteStore } from "../src/store/sqlite.js";
import { repoFromFixture } from "./helpers.js";

type Page = { slug: string; title: string; markdown: string };

/** Answers each run with the next list of pages (the last repeats), and remembers the requests. */
function pagesRunner(...answers: Page[][]) {
  const requests: RunRequest[] = [];
  const runner: Runner = {
    async run<T>(request: RunRequest) {
      requests.push(request);
      const pages = answers[Math.min(requests.length, answers.length) - 1]!;
      return { output: { pages } as T, costUsd: 0.1, durationMs: 1000, model: "claude-sonnet-5" };
    },
  };
  return { runner, requests };
}

// Cited lines are in test/fixtures/repos/articles-api.
const overview = { slug: "overview", title: "Overview", markdown: "# Overview\n\n`articles-api` is an Express API serving articles [README.md:1; src/articles.ts:1-5]." };
const build = { slug: "build-run-test", title: "Build, run and test", markdown: "# Build, run and test\n\nThe repository declares no build or test scripts [README.md:1-3]." };
const conventions = { slug: "conventions", title: "Conventions", markdown: "# Conventions\n\nThe repository documents no coding conventions [README.md:1-3]." };
const api = { slug: "api", title: "API", markdown: "# API\n\n- `GET /articles/:slug` returns one article [src/articles.ts:3]." };
const routing = { slug: "routing", title: "Routing", markdown: "# Routing\n\nRoutes hang off one Express `Router` [src/articles.ts:1-2]." };
const product = {
  slug: "product",
  title: "Product",
  markdown:
    "# Product\n\nLets readers look up and remove articles [README.md:3].\n\n## Business rules\n\n" +
    "- Only signed-in users can remove an article [src/articles.ts:4].\n" +
    "- An article is removed for good after thirty days in the bin [src/articles.ts:40].",
};

async function setup() {
  const store = new SqliteStore(":memory:");
  await enrolRepo(store, { path: repoFromFixture("articles-api"), name: "api" });
  await syncRepo(store, "api");
  return { store, deps: { store, access: new LocalAccessPolicy() } };
}

describe("the product page", () => {
  it("is asked for in a full run, in product language with no code names, citing where rules are enforced", async () => {
    const { store } = await setup();
    const { runner, requests } = pagesRunner([overview, build, conventions, api, routing, product]);

    await generateWiki(store, runner, "api");

    const ask = requests[0]!.prompt;
    expect(ask).toContain("Write these pages:");
    expect(ask).toContain('- slug "product": what it does for the people who use it');
    expect(ask).toContain("never put code names in the text");
    expect(ask).toContain("Cite the lines where each rule is enforced");
    expect(store.pages("api").map((p) => p.slug)).toEqual(["overview", "build-run-test", "conventions", "api", "routing", "product"]);
  });

  it("is added to an existing wiki that has no product page on the next update, without rewriting the others", async () => {
    const { store } = await setup();
    await generateWiki(store, pagesRunner([overview, build, conventions, api, routing]).runner, "api");
    store.setPagesFailedAt("api", null); // a wiki from before the product page existed
    const before = store.pages("api");
    const { runner, requests } = pagesRunner([product]);

    const wiki = await generateWiki(store, runner, "api");

    expect(requests).toHaveLength(1);
    expect(requests[0]!.prompt).toContain("The wiki doesn't have these pages yet");
    expect(requests[0]!.prompt).toContain('- slug "product"');
    expect(requests[0]!.prompt).not.toContain('<page slug="overview">');
    expect(JSON.stringify(requests[0]!.schema)).toContain('"enum":["product"]');
    expect(wiki.reports.map((r) => [r.slug, r.published])).toEqual([["product", true]]);
    expect(store.pages("api").map((p) => p.slug)).toEqual(["overview", "build-run-test", "conventions", "api", "routing", "product"]);
    expect(store.pages("api").slice(0, 5)).toEqual(before);
  });

  it("is checked like any page: an unsupported rule is removed, and a failing page is written again with its rules", async () => {
    const { store } = await setup();
    await generateWiki(store, pagesRunner([overview, build, conventions, api, routing]).runner, "api");
    store.setPagesFailedAt("api", null); // a wiki from before the product page existed
    const failing = { ...product, markdown: "# Product\n\nLets readers subscribe to newsletters [src/articles.ts:50]." };
    const { runner, requests } = pagesRunner([failing], [product]);

    const wiki = await generateWiki(store, runner, "api");

    expect(requests).toHaveLength(2);
    expect(requests[1]!.prompt).toContain("outside the file");
    expect(requests[1]!.prompt).toContain("never put code names in the text");
    expect(wiki.reports).toMatchObject([{ slug: "product", claims: 3, published: true, attempts: 2 }]);
    expect(wiki.reports[0]!.removed).toEqual([
      { text: "- An article is removed for good after thirty days in the bin [src/articles.ts:40].", reason: expect.stringMatching(/outside the file/) },
    ]);
    expect(store.pages("api").at(-1)!.markdown).not.toContain("thirty days");
  });

  it("isn't written again at the same commit after failing twice, only once the code moves on", async () => {
    const { store } = await setup();
    await generateWiki(store, pagesRunner([overview, build, conventions, api, routing]).runner, "api");
    store.setPagesFailedAt("api", null); // a wiki from before the product page existed
    const failing = { ...product, markdown: "# Product\n\nLets readers subscribe to newsletters [src/articles.ts:50]." };
    await generateWiki(store, pagesRunner([failing]).runner, "api");
    const again = pagesRunner([product]);

    const waiting = await generateWiki(store, again.runner, "api");

    expect(again.requests).toHaveLength(0);
    expect(waiting.waiting).toEqual(["product"]);
    expect(store.getState("api")!.pagesFailedAt).toBe(store.getState("api")!.commit);
    const full = await generateWiki(store, pagesRunner([overview, build, conventions, api, routing, product]).runner, "api", { full: true });
    expect(full.pages.map((p) => p.slug)).toContain("product");
    expect(store.getState("api")!.pagesFailedAt).toBeNull();
  });

  it("goes on the card as its first sentence, pointing at the page", async () => {
    const { store, deps } = await setup();
    await generateWiki(store, pagesRunner([overview, build, conventions, api, routing, product]).runner, "api");

    const card = await repoCard(deps, LOCAL_CALLER, "api", "concise");
    const page = await getPage(deps, LOCAL_CALLER, { repo: "api", page: "product" });

    expect(card.text.split("\n")[1]).toBe('Product: Lets readers look up and remove articles. · read with brain_get (page "product")');
    expect(page.text).toContain("## Business rules");
  });
});

describe("firstSentence", () => {
  it("takes the page's opening sentence without its citations", () => {
    expect(firstSentence("# Product\n\nLets readers write articles [a.ts:1]. They can also comment [a.ts:2].")).toBe("Lets readers write articles.");
    expect(firstSentence("# Product\n\nRuns on .NET 10 and serves shoppers [a.cs:1]")).toBe("Runs on .NET 10 and serves shoppers");
    expect(firstSentence("# Product\n\n## Who uses it\n\nReaders [a.ts:1].")).toBeNull();
  });
});
