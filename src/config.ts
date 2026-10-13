import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { git } from "./core/git.js";

/** Where the local store lives. BRAIN_DB overrides it (tests, or a second brain). */
export function resolveDbPath(): string {
  return process.env.BRAIN_DB ?? join(homedir(), ".brain", "brain.db");
}

/** The per-repo sync locks, beside the store so a second store has its own. */
export function locksDir(dbPath = resolveDbPath()): string {
  return join(dirname(dbPath), "locks");
}

/** Where background syncs and enrolments append their output. */
export function hooksLogPath(dbPath = resolveDbPath()): string {
  return join(dirname(dbPath), "hooks.log");
}

/** Where repos added from GitHub are cloned: BRAIN_REPOS, or `repos` beside the store. */
export function clonesDir(dbPath = resolveDbPath()): string {
  return process.env.BRAIN_REPOS ?? join(dirname(dbPath), "repos");
}

/**
 * The person using the brain on this machine, for the name on facts they confirm: their git
 * user.name, or their login name. Hosted, it comes from the caller's identity instead.
 */
export async function localPerson(): Promise<string> {
  try {
    const name = (await git(homedir(), ["config", "--global", "user.name"])).trim();
    if (name) return name;
  } catch {
    // No git name set: fall back to the login name.
  }
  return userInfo().username;
}
