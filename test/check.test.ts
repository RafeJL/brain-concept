import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkPage, parseCitations } from "../src/ai/check.js";
import { repoFromFixture } from "./helpers.js";

const PAGE = readFileSync(fileURLToPath(new URL("./fixtures/wiki/page-to-check.md", import.meta.url)), "utf8");

/** The articles-api fixture repo, plus a 100-line file for the over-broad citation. */
function repo(): string {
  const dir = repoFromFixture("articles-api");
  writeFileSync(join(dir, "notes.txt"), Array.from({ length: 100 }, (_, i) => `note ${i + 1}`).join("\n"));
  return dir;
}

describe("parseCitations", () => {
  it("reads every form the AI writes", () => {
    expect(parseCitations("x [a.ts:3] y")).toEqual([{ path: "a.ts", start: 3, end: 3 }]);
    expect(parseCitations("[src/a.ts:12-20]")).toEqual([{ path: "src/a.ts", start: 12, end: 20 }]);
    expect(parseCitations("[Makefile:1-2,13-14]")).toEqual([
      { path: "Makefile", start: 1, end: 2 },
      { path: "Makefile", start: 13, end: 14 },
    ]);
    expect(parseCitations("[routes/api.php:16; app/Auth.php:29-39]")).toEqual([
      { path: "routes/api.php", start: 16, end: 16 },
      { path: "app/Auth.php", start: 29, end: 39 },
    ]);
    expect(parseCitations("[a.ts:1-7][./b.md:23]")).toEqual([
      { path: "a.ts", start: 1, end: 7 },
      { path: "b.md", start: 23, end: 23 },
    ]);
  });

  it("ignores links, code in brackets and bracketed prose", () => {
    expect(parseCitations("[Express](https://expressjs.com) `[Authorize]` [see below] [1]")).toEqual([]);
  });
});

describe("checkPage", () => {
  it("keeps supported claims, removes the rest, and says why", () => {
    const checked = checkPage(PAGE, repo());

    expect(checked.removed).toEqual([
      { text: "- The delete route calls `destroyArticle` to remove the row [src/articles.ts:4].", reason: "`destroyArticle` isn't in the cited lines" },
      { text: "- Responses are cached by `CacheLayer` for an hour [src/articles.ts:2].", reason: "`CacheLayer` isn't in the cited lines" },
      { text: "- Every route is also listed in the routes table [src/routes.ts:1].", reason: "cites src/routes.ts, which doesn't exist at this commit" },
      { text: "- The whole notes file explains the design choices [notes.txt:1-100].", reason: "cites 100 lines of notes.txt; too broad to support one claim" },
      { text: "- Deleting an article requires the caller to be its author.", reason: "no citation" },
    ]);
    expect(checked).toMatchObject({ claims: 12, publishable: true });
  });

  it("removes failed claims from the page and reduces external links to their text", () => {
    const checked = checkPage(PAGE, repo());

    expect(checked.markdown).toBe(
      [
        "# API",
        "",
        "`articles-api` is an Express API serving two routes [README.md:3]. It builds one `Router` [src/articles.ts:1-2]. The router itself is the default export [src/articles.ts:5].",
        "",
        "- `GET /articles/:slug` uses `auth.optional` [src/articles.ts:3].",
        "- `DELETE /articles/:slug` needs `auth.required` [src/articles.ts:4; README.md:3].",
        "- Both routes take a `slug` parameter [src/articles.ts:3,4].",
        "",
        "Built with Express and nothing else [src/articles.ts:1].",
        "",
        "Common invocations:",
        "",
      ].join("\n"),
    );
  });

  it("removes a bad sentence from the middle of a paragraph and keeps the rest", () => {
    const checked = checkPage("The file builds a `Router` [src/articles.ts:2]. It uses `Kafka` [src/articles.ts:2]. It exports the router [src/articles.ts:5].", repo());

    expect(checked.markdown).toBe("The file builds a `Router` [src/articles.ts:2]. It exports the router [src/articles.ts:5].");
  });

  it("accepts paraphrased, namespaced and file-named terms, but not invented ones", () => {
    const dir = repo();
    const keep = (claim: string) => checkPage(claim, dir).removed.length === 0;

    expect(keep("Routes are attached with `router.get()` in the router module [src/articles.ts:3].")).toBe(true);
    expect(keep("The router lives in `src/articles.ts` and has two routes [src/articles.ts:3-4].")).toBe(true);
    expect(keep("Optional auth is `Auth\\Optional` in effect for reads [src/articles.ts:3].")).toBe(true);
    expect(keep("The module is named `articles` after its file [src/articles.ts:1].")).toBe(true);
    expect(keep("Line ranges past the end of the file are rejected [src/articles.ts:4-9].")).toBe(false);
  });

  it("won't publish a page where most claims fail, or one with nothing to check", () => {
    const dir = repo();

    expect(checkPage("It uses `Kafka` [src/articles.ts:1]. And `Redis` [src/articles.ts:2]. It has a `Router` [src/articles.ts:2].", dir).publishable).toBe(false);
    expect(checkPage("# Just a heading\n\nShort.", dir).publishable).toBe(false);
  });
});

