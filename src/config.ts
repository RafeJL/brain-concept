import { homedir } from "node:os";
import { join } from "node:path";

/** Where the local store lives. BRAIN_DB overrides it (tests, or a second brain). */
export function resolveDbPath(): string {
  return process.env.BRAIN_DB ?? join(homedir(), ".brain", "brain.db");
}
