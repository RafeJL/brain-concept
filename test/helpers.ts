import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach } from "vitest";
import type { RunRequest, RunResult, Runner } from "../src/ai/runner.js";
import { updateSeams, type SeamOptions } from "../src/ai/seams.js";
import type { Store } from "../src/store/store.js";

const created: string[] = [];

afterEach(() => {
  // Retries: on Windows a background sync can still hold a file for a moment after it finishes.
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

export function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "brain-test-"));
  created.push(dir);
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
export function makeRepo(files: Record<string, string>): string {
  const dir = tempDir();
  git(dir, "init", "--quiet", "--initial-branch=main");
  commit(dir, files, "initial");
  return dir;
}

const FIXTURE_REPOS = fileURLToPath(new URL("./fixtures/repos/", import.meta.url));
const FIXTURE_CHANGES = fileURLToPath(new URL("./fixtures/changes/", import.meta.url));

const BUILD_OUTPUT = new Set(["bin", "obj"]);

/** Every file under `root`, keyed by its path relative to it with forward slashes. */
function readTree(root: string, dir = root): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    // Build output an IDE writes next to fixture projects (dotnet restore) isn't part of the fixture.
    if (entry.isDirectory() && BUILD_OUTPUT.has(entry.name)) continue;
    if (entry.isDirectory()) Object.assign(files, readTree(root, full));
    else files[relative(root, full).replace(/\\/g, "/")] = readFileSync(full, "utf8");
  }
  return files;
}

/** A throwaway git repo holding a copy of test/fixtures/repos/<name>. */
export function repoFromFixture(name: string): string {
  return makeRepo(readTree(join(FIXTURE_REPOS, name)));
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

/** A Runner that answers every run with `output`, as Claude Code's structured output, and records the requests. */
export function recordedRunner(output: unknown) {
  const requests: RunRequest[] = [];
  const runner: Runner = {
    async run<T>(request: RunRequest): Promise<RunResult<T>> {
      requests.push(request);
      return { output: output as T, costUsd: 0.05, durationMs: 1000, model: "claude-sonnet-5" };
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
