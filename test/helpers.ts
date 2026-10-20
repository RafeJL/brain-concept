import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, afterEach, beforeAll } from "vitest";
import type { RunRequest, RunResult, Runner } from "../src/ai/runner.js";
import { updateSeams, type SeamOptions } from "../src/ai/seams.js";
import type { WikiPage } from "../src/core/types.js";
import { enrolRepo } from "../src/ingest/registry.js";
import { syncRepo } from "../src/ingest/sync.js";
import { LOCAL_CALLER, LocalAccessPolicy } from "../src/serve/access.js";
import { createServer, type ServerDeps } from "../src/serve/mcp.js";
import { SqliteStore } from "../src/store/sqlite.js";
import type { Store } from "../src/store/store.js";

/** Folders to delete after each test, and after the test file (for fixtures built once in `beforeAll`). */
const created = { test: [] as string[], file: [] as string[] };
/** Stores to close after each test, before their folders go: Windows won't delete an open database. */
const opened: SqliteStore[] = [];

// Retries: on Windows a background sync can still hold a file for a moment after it finishes.
const remove = (dirs: string[]) => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
};
afterEach(() => {
  for (const store of opened.splice(0)) store.close();
  remove(created.test);
});
afterAll(() => remove(created.file));

/** A throwaway folder, deleted after the test, or after the whole file with `until: "file"`. */
export function tempDir(until: "test" | "file" = "test"): string {
  const dir = mkdtempSync(join(tmpdir(), "brain-test-"));
  created[until].push(dir);
  return dir;
}

/** Runs git in a test repo with a fixed identity and line endings, whatever the machine's config. */
export function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, "-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "core.autocrlf=false", ...args], {
    encoding: "utf8",
  }).trim();
}

export function writeFiles(dir: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
}

/** A throwaway git repo on branch main with one commit containing `files`. */
export function makeRepo(files: Record<string, string>, until: "test" | "file" = "test"): string {
  const dir = tempDir(until);
  git(dir, "init", "--quiet", "--initial-branch=main");
  commit(dir, files, "initial");
  return dir;
}

const FIXTURE_REPOS = fileURLToPath(new URL("./fixtures/repos/", import.meta.url));
const FIXTURE_CHANGES = fileURLToPath(new URL("./fixtures/changes/", import.meta.url));

/** Every file under `root`, keyed by its path relative to it with forward slashes. */
function readTree(root: string, dir = root): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) Object.assign(files, readTree(root, full));
    else files[relative(root, full).replace(/\\/g, "/")] = readFileSync(full, "utf8");
  }
  return files;
}

/** A throwaway git repo holding a copy of test/fixtures/repos/<name>. */
export function repoFromFixture(name: string, until: "test" | "file" = "test"): string {
  return makeRepo(readTree(join(FIXTURE_REPOS, name)), until);
}

/** Commits test/fixtures/changes/<name> on top of a repo, returns the new sha. */
export function commitFixture(dir: string, name: string): string {
  return commit(dir, readTree(join(FIXTURE_CHANGES, name)), name);
}

/** Writes `files`, deletes `remove`, commits everything, returns the new sha. */
export function commit(dir: string, files: Record<string, string>, message = "change", remove: string[] = []): string {
  writeFiles(dir, files);
  for (const path of remove) git(dir, "rm", "--quiet", path);
  git(dir, "add", "--all");
  git(dir, "commit", "--quiet", "--allow-empty", "-m", message);
  return git(dir, "rev-parse", "HEAD");
}

/** A clone of `source`, so it has an `origin` and `origin/HEAD` like a real checkout. */
export function cloneRepo(source: string): string {
  const dir = tempDir();
  execFileSync("git", ["-c", "core.autocrlf=false", "clone", "--quiet", source, dir]);
  return dir;
}

/** Polls until `condition` holds, for things that happen in the background. */
export async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out after ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

export function setRemote(dir: string, url: string): void {
  git(dir, "remote", "add", "origin", url);
}

const FIXTURE_SEAMS = fileURLToPath(new URL("./fixtures/seams/", import.meta.url));

