import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { enrolRepo } from "../src/ingest/registry.js";
import { syncRepo } from "../src/ingest/sync.js";
import { LOCAL_CALLER, LocalAccessPolicy, type AccessPolicy } from "../src/serve/access.js";
import { getPage } from "../src/serve/tools/get-page.js";
import { repoCard } from "../src/serve/tools/repo-card.js";
import { SqliteStore } from "../src/store/sqlite.js";
import { generateWiki } from "../src/ai/generate.js";
import { writeDroppedReport } from "../src/report.js";
import { claudeArgs, parseClaudeResult, type RunRequest, type Runner } from "../src/ai/runner.js";
import { commit, git, repoFromFixture } from "./helpers.js";

const RECORDED = readFileSync(fileURLToPath(new URL("./fixtures/wiki/claude-pages-result.json", import.meta.url)), "utf8");

/**
 * Answers like Claude Code did, one recorded result per run (the last repeats), and remembers
 * what it was asked and what it could see.
 */
function fakeRunner(...outputs: string[]) {
  const answers = outputs.length ? outputs : [RECORDED];
  const seen: { request: RunRequest; files: Record<string, string | null> }[] = [];
  const runner: Runner = {
    async run<T>(request: RunRequest) {
      const read = (path: string) => (existsSync(join(request.cwd, path)) ? readFileSync(join(request.cwd, path), "utf8") : null);
      seen.push({ request, files: { "src/articles.ts": read("src/articles.ts"), "NOTES.md": read("NOTES.md") } });
      return parseClaudeResult<T>(answers[Math.min(seen.length, answers.length) - 1]!);
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
    // The prompt goes on stdin, so a long one doesn't pass Windows' command-line limit.
    expect(args).not.toContain("p");
    const inline = claudeArgs({ cwd: ".", prompt: "p", schema: { type: "object" }, model: "haiku", explore: false });
    expect(inline[inline.indexOf("--tools") + 1]).toBe("");
    expect(inline).not.toContain("--allowedTools");
  });

  it("reads a recorded result, and refuses errors and missing output", () => {
    const result = parseClaudeResult<{ pages: unknown[] }>(RECORDED);

    expect(result).toMatchObject({ costUsd: 0.42, durationMs: 41250, model: "claude-sonnet-5" });
    expect(result.output.pages).toHaveLength(5);
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
      ["conventions", sha, "claude-sonnet-5"],
      ["api", sha, "claude-sonnet-5"],
      ["product", sha, "claude-sonnet-5"],
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

    await expect(generateWiki(store, fakeRunner(bad).runner, "api", { full: true })).rejects.toThrow(/malformed/);
    expect(store.pages("api").map((p) => p.slug)).toEqual(["overview", "build-run-test", "conventions", "api", "product"]);
  });

  it("checks every citation and stores what it found on each page", async () => {
    const { store } = await setup();

    const wiki = await generateWiki(store, fakeRunner().runner, "api");

    expect(wiki.reports.map((r) => [r.slug, r.claims, r.removed.length, r.published])).toEqual([
      ["overview", 1, 0, true],
      ["build-run-test", 1, 0, true],
      ["conventions", 1, 0, true],
      ["api", 2, 0, true],
      ["product", 1, 0, true],
    ]);
    expect(store.pages("api").map((p) => [p.slug, p.claims, p.removed])).toEqual([
      ["overview", 1, 0],
      ["build-run-test", 1, 0],
      ["conventions", 1, 0],
      ["api", 2, 0],
      ["product", 1, 0],
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

    const wiki = await generateWiki(store, fakeRunner(next).runner, "api", { full: true });

    // The pages the run left out are asked for again; when that fails too, their old versions stay.
    expect(wiki.reports.map((r) => [r.slug, r.published])).toEqual([["overview", false], ["api", true], ["build-run-test", false], ["conventions", false], ["product", false]]);
    expect(store.pages("api").map((p) => p.slug)).toEqual(["overview", "api", "build-run-test", "conventions", "product"]);
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

    await expect(generateWiki(store, fakeRunner(bad).runner, "api", { full: true })).rejects.toThrow(/No page passed the citation check.*overview: 0\/1/);
    expect(store.pages("api").map((p) => p.slug)).toEqual(["overview", "build-run-test", "conventions", "api", "product"]);
  });

  describe("facts a full rewrite dropped", () => {
    const base: { slug: string; title: string; markdown: string }[] = JSON.parse(RECORDED).structured_output.pages;
    const DELETE = "`DELETE /articles/:slug` removes one; auth is required [src/articles.ts:4].";
    /** The recorded wiki with these pages replaced, as a full rewrite's answer. */
    const rewrite = (...pages: { slug: string; title: string; markdown: string }[]) =>
      recorded([...base.filter((b) => !pages.some((p) => p.slug === b.slug)), ...pages]);
    // The overview no longer cites line 4, nor does the api page below.
    const overview = { slug: "overview", title: "Overview", markdown: "# Overview\n\n`articles-api` is an Express API serving articles [README.md:1; src/articles.ts:1-2]." };
    const api = { slug: "api", title: "API", markdown: "# API\n\n- `GET /articles/:slug` returns one article; auth is optional [src/articles.ts:3]." };

    it("lists a fact the old wiki cited, the new one doesn't, and the code still shows", async () => {
      const { store } = await setup();
      const first = await generateWiki(store, fakeRunner().runner, "api");

      const wiki = await generateWiki(store, fakeRunner(rewrite(overview, api)).runner, "api", { full: true });

      expect(first.dropped).toEqual([]);
      expect(wiki.dropped).toEqual([{ slug: "api", claim: `- ${DELETE}`, cites: ["src/articles.ts:4"], kind: "lost", moved: ["src/articles.ts:4"] }]);
    });

    it("says the code changed for one whose cited lines changed since", async () => {
      const { store, dir } = await setup();
      await generateWiki(store, fakeRunner().runner, "api");
      commit(dir, { "src/articles.ts": readFileSync(join(dir, "src/articles.ts"), "utf8").replace("router.delete", "router.purge") });
      await syncRepo(store, "api");

      const wiki = await generateWiki(store, fakeRunner(rewrite(overview, api)).runner, "api", { full: true });

      expect(wiki.dropped).toEqual([{ slug: "api", claim: `- ${DELETE}`, cites: ["src/articles.ts:4"], kind: "code-changed", moved: [] }]);
    });

    it("moves an older page's citations with the lines added above them before comparing", async () => {
      const { store, dir } = await setup();
      await generateWiki(store, fakeRunner().runner, "api");
      commit(dir, { "src/articles.ts": `// Articles.\n${readFileSync(join(dir, "src/articles.ts"), "utf8")}` });
      await syncRepo(store, "api");
      // The same facts, a line further down; the overview no longer cites the code.
      const shifted = rewrite(
        { slug: "overview", title: "Overview", markdown: "# Overview\n\n`articles-api` is an Express API serving articles [README.md:1]." },
        { slug: "api", title: "API", markdown: `# API\n\n- \`GET /articles/:slug\` returns one article; auth is optional [src/articles.ts:4].\n- ${DELETE.replace(":4]", ":5]")}` },
      );

      const wiki = await generateWiki(store, fakeRunner(shifted).runner, "api", { full: true });

      expect(wiki.dropped).toEqual([]);
    });

    it("tells one restated with other lines from one lost, and shows the claim that restates it", async () => {
      const { store } = await setup();
      await generateWiki(store, fakeRunner().runner, "api");
      const routes = { slug: "routes", title: "Routes", markdown: "# Routes\n\n- `DELETE /articles/:slug` is declared on the router [src/articles.ts:1]." };

      const wiki = await generateWiki(store, fakeRunner(rewrite(overview, api, routes)).runner, "api", { full: true });

      expect(wiki.dropped).toEqual([
        {
          slug: "api",
          claim: `- ${DELETE}`,
          cites: ["src/articles.ts:4"],
          kind: "restated",
          moved: ["src/articles.ts:4"],
          match: { slug: "routes", claim: "- `DELETE /articles/:slug` is declared on the router [src/articles.ts:1]." },
        },
      ]);
    });

    it("tells a claim without names restated in most of its words from one sharing a word", async () => {
      const { store } = await setup();
      await generateWiki(store, fakeRunner().runner, "api");
      // Nothing else cites README.md:3, where the old product page's claim is.
      const elsewhere = (product: string) =>
        rewrite(
          overview,
          { slug: "build-run-test", title: "Build, run and test", markdown: "# Build, run and test\n\nThe repository declares no build or test scripts [README.md:1]." },
          { slug: "conventions", title: "Conventions", markdown: "# Conventions\n\nThe repository documents no coding conventions [README.md:1]." },
          { slug: "product", title: "Product", markdown: `# Product\n\n${product} [README.md:1].` },
        );

      const restated = await generateWiki(store, fakeRunner(elsewhere("Readers can look up articles and remove them")).runner, "api", { full: true });
      await generateWiki(store, fakeRunner().runner, "api", { full: true });
      const gone = await generateWiki(store, fakeRunner(elsewhere("Readers browse the catalogue")).runner, "api", { full: true });

      expect(restated.dropped.filter((f) => f.slug === "product").map((f) => [f.kind, f.match?.slug])).toEqual([["restated", "product"]]);
      expect(gone.dropped.filter((f) => f.slug === "product").map((f) => f.kind)).toEqual(["lost"]);
    });

    it("tells a fact on a renamed page from one on a removed page", async () => {
      const { store } = await setup();
      const access = { slug: "access", title: "Access", markdown: "# Access\n\n- Removing an article needs `auth.required` [src/articles.ts:4]." };
      const permissions = { slug: "permissions", title: "Permissions", markdown: "# Permissions\n\n- `GET /articles/:slug` lets anyone read [src/articles.ts:3]." };
      const onAccess = (wiki: { dropped: { slug: string }[] }) => wiki.dropped.filter((f) => f.slug === "access");

      await generateWiki(store, fakeRunner(rewrite(access)).runner, "api", { full: true });
      const renamed = await generateWiki(store, fakeRunner(rewrite(overview, api, permissions)).runner, "api", { full: true });
      await generateWiki(store, fakeRunner(rewrite(access)).runner, "api", { full: true });
      const removed = await generateWiki(store, fakeRunner(rewrite(overview, api)).runner, "api", { full: true });

      expect(onAccess(renamed)).toEqual([expect.objectContaining({ kind: "page-renamed", match: { slug: "permissions" } })]);
      expect(onAccess(removed)).toEqual([expect.objectContaining({ kind: "page-removed" })]);
      expect(removed.dropped.find((f) => f.slug === "api")?.kind).toBe("lost");
    });

    it("writes the full list to a file, real losses first, with a JSON copy", async () => {
      const { store } = await setup();
      const access = { slug: "access", title: "Access", markdown: "# Access\n\n- Removing an article needs `auth.required` [src/articles.ts:4]." };
      await generateWiki(store, fakeRunner(rewrite(access)).runner, "api", { full: true });
      const wiki = await generateWiki(store, fakeRunner(rewrite(overview, api)).runner, "api", { full: true });
      const dir = mkdtempSync(join(tmpdir(), "brain-reports-"));

      const path = writeDroppedReport(wiki, dir);
      const text = readFileSync(path, "utf8");
      const json = JSON.parse(readFileSync(path.replace(/\.md$/, ".json"), "utf8"));

      expect(path.startsWith(join(dir, "api", `dropped-${wiki.commit.slice(0, 7)}-`))).toBe(true);
      expect(text.indexOf("## Lost")).toBeGreaterThan(0);
      expect(text.indexOf("## Lost")).toBeLessThan(text.indexOf("## On removed pages"));
      expect(text).toContain(`  > - ${DELETE}`);
      expect(text).toContain("| api | 1 | 0 | yes |");
      expect(json.counts).toMatchObject({ lost: 1, "page-removed": 1, restated: 0 });
      expect(json.dropped).toHaveLength(2);
    });

    it("doesn't list one the new wiki cites on another page", async () => {
      const { store } = await setup();
      await generateWiki(store, fakeRunner().runner, "api");
      const moved = { slug: "routes", title: "Routes", markdown: `# Routes\n\n- ${DELETE}` };

      const wiki = await generateWiki(store, fakeRunner(rewrite(overview, api, moved)).runner, "api", { full: true });

      expect(wiki.pages.map((p) => p.slug)).toContain("routes");
      expect(wiki.dropped).toEqual([]);
    });

    it("lists nothing for an update", async () => {
      const { store, dir } = await setup();
      await generateWiki(store, fakeRunner().runner, "api");
      commit(dir, { "src/articles.ts": readFileSync(join(dir, "src/articles.ts"), "utf8").replace("auth.required, remove", "auth.required, audited, remove") });
      await syncRepo(store, "api");

      const wiki = await generateWiki(store, fakeRunner(recorded([overview, api])).runner, "api");

      expect(wiki.mode).toBe("update");
      expect(wiki.dropped).toEqual([]);
    });
  });

  it("asks for a sync first when the repo hasn't been indexed", async () => {
    const store = new SqliteStore(":memory:");
    await enrolRepo(store, { path: repoFromFixture("articles-api"), name: "api" });

    await expect(generateWiki(store, fakeRunner().runner, "api")).rejects.toThrow(/brain sync api/);
  });
});

describe("updating the wiki", () => {
  /** For when no AI run may happen. */
  const never: Runner = {
    async run() {
      throw new Error("no AI run expected");
    },
  };
  const overview = { slug: "overview", title: "Overview", markdown: "# Overview\n\n`articles-api` is an Express API serving articles [README.md:1; src/articles.ts:1-5]." };
  const goodApi = { slug: "api", title: "API", markdown: "# API\n\n- `GET /articles/:slug` returns one article [src/articles.ts:3]." };
  const badApi = { slug: "api", title: "API", markdown: "# API\n\nEvents go to `Kafka` [src/articles.ts:3]. Results are cached in `Redis` [src/articles.ts:4]." };

  /** A wiki at the first commit, then a commit changing `files`, synced. */
  async function changed(files: Record<string, string>) {
    const { store, dir, sha, deps } = await setup();
    await generateWiki(store, fakeRunner().runner, "api");
    const next = commit(dir, files);
    await syncRepo(store, "api");
    return { store, dir, sha, next, deps };
  }
  const articles = () => readFileSync(fileURLToPath(new URL("./fixtures/repos/articles-api/src/articles.ts", import.meta.url)), "utf8");
  /** A change to cited lines: every page citing them is rewritten. */
  const editedArticles = () => articles().replace("auth.required, remove", "auth.required, audited, remove");

  it("rewrites only the pages whose cited files changed, and carries the rest forward", async () => {
    const { store, next } = await changed({ "src/articles.ts": editedArticles() });
    const { runner, seen } = fakeRunner(recorded([overview, goodApi]));

    const wiki = await generateWiki(store, runner, "api");

    expect(wiki).toMatchObject({ mode: "update", carried: ["build-run-test", "conventions", "product"] });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.request.prompt).toContain("- M src/articles.ts");
    expect(seen[0]!.request.prompt).toContain('<page slug="api">');
    expect(seen[0]!.request.prompt).not.toContain('<page slug="build-run-test">');
    expect(JSON.stringify(seen[0]!.request.schema)).toContain('"enum":["overview","api"]');
    expect(store.pages("api").map((p) => [p.slug, p.commit])).toEqual([
      ["overview", next],
      ["build-run-test", next],
      ["conventions", next],
      ["api", next],
      ["product", next],
    ]);
    expect(store.pages("api")[3]!.markdown).toBe(goodApi.markdown);
  });

  it("treats a file added beside a cited one as a change to that page", async () => {
    const { store } = await changed({ "src/tags.ts": "export const tags = [];\n" });
    const { runner, seen } = fakeRunner(recorded([overview, goodApi]));

    await generateWiki(store, runner, "api");

    expect(seen[0]!.request.prompt).toContain("- A src/tags.ts");
    expect(seen[0]!.request.prompt).toContain('<page slug="overview">');
    expect(seen[0]!.request.prompt).not.toContain('<page slug="build-run-test">');
  });

  it("runs no AI when nothing the pages cite changed, and moves them to the new commit", async () => {
    const { store, next } = await changed({ "docs/notes.md": "uncited" });

    const wiki = await generateWiki(store, never, "api");
    const again = await generateWiki(store, never, "api");

    expect(wiki).toMatchObject({ reports: [], carried: ["overview", "build-run-test", "conventions", "api", "product"], costUsd: 0 });
    expect(again).toMatchObject({ reports: [], carried: [] });
    expect(store.pages("api").every((p) => p.commit === next)).toBe(true);
  });

  it("moves citations past lines added around them with no AI run, but rewrites a page whose cited file grew a lot", async () => {
    const { store, dir, next } = await changed({ "src/articles.ts": `// header\n${articles()}// audited\n` });

    const wiki = await generateWiki(store, never, "api");

    expect(wiki).toMatchObject({ reports: [], carried: ["overview", "build-run-test", "conventions", "api", "product"] });
    expect(store.pages("api").every((p) => p.commit === next)).toBe(true);
    expect(store.pages("api").find((p) => p.slug === "overview")!.markdown).toContain("[README.md:1; src/articles.ts:2-6]");
    expect(store.pages("api").find((p) => p.slug === "api")!.markdown).toContain("[src/articles.ts:4]");

    commit(dir, { "src/articles.ts": `${articles()}${"// more\n".repeat(12)}` });
    await syncRepo(store, "api");
    const { runner, seen } = fakeRunner(recorded([overview, goodApi]));
    await generateWiki(store, runner, "api");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.request.prompt).toContain('<page slug="api">');
  });

  it("writes a failing page once more, telling the AI what the check removed", async () => {
    const { store } = await changed({ "src/articles.ts": editedArticles() });
    const { runner, seen } = fakeRunner(recorded([overview, badApi]), recorded([goodApi]));

    const wiki = await generateWiki(store, runner, "api");

    expect(seen).toHaveLength(2);
    expect(seen[1]!.request.prompt).toContain("`Kafka` isn't in the cited lines");
    expect(JSON.stringify(seen[1]!.request.schema)).toContain('"enum":["api"]');
    expect(wiki.reports.map((r) => [r.slug, r.published, r.attempts])).toEqual([
      ["overview", true, 1],
      ["api", true, 2],
    ]);
    expect(store.pages("api")[3]!.markdown).toBe(goodApi.markdown);
  });

  it("keeps the last good page when the second attempt fails too, and says so", async () => {
    const { store, sha, next, deps } = await changed({ "src/articles.ts": editedArticles() });
    const before = store.pages("api")[3]!;

    const wiki = await generateWiki(store, fakeRunner(recorded([overview, badApi]), recorded([badApi])).runner, "api");
    const list = await getPage(deps, LOCAL_CALLER, { repo: "api" });
    const page = await getPage(deps, LOCAL_CALLER, { repo: "api", page: "api" });
    const card = await repoCard(deps, LOCAL_CALLER, "api", "concise");

    expect(wiki.reports.map((r) => [r.slug, r.published, r.attempts])).toEqual([
      ["overview", true, 1],
      ["api", false, 2],
    ]);
    expect(store.pages("api").map((p) => p.commit)).toEqual([next, next, next, sha, next]);
    expect(store.pages("api")[3]).toEqual(before);
    const kept = `kept from @${sha.slice(0, 7)}: its rewrite at @${next.slice(0, 7)} failed the citation check`;
    expect(list.text.split("\n").find((line) => /^\s+api\s/.test(line))).toContain(`(${kept})`);
    expect(page.text).toContain(`Note: ${kept}, so this older version is shown.`);
    expect(card.text).not.toContain("older than the index");
  });

  it("rewrites every page when the commit they describe can't be compared", async () => {
    const { store } = await changed({ "docs/notes.md": "uncited" });
    store.replacePages("api", store.pages("api").map((p) => ({ ...p, commit: "0".repeat(40) })));
    const { runner, seen } = fakeRunner();

    const wiki = await generateWiki(store, runner, "api");

    expect(seen[0]!.request.prompt).toContain("can't be compared");
    expect(wiki.reports.map((r) => r.slug)).toEqual(["overview", "build-run-test", "conventions", "api", "product"]);
  });
});

