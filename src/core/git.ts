import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { BrainError } from "./types.js";

const run = promisify(execFile);

/** Runs git in a repo without a shell, so paths and refs are never interpreted by one. */
export async function git(repoPath: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", ["-C", repoPath, ...args], {
    maxBuffer: 512 * 1024 * 1024,
    windowsHide: true,
  });
  return stdout;
}

async function tryGit(repoPath: string, args: string[]): Promise<string | null> {
  try {
    return (await git(repoPath, args)).trim();
  } catch {
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

/**
 * Reads many blobs through one `git cat-file --batch` process, instead of one process per file
 * (which costs ~20ms each on Windows). Missing blobs are left out of the result.
 */
export async function readBlobs(repoPath: string, blobs: readonly string[]): Promise<Map<string, Buffer>> {
  const result = new Map<string, Buffer>();
  if (blobs.length === 0) return result;

  const child = spawn("git", ["-C", repoPath, "cat-file", "--batch"], { windowsHide: true });
  const chunks: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<void>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`git cat-file exited with ${code}`))));
  });
  child.stdin.end(blobs.join("\n") + "\n");
  await done;

  // Each answer is "<sha> blob <size>\n<content>\n" or "<sha> missing\n".
  const out = Buffer.concat(chunks);
  let offset = 0;
  while (offset < out.length) {
    const newline = out.indexOf(0x0a, offset);
    if (newline < 0) break;
    const [sha, type, size] = out.subarray(offset, newline).toString("utf8").split(" ");
    offset = newline + 1;
    if (type === "missing" || !sha) continue;
    const length = Number(size);
    result.set(sha, out.subarray(offset, offset + length));
    offset += length + 1;
  }
  return result;
}

/** Commits reachable from `to` but not from `from`, or null if either is unknown. */
export async function countCommits(repoPath: string, from: string, to: string): Promise<number | null> {
  const out = await tryGit(repoPath, ["rev-list", "--count", `${from}..${to}`]);
  return out === null ? null : Number(out);
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