/**
 * A Runner that answers every run with `output`, as Claude Code's structured output, and records
 * the requests. `output` can be a function of the request and its number (from 1), to answer each
 * run differently; one that throws fails that run.
 */
export function recordedRunner(output: (request: RunRequest, n: number) => unknown): { runner: Runner; requests: RunRequest[] };
export function recordedRunner(output: unknown): { runner: Runner; requests: RunRequest[] };
export function recordedRunner(output: unknown) {
  const requests: RunRequest[] = [];
  const runner: Runner = {
    async run<T>(request: RunRequest): Promise<RunResult<T>> {
      requests.push(request);
      const answer = typeof output === "function" ? output(request, requests.length) : output;
      return { output: answer as T, costUsd: 0.05, durationMs: 1000, model: "claude-sonnet-5" };
    },
  };
  return { runner, requests };
}

/** The recorded answer in test/fixtures/seams/<name>.json. */
export function recordedSeams(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURE_SEAMS, `${name}.json`), "utf8"));
}

/** Maps a synced repo's routes and calls as Claude Code would, from test/fixtures/seams/<fixture>.json. */
export async function mapSeams(store: Store, name: string, fixture = name, options: SeamOptions = { full: true }) {
  return updateSeams(store, recordedRunner(recordedSeams(fixture)).runner, name, options);
}

/**
 * A store built once per file by `build` (in `beforeAll`, so repos it makes need until "file"),
 * returning a function that gives each test its own copy. The copies point at the same repo
 * folders, so a test that commits to a repo needs its own instead.
 */
export function sharedStore(build: (store: SqliteStore) => Promise<Record<string, string> | void>) {
  let template = "";
  let dirs: Record<string, string> = {};
  beforeAll(async () => {
    template = join(tempDir("file"), "template.db");
    const store = new SqliteStore(template);
    try {
      dirs = (await build(store)) ?? {};
    } finally {
      store.close();
    }
  }, 120_000);
  return () => {
    const copy = join(tempDir(), "brain.db");
    copyFileSync(template, copy);
    const store = new SqliteStore(copy);
    opened.push(store);
    return { store, dirs, deps: { store, access: new LocalAccessPolicy() } };
  };
}

/**
 * Fixture repos enrolled, synced and mapped from their recorded answers, once per file; each test
 * gets its own copy of the store. A repo is a fixture name, or [name, fixture] to enrol it as `name`.
 */
export function fixtureWorld(repos: (string | [name: string, fixture: string])[]) {
  return sharedStore(async (store) => {
    const dirs: Record<string, string> = {};
    for (const repo of repos) {
      const [name, fixture] = typeof repo === "string" ? [repo, repo] : repo;
      dirs[name] = repoFromFixture(fixture, "file");
      await enrolRepo(store, { path: dirs[name], name });
      await syncRepo(store, name);
      await mapSeams(store, name, fixture);
    }
    return dirs;
  });
}

/** An MCP client connected in memory to a brain server over `store`, with any other server options. */
export async function connect(store: Store, options: Partial<ServerDeps> = {}): Promise<Client> {
  const server = createServer({ store, access: new LocalAccessPolicy(), caller: LOCAL_CALLER, ...options });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientSide);
  return client;
}

/** A wiki page as a sync stores it. Serving pages doesn't re-check citations. */
export function page(repo: string, slug: string, title: string, markdown: string, commitSha = "0".repeat(40)): WikiPage {
  return { repo, slug, title, kind: "core", markdown, commit: commitSha, claims: 1, removed: 0, model: "claude-sonnet-5", costUsd: 0.1, generatedAt: "2026-10-07T00:00:00Z" };
}

/** A function capping how many authors a reader follows at 500, for facts about it. */
export const FOLLOW = ["export function follow(user, author) {", "  if (user.following.length >= 500) throw new Error('limit');", "  user.following.push(author);", "}", ""].join("\n");

/** A synced repo "web" holding FOLLOW in src/follow.ts. */
export async function followRepo() {
  const store = new SqliteStore(":memory:");
  const dir = makeRepo({ "src/follow.ts": FOLLOW, "README.md": "# web\n" });
  await enrolRepo(store, { path: dir, name: "web" });
  await syncRepo(store, "web");
  return { store, dir };
}