describe("route claims", () => {
  it("accepts the methods a resource declaration implies, and still refuses a method that isn't there", () => {
    const dir = repo();
    // Line 7 is beyond the 3 lines of slack around line 2.
    writeFileSync(join(dir, "api.php"), ["<?php", "Route::resource('articles', ArticleController::class);", "", "", "", "", "Route::get('tags', TagController::class);"].join("\n"));
    writeFileSync(join(dir, "routes.rb"), ["Rails.application.routes.draw do", "  resources :articles", "end"].join("\n"));
    const keep = (claim: string) => checkPage(claim, dir).removed.length === 0;

    expect(keep("`GET /articles/{article}` shows one article [api.php:2].")).toBe(true);
    expect(keep("`PUT /articles/{article}` updates one [api.php:2].")).toBe(true);
    expect(keep("`DELETE /articles/:id` removes one [routes.rb:2].")).toBe(true);
    expect(keep("`POST /tags` creates a tag [api.php:7].")).toBe(false);
    expect(keep("`OPTIONS /articles` is answered [api.php:2].")).toBe(false);
  });

  it("checks routes written without a slash or as a bare method, and a resource's implied actions", () => {
    const dir = repo();
    writeFileSync(join(dir, "api.php"), ["<?php", "Route::resource('articles', 'ArticleController');", "", "", "", "", "Route::get('tags', 'TagController@index');"].join("\n"));
    const keep = (claim: string) => checkPage(claim, dir).removed.length === 0;

    expect(keep("`GET articles` lists articles via `ArticleController@index` [api.php:2].")).toBe(true);
    expect(keep("`PUT`/`PATCH articles/{article}` updates one via `ArticleController@update` [api.php:2].")).toBe(true);
    expect(keep("`DELETE tags` removes a tag [api.php:7].")).toBe(false);
    expect(keep("`PUT` updates a tag [api.php:7].")).toBe(false);
    expect(keep("Articles are exported via `ArticleController@export` [api.php:2].")).toBe(false);
  });
});

describe("sentences", () => {
  it("keeps a sentence whole when a citation sits in the middle of it", () => {
    const checked = checkPage("The router comes from `express` [src/articles.ts:1] and is exported at the end of the file [src/articles.ts:5].", repo());

    expect(checked).toMatchObject({ claims: 1, removed: [] });
  });
});

describe("tables", () => {
  it("keeps a table's header row, and checks each body row as a claim", () => {
    const table = [
      "| Route | Auth | Where |",
      "|---|---|---|",
      "| `GET /articles/:slug` | `auth.optional` | [src/articles.ts:3] |",
      "| `PATCH /articles/:slug` | `auth.required` | [src/articles.ts:4] |",
    ].join("\n");

    const checked = checkPage(table, repo());

    expect(checked.claims).toBe(2);
    expect(checked.removed.map((r) => r.text)).toEqual(["| `PATCH /articles/:slug` | `auth.required` | [src/articles.ts:4] |"]);
    expect(checked.markdown).toBe(table.split("\n").slice(0, 3).join("\n"));
  });
});
