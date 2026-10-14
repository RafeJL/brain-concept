import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { BrainError } from "./types.js";

const run = promisify(execFile);

/** Runs git in a repo without a shell, so paths and refs are never interpreted by one. */
export async function git(repoPath: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await run("git", ["-C", repoPath, ...args], {
      maxBuffer: 512 * 1024 * 1024,
      windowsHide: true,
    });
    return stdout;
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") throw new BrainError("git isn't installed or isn't on PATH. Install it, then check with: brain doctor");
    throw error;
  }
}

/** git's output, or null when git says no (an unknown ref, not a repo). A missing git still throws. */
async function tryGit(repoPath: string, args: string[]): Promise<string | null> {
  try {
    return (await git(repoPath, args)).trim();
  } catch (error) {
    if (error instanceof BrainError) throw error;
    return null;
  }
}

/** Top-level folder of the repo containing `path`. */
export async function repoRoot(path: string): Promise<string> {
  const root = await tryGit(path, ["rev-parse", "--show-toplevel"]);
  if (!root) throw new BrainError(`${path} is not inside a git repository.`);
  return root;
}

/**
 * The ref to index when none is given: what origin/HEAD points at (usually `origin/main`), because
 * the brain describes what has been merged, and a fetch keeps it current even if the local branch
 * is never checked out. Without a remote, the branch currently checked out.
 */
