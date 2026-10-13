import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { git } from "./core/git.js";

/** Where the local store lives. BRAIN_DB overrides it (tests, or a second brain). */
export function resolveDbPath(): string {
  return process.env.BRAIN_DB ?? join(homedir(), ".brain", "brain.db");
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