describe("brain_get", () => {
  it("lists the pages, then returns one stamped with its commit and tier", async () => {
    const { store, sha, deps } = await setup();
    await generateWiki(store, fakeRunner().runner, "api");

    const list = await getPage(deps, LOCAL_CALLER, { repo: "api" });
    const page = await getPage(deps, LOCAL_CALLER, { repo: "api", page: "api" });

    expect(list.text).toContain(`api wiki · 5 pages · @${sha.slice(0, 7)} · up to date · llm-generated`);
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
    expect(card.text).toMatch(/Wiki: 5 pages \(overview, build-run-test, conventions, api, product\) · read with brain_get · written at @\w{7}, older than the index/);
  });

  it("reads several pages in one call, each as it would be alone, with a rule between them", async () => {
    const { store, deps } = await setup();
    await generateWiki(store, fakeRunner().runner, "api");

    const one = await getPage(deps, LOCAL_CALLER, { repo: "api", page: "overview" });
    const alone = await getPage(deps, LOCAL_CALLER, { repo: "api", page: ["overview"] });
    const two = await getPage(deps, LOCAL_CALLER, { repo: "api", page: ["overview", "api"] });
    const api = await getPage(deps, LOCAL_CALLER, { repo: "api", page: "api" });

    expect(alone.text).toBe(one.text);
    expect(two).toMatchObject({ ok: true });
    expect(two.text).toBe(`${one.text}\n\n---\n\n${api.text}`);
  });

  it("says in place of a page that isn't one, and fails only when none of them is", async () => {
    const { store, deps } = await setup();
    await generateWiki(store, fakeRunner().runner, "api");

    const some = await getPage(deps, LOCAL_CALLER, { repo: "api", page: ["overview", "nope"] });
    const none = await getPage(deps, LOCAL_CALLER, { repo: "api", page: ["nope", "nada"] });

    const missing = (name: string) => `api has no page "${name}". Pages: overview, build-run-test, conventions, api, product.`;
    expect(some.ok).toBe(true);
    expect(some.text).toContain("api · overview · ");
    expect(some.text.endsWith(`\n\n---\n\n${missing("nope")}`)).toBe(true);
    expect(none).toMatchObject({ ok: false, text: `${missing("nope")}\n${missing("nada")}` });
  });

  it("explains a missing wiki or page, and hides unreadable repos", async () => {
    const { store, deps } = await setup();
    const noWiki = await getPage(deps, LOCAL_CALLER, { repo: "api" });
    await generateWiki(store, fakeRunner().runner, "api");
    const noPage = await getPage(deps, LOCAL_CALLER, { repo: "api", page: "nope" });
    const nobody: AccessPolicy = { readableRepos: async () => new Set() };
    const hidden = await getPage({ store, access: nobody }, LOCAL_CALLER, { repo: "api" });

    expect(noWiki).toMatchObject({ ok: false, text: "api has no wiki yet. Generate it with: brain sync api" });
    expect(noPage.text).toBe('api has no page "nope". Pages: overview, build-run-test, conventions, api, product.');
    expect(hidden.text).toBe('No readable repo named "api". No repos are enrolled yet. Add one with brain_add_repo (a GitHub URL, owner/repo or a local folder).');
  });

  it("puts the wiki on the repo card", async () => {
    const { store, deps } = await setup();
    const before = await repoCard(deps, LOCAL_CALLER, "api", "concise");
    await generateWiki(store, fakeRunner().runner, "api");
    const after = await repoCard(deps, LOCAL_CALLER, "api", "concise");

    expect(before.text).toContain("Wiki: not written yet (brain sync api writes it");
    expect(after.text).toContain("Wiki: 5 pages (overview, build-run-test, conventions, api, product) · read with brain_get");
  });
});