export async function defaultRef(repoPath: string): Promise<string> {
  const originHead = await tryGit(repoPath, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (originHead && (await tryGit(repoPath, ["rev-parse", "--verify", "--quiet", `${originHead}^{commit}`]))) return originHead;
  const current = await tryGit(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return current && current !== "HEAD" ? current : "HEAD";
}

/** `main` → `refs/heads/main`, `origin/main` → `refs/remotes/origin/main`; null if it isn't a ref. */
export async function fullRefName(repoPath: string, ref: string): Promise<string | null> {
  return (await tryGit(repoPath, ["rev-parse", "--symbolic-full-name", ref])) || null;
}

/** Where git looks for this repo's hooks, honouring `core.hooksPath`. Absolute. */
export async function hooksDir(repoPath: string): Promise<string> {
  return resolve(repoPath, (await git(repoPath, ["rev-parse", "--git-path", "hooks"])).trim());
}

/** The repo's .git directory, absolute (the common one for worktrees). */
export async function gitDir(repoPath: string): Promise<string> {
  return resolve(repoPath, (await git(repoPath, ["rev-parse", "--git-common-dir"])).trim());
}

export async function resolveCommit(repoPath: string, ref: string): Promise<string> {
  const sha = await tryGit(repoPath, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  if (!sha) throw new BrainError(`Ref "${ref}" does not resolve to a commit in ${repoPath}.`);
  return sha;
}

export interface TreeEntry {
  path: string;
  blob: string;
  bytes: number;
}

/** Every blob in the committed tree at `commit`. Submodules are skipped. */
export async function listTree(repoPath: string, commit: string): Promise<TreeEntry[]> {
  const out = await git(repoPath, ["ls-tree", "-r", "-l", "-z", commit]);
  const entries: TreeEntry[] = [];
  for (const record of out.split("\0")) {
    if (!record) continue;
    // "<mode> <type> <object> <size>\t<path>"
    const tab = record.indexOf("\t");
    const [, type, object, size] = record.slice(0, tab).split(/\s+/);
    if (type !== "blob" || !object) continue;
    entries.push({ path: record.slice(tab + 1), blob: object, bytes: Number(size) || 0 });
  }
  return entries;
}

/** Commits reachable from `to` but not from `from`, or null if either is unknown. */
export async function countCommits(repoPath: string, from: string, to: string): Promise<number | null> {
  const out = await tryGit(repoPath, ["rev-list", "--count", `${from}..${to}`]);
  return out === null ? null : Number(out);
}

export interface ChangedFile {
  path: string;
  /** A added, M modified, D deleted, T type changed. Renames show as a delete plus an add. */
  status: "A" | "M" | "D" | "T";
}

/** Files that differ between two commits, or null if either commit is unknown here. */
export async function changedFiles(repoPath: string, from: string, to: string): Promise<ChangedFile[] | null> {
  const out = await tryGit(repoPath, ["diff", "--name-status", "--no-renames", "-z", from, to]);
  if (out === null) return null;
  const parts = out.split("\0").filter(Boolean);
  const files: ChangedFile[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) files.push({ status: parts[i]![0] as ChangedFile["status"], path: parts[i + 1]! });
  return files;
}

/** A file's lines at a commit, or null when it isn't a file there. */
export async function fileAtCommit(repoPath: string, commit: string, path: string): Promise<string[] | null> {
  const out = await tryGit(repoPath, ["show", `${commit}:${path}`]);
  return out === null ? null : out.split(/\r?\n/);
}

/** One changed run of lines: `oldLines` lines from `oldStart` became `newLines` lines (0 means none). */
export interface Hunk {
  oldStart: number;
  oldLines: number;
  newLines: number;
}

/**
 * How each of `paths` changed between two commits, line by line: its hunks, or "deleted". A path
 * that didn't change is absent. Null if either commit is unknown here.
 */
export async function changedLines(repoPath: string, from: string, to: string, paths: readonly string[]): Promise<Map<string, Hunk[] | "deleted"> | null> {
  const out = await tryGit(repoPath, ["diff", "--unified=0", "--no-renames", "--no-color", from, to, "--", ...paths]);
  if (out === null) return null;
  const changes = new Map<string, Hunk[] | "deleted">();
  let file: string | null = null;
  for (const line of out.split("\n")) {
    const header = /^--- (?:a\/(.+)|\/dev\/null)$/.exec(line);
    if (header) {
      file = header[1] ?? null;
      continue;
    }
    if (line === "+++ /dev/null" && file) changes.set(file, "deleted");
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
    if (hunk && file && changes.get(file) !== "deleted") {
      const hunks = (changes.get(file) as Hunk[] | undefined) ?? [];
      hunks.push({ oldStart: Number(hunk[1]), oldLines: Number(hunk[2] ?? 1), newLines: Number(hunk[3] ?? 1) });
      changes.set(file, hunks);
    }
  }
  return changes;
}

/**
 * Clones `url` into `dir` with the person's own git credentials (their credential manager or SSH
 * key). Never waits on a terminal prompt nobody will see; a failure says what git said.
 */
export async function cloneInto(url: string, dir: string): Promise<void> {
  try {
    await run("git", ["clone", "--quiet", "--", url, dir], { windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") throw new BrainError("git isn't installed or isn't on PATH. Install it, then check with: brain doctor");
    const said = String((error as { stderr?: string }).stderr ?? "").trim().split(/\r?\n/).filter(Boolean).slice(-2).join(" ");
    throw new BrainError(`git clone ${stripCredentials(url)} failed: ${redact(said) || "no reason given"}`);
  }
}

/** Takes user:token out of any URL in git's messages. */
function redact(text: string): string {
  return text.replace(/(https?:\/\/)[^/\s@]+@/gi, "$1");
}

export async function remoteUrl(repoPath: string): Promise<string | null> {
  const url = await tryGit(repoPath, ["config", "--get", "remote.origin.url"]);
  return url ? stripCredentials(url) : null;
}

/** Removes user:token from an https remote so it is never stored or shown. */
export function stripCredentials(url: string): string {
  if (!/^https?:\/\//i.test(url)) return url;
  try {
    const parsed = new URL(url);
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    return url;
  }
}

/** Runs `work` in `cwd` when given (a worktree of `commit` someone else made), or in one made for it. */
export async function inWorktree<T>(repoPath: string, commit: string, cwd: string | undefined, work: (dir: string) => Promise<T>): Promise<T> {
  return cwd ? work(cwd) : withWorktree(repoPath, commit, work);
}

/**
 * Runs `work` in a temporary, detached worktree of `repoPath` at `commit`, then removes it. Lets
 * tools that read files from disk see exactly the committed tree the brain indexed, never the
 * developer's uncommitted work.
 */
export async function withWorktree<T>(repoPath: string, commit: string, work: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "brain-worktree-"));
  await git(repoPath, ["worktree", "add", "--detach", "--quiet", dir, commit]);
  try {
    return await work(dir);
  } finally {
    await tryGit(repoPath, ["worktree", "remove", "--force", dir]);
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}
