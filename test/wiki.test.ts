import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { enrolRepo } from "../src/ingest/registry.js";
import { syncRepo } from "../src/ingest/sync.js";
import { LOCAL_CALLER, LocalAccessPolicy, type AccessPolicy } from "../src/serve/access.js";
import { getPage } from "../src/serve/tools/get-page.js";
import { repoCard } from "../src/serve/tools/repo-card.js";
import { SqliteStore } from "../src/store/sqlite.js";
import { generateWiki } from "../src/wiki/generate.js";
import { claudeArgs, parseClaudeResult, type RunRequest, type Runner } from "../src/wiki/runner.js";
import { commit, git, repoFromFixture } from "./helpers.js";

const RECORDED = readFileSync(fileURLToPath(new URL("./fixtures/wiki/claude-pages-result.json", import.meta.url)), "utf8");

/** Answers like Claude Code did, and remembers what it was asked and what it could see. */
function fakeRunner(stdout = RECORDED) {
  const seen: { request: RunRequest; files: Record<string, string | null> }[] = [];
  const runner: Runner = {
    async run<T>(request: RunRequest) {
      const read = (path: string) => (existsSync(join(request.cwd, path)) ? readFileSync(join(request.cwd, path), "utf8") : null);
      seen.push({ request, files: { "src/articles.ts": read("src/articles.ts"), "NOTES.md": read("NOTES.md") } });
      return parseClaudeResult<T>(stdout);
    },
  };
  return { runner, seen };
}

/** A Claude Code result carrying these pages, as the fixture file does. */
function recorded(pages: { slug: string; title: string; markdown: string }[]): string {
  return JSON.stringify({ is_error: false, structured_output: { pages }, total_cost_usd: 0.1, duration_ms: 1000, modelUsage: { "claude-sonnet-5": {} } });
}

async function setup() {
  const store = new SqliteStore(":memory:");
  const dir = repoFromFixture("articles-api");
  await enrolRepo(store, { path: dir, name: "api" });
  const { commit: sha } = await syncRepo(store, "api");
  return { store, dir, sha, deps: { store, access: new LocalAccessPolicy() } };
}

describe("Claude Code runner", () => {
  it("runs isolated and read-only: no MCP servers, no user settings, file tools only", () => {
    const args = claudeArgs({ cwd: ".", prompt: "p", schema: { type: "object" }, model: "sonnet" });

    expect(args).toEqual(expect.arrayContaining(["--safe-mode", "--strict-mcp-config", "--no-session-persistence"]));
    expect(args[args.indexOf("--allowedTools") + 1]).toBe("Read,Grep,Glob");
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("dontAsk");
    expect(args[args.indexOf("--model") + 1]).toBe("sonnet");
    expect(args[args.indexOf("--output-format") + 1]).toBe("json");
  });

  it("reads a recorded result, and refuses errors and missing output", () => {
    const result = parseClaudeResult<{ pages: unknown[] }>(RECORDED);

    expect(result).toMatchObject({ costUsd: 0.42, durationMs: 41250, model: "claude-sonnet-5" });
    expect(result.output.pages).toHaveLength(3);
    expect(() => parseClaudeResult(JSON.stringify({ is_error: true, result: "rate limited" }))).toThrow(/rate limited/);
    expect(() => parseClaudeResult(JSON.stringify({ is_error: false, result: "hi" }))).toThrow(/no structured output/);
    expect(() => parseClaudeResult("not json")).toThrow(/did not return JSON/);
  });
});

