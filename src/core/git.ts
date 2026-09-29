import { execFile } from "node:child_process";
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
 * The branch to index when none is given: the branch origin/HEAD points at if it exists locally
 * (usually main), otherwise the branch currently checked out.
 */
export async function defaultRef(repoPath: string): Promise<string> {
  const originHead = await tryGit(repoPath, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (originHead) {
    const branch = originHead.replace(/^origin\//, "");
    if (await tryGit(repoPath, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])) return branch;
  }
  const current = await tryGit(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return current && current !== "HEAD" ? current : "HEAD";
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
