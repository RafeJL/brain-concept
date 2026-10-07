import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fullRefName, gitDir, hooksDir } from "../core/git.js";
import { BrainError } from "../core/types.js";
import type { Store } from "../store/store.js";
import { requireRepo } from "./registry.js";

/**
 * Keeps a repo's index, routes, calls and wiki fresh without anyone running `brain sync`: a git
 * `reference-transaction` hook starts a background `brain sync` whenever the tracked ref moves. It catches pulls, merges,
 * rebases and plain fetches (which have no hook of their own), and never blocks git.
 */

const HOOK = "reference-transaction";
const MARKER = "# citation-brain: managed by `brain hooks`";

export interface HookCommand {
  /** Absolute path to the node executable. */
  node: string;
  /** Absolute path to bin/brain.mjs. */
  brain: string;
  /** Store to sync into; only written into the hook when set, otherwise the default applies. */
  dbPath?: string;
  /** Where background syncs append their output. */
  logPath: string;
  /** Extra `brain sync` flags, e.g. `--no-ai` where no AI should run. */
  syncFlags?: string[];
}

export interface HookStatus {
  repo: string;
  installed: boolean;
  path: string;
  /** Set when a hook of ours can't be installed here, with the reason. */
  problem?: string;
  /** Installed, but not what `brain hooks install` would write now (an older brain wrote it). */
  outdated?: boolean;
}

/** A value quoted for sh, with Windows paths in the forward-slash form git's sh understands. */
function sh(value: string): string {
  return `'${value.replace(/\\/g, "/").replace(/'/g, `'\\''`)}'`;
}

function hookScript(repo: string, trackedRef: string, command: HookCommand): string {
  const env = command.dbPath ? `BRAIN_DB=${sh(command.dbPath)} ` : "";
  const log = sh(command.logPath);
  const flags = (command.syncFlags ?? []).map((flag) => ` ${sh(flag)}`).join("");
  return `#!/bin/sh
${MARKER}
# Re-syncs "${repo}" in the brain (index, routes and calls, wiki) when ${trackedRef} moves. Remove with: brain hooks remove ${repo}
[ "$1" = committed ] || exit 0
awk -v ref=${sh(trackedRef)} '$3 == ref { found = 1 } END { exit !found }' || exit 0
(
  echo "$(date '+%Y-%m-%d %H:%M:%S') ${repo}: ${trackedRef} moved" >> ${log}
  ${env}${sh(command.node)} ${sh(command.brain)} sync ${sh(repo)}${flags} >> ${log} 2>&1
) < /dev/null > /dev/null 2>&1 &
exit 0
`;
}

/** Whether `child` is `parent` or below it. A path on another drive comes back absolute. */
function isInside(child: string, parent: string): boolean {
  const path = relative(parent, child);
  return !path.startsWith("..") && !isAbsolute(path);
}

async function hookLocation(repoPath: string): Promise<{ path: string; problem?: string }> {
  const dir = await hooksDir(repoPath);
  const path = join(dir, HOOK);
  if (isInside(dir, resolve(repoPath)) && !isInside(dir, await gitDir(repoPath))) {
    return {
      path,
      problem:
        `core.hooksPath points inside the repository (${dir}), so installing would change tracked files. ` +
        `Run "brain sync <name>" from your hook manager's ${HOOK} or post-merge hook instead.`,
    };
  }
  if (existsSync(path) && !readFileSync(path, "utf8").includes(MARKER)) {
    return {
      path,
      problem:
        `${path} already exists and isn't the brain's. A ${HOOK} hook reads git's ref list from stdin, ` +
        `which two scripts can't share, so the brain won't add to it. Remove it or merge the two by hand.`,
    };
  }
  return { path };
}

/** Whether the repo has the brain's hook; with `command`, also whether it is out of date. */
export async function hookStatus(store: Store, name: string, command?: HookCommand): Promise<HookStatus> {
  const repo = requireRepo(store, name);
  const { path, problem } = await hookLocation(repo.path);
  const installed = !problem && existsSync(path);
  if (!installed || !command) return { repo: name, installed, path, problem };
  const trackedRef = await fullRefName(repo.path, repo.ref);
  const outdated = !trackedRef || readFileSync(path, "utf8") !== hookScript(name, trackedRef, command);
  return { repo: name, installed, path, outdated };
}

/** Installs (or refreshes) the hook for one repo. Idempotent. */
export async function installHook(store: Store, name: string, command: HookCommand): Promise<string> {
  const repo = requireRepo(store, name);
  const { path, problem } = await hookLocation(repo.path);
  if (problem) throw new BrainError(problem);
  const trackedRef = await fullRefName(repo.path, repo.ref);
  if (!trackedRef) throw new BrainError(`"${repo.ref}" is not a branch or ref, so there is nothing to watch.`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, hookScript(name, trackedRef, command));
  chmodSync(path, 0o755);
  return path;
}

/** Removes the brain's hook from one repo; returns false if there wasn't one. */
export async function removeHook(store: Store, name: string): Promise<boolean> {
  const repo = requireRepo(store, name);
  const path = join(await hooksDir(repo.path), HOOK);
  if (!existsSync(path) || !readFileSync(path, "utf8").includes(MARKER)) return false;
  rmSync(path);
  return true;
}
