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