describe("brain wiki", () => {
  it("stores the AI's pages, tagged with the commit the brain indexed", async () => {
    const { store, sha } = await setup();
    const { runner, seen } = fakeRunner();

    const wiki = await generateWiki(store, runner, "api");

    expect(wiki).toMatchObject({ repo: "api", commit: sha, costUsd: 0.42 });
    expect(store.pages("api").map((p) => [p.slug, p.commit, p.model])).toEqual([
      ["overview", sha, "claude-sonnet-5"],
      ["build-run-test", sha, "claude-sonnet-5"],
      ["api", sha, "claude-sonnet-5"],
    ]);
    expect(seen[0]!.request.model).toBe("sonnet");
  });

  it("runs in a worktree of the indexed commit, never the working copy, and removes it", async () => {
    const { store, dir } = await setup();
    // A newer commit the brain hasn't synced, and an uncommitted edit: neither may be seen.
    commit(dir, { "NOTES.md": "not indexed yet" });
    writeFileSync(join(dir, "src", "articles.ts"), "// uncommitted edit\n");
    const { runner, seen } = fakeRunner();

    await generateWiki(store, runner, "api");

    expect(seen[0]!.files["src/articles.ts"]).toContain('router.get("/articles/:slug"');
    expect(seen[0]!.files["NOTES.md"]).toBeNull();
    expect(existsSync(seen[0]!.request.cwd)).toBe(false);
    expect(git(dir, "worktree", "list").split("\n")).toHaveLength(1);
  });

  it("rejects malformed pages and keeps the wiki it had", async () => {
    const { store } = await setup();
    await generateWiki(store, fakeRunner().runner, "api");
    const bad = JSON.stringify({ is_error: false, structured_output: { pages: [{ slug: "Not A Slug", title: "x", markdown: "y" }] } });

    await expect(generateWiki(store, fakeRunner(bad).runner, "api")).rejects.toThrow(/malformed/);
    expect(store.pages("api").map((p) => p.slug)).toEqual(["overview", "build-run-test", "api"]);
  });

  it("checks every citation and stores what it found on each page", async () => {
    const { store } = await setup();

    const wiki = await generateWiki(store, fakeRunner().runner, "api");

    expect(wiki.reports.map((r) => [r.slug, r.claims, r.removed.length, r.published])).toEqual([
      ["overview", 1, 0, true],
      ["build-run-test", 1, 0, true],
      ["api", 2, 0, true],
    ]);
    expect(store.pages("api").map((p) => [p.slug, p.claims, p.removed])).toEqual([
      ["overview", 1, 0],
      ["build-run-test", 1, 0],
      ["api", 2, 0],
    ]);
  });

  it("removes unsupported claims, and keeps the old version of a page that mostly fails", async () => {
    const { store } = await setup();
    await generateWiki(store, fakeRunner().runner, "api");
    const firstOverview = store.pages("api")[0]!;
    const next = recorded([
      { slug: "overview", title: "Overview", markdown: "# Overview\n\nIt streams events to `Kafka` [src/articles.ts:1]. It caches in `Redis` [src/articles.ts:2]." },
      { slug: "api", title: "API", markdown: "# API\n\n- `GET /articles/:slug` is public [src/articles.ts:3].\n- `PATCH /articles/:slug` edits one [src/articles.ts:4]." },
    ]);

    const wiki = await generateWiki(store, fakeRunner(next).runner, "api");

    expect(wiki.reports.map((r) => [r.slug, r.published])).toEqual([["overview", false], ["api", true]]);
    expect(store.pages("api").map((p) => p.slug)).toEqual(["overview", "api"]);
    expect(store.pages("api")[0]).toEqual(firstOverview);
    expect(store.pages("api")[1]!.markdown).toBe("# API\n\n- `GET /articles/:slug` is public [src/articles.ts:3].");
    expect(wiki.reports[1]!.removed).toEqual([
      { text: "- `PATCH /articles/:slug` edits one [src/articles.ts:4].", reason: "`PATCH /articles/:slug` isn't in the cited lines" },
    ]);
  });

  it("leaves the wiki as it was when no page passes the check", async () => {
    const { store } = await setup();
    await generateWiki(store, fakeRunner().runner, "api");
    const bad = recorded([{ slug: "overview", title: "Overview", markdown: "# Overview\n\nIt uses `Kafka` [src/articles.ts:1]." }]);

    await expect(generateWiki(store, fakeRunner(bad).runner, "api")).rejects.toThrow(/No page passed the citation check.*overview: 0\/1/);
    expect(store.pages("api").map((p) => p.slug)).toEqual(["overview", "build-run-test", "api"]);
  });

  it("asks for a sync first when the repo hasn't been indexed", async () => {
    const store = new SqliteStore(":memory:");
    await enrolRepo(store, { path: repoFromFixture("articles-api"), name: "api" });

    await expect(generateWiki(store, fakeRunner().runner, "api")).rejects.toThrow(/brain sync api/);
  });
});

describe("brain_get", () => {
  it("lists the pages, then returns one stamped with its commit and tier", async () => {
    const { store, sha, deps } = await setup();
    await generateWiki(store, fakeRunner().runner, "api");

    const list = await getPage(deps, LOCAL_CALLER, { repo: "api" });
    const page = await getPage(deps, LOCAL_CALLER, { repo: "api", page: "api" });

    expect(list.text).toContain(`api wiki · 3 pages · @${sha.slice(0, 7)} · up to date · llm-generated`);
    expect(list.text).toMatch(/build-run-test\s+Build, run and test/);
    expect(page.text).toContain("- `DELETE /articles/:slug` removes one; auth is required [src/articles.ts:4].");
    expect(page.text).toContain("llm-generated · citations checked: 2 of 2 claims kept");
    expect(page.text).toContain("AI-written (llm-generated)");
  });

  it("says how far behind the indexed branch a page is", async () => {
    const { store, dir, deps } = await setup();
    await generateWiki(store, fakeRunner().runner, "api");
    commit(dir, { "NOTES.md": "new" });
    await syncRepo(store, "api");

    const page = await getPage(deps, LOCAL_CALLER, { repo: "api", page: "overview" });
    const card = await repoCard(deps, LOCAL_CALLER, "api", "concise");

    expect(page.text).toContain("1 commit behind main");
    expect(card.text).toMatch(/Wiki: 3 pages \(overview, build-run-test, api\) · read with brain_get · written at @\w{7}, older than the index/);
  });

  it("explains a missing wiki or page, and hides unreadable repos", async () => {
    const { store, deps } = await setup();
    const noWiki = await getPage(deps, LOCAL_CALLER, { repo: "api" });
    await generateWiki(store, fakeRunner().runner, "api");
    const noPage = await getPage(deps, LOCAL_CALLER, { repo: "api", page: "nope" });
    const nobody: AccessPolicy = { readableRepos: async () => new Set() };
    const hidden = await getPage({ store, access: nobody }, LOCAL_CALLER, { repo: "api" });

    expect(noWiki).toMatchObject({ ok: false, text: "api has no wiki yet. Generate it with: brain wiki api" });
    expect(noPage.text).toBe('api has no page "nope". Pages: overview, build-run-test, api.');
    expect(hidden.text).toBe('No readable repo named "api". No repos are enrolled yet.');
  });

  it("puts the wiki on the repo card", async () => {
    const { store, deps } = await setup();
    const before = await repoCard(deps, LOCAL_CALLER, "api", "concise");
    await generateWiki(store, fakeRunner().runner, "api");
    const after = await repoCard(deps, LOCAL_CALLER, "api", "concise");

    expect(before.text).toContain("Wiki: not generated yet (brain wiki api)");
    expect(after.text).toContain("Wiki: 3 pages (overview, build-run-test, api) · read with brain_get");
  });
});
