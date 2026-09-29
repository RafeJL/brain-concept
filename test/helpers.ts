import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach } from "vitest";

const created: string[] = [];

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

export function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "brain-test-"));
  created.push(dir);
  return dir;
}

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, "-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {
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

/** Writes `files`, deletes `remove`, commits everything, returns the new sha. */
export function commit(dir: string, files: Record<string, string>, message = "change", remove: string[] = []): string {
  writeFiles(dir, files);
  for (const path of remove) git(dir, "rm", "--quiet", path);
  git(dir, "add", "--all");
  git(dir, "commit", "--quiet", "--allow-empty", "-m", message);
  return git(dir, "rev-parse", "HEAD");
}

export function setRemote(dir: string, url: string): void {
  git(dir, "remote", "add", "origin", url);
}
