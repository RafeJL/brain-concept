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

/** Where reports too long for the console go (the facts a full rewrite dropped), a folder per repo. */
export function reportsDir(dbPath = resolveDbPath()): string {
  return join(dirname(dbPath), "reports");
}

/** Where repos added from GitHub are cloned: BRAIN_REPOS, or `repos` beside the store. */
export function clonesDir(dbPath = resolveDbPath()): string {
  return process.env.BRAIN_REPOS ?? join(dirname(dbPath), "repos");
}

/** How the HTTP MCP server listens, from BRAIN_HTTP_* (see docs/development.md, "Docker and AWS"). */
export interface HttpConfig {
  host: string;
  port: number;
  token?: string;
  allowedHosts?: string[];
}

export function httpConfig(env: NodeJS.ProcessEnv = process.env): HttpConfig {
  const port = Number(env.BRAIN_HTTP_PORT ?? 8080);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`BRAIN_HTTP_PORT isn't a port: ${env.BRAIN_HTTP_PORT}`);
  const hosts = env.BRAIN_HTTP_ALLOWED_HOSTS?.split(",").map((h) => h.trim()).filter(Boolean);
  return {
    host: env.BRAIN_HTTP_HOST ?? "127.0.0.1",
    port,
    token: env.BRAIN_HTTP_TOKEN || undefined,
    allowedHosts: hosts?.length ? hosts : undefined,
  };
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
