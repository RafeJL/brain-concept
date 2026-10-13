import { spawn } from "node:child_process";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { clonesDir } from "../config.js";
import { cloneInto, defaultRef, listTree, remoteUrl, repoRoot, resolveCommit, stripCredentials } from "../core/git.js";
import { processAlive } from "../core/queue.js";
import { BrainError, type Enrolment, type EnrolmentEstimate, type RepoNote, type RepoRecord } from "../core/types.js";
import type { Store } from "../store/store.js";
import type { HookCommand } from "./hooks.js";
import { checkRepoName, enrolRepo } from "./registry.js";

/**
 * Adding a repo from anywhere: a local clone, or a GitHub repo the brain clones for itself. Both
 * `brain add` and `brain_add_repo` come through here. Enrolling takes minutes, so its progress is
 * kept in the store, where the MCP server reads it while a background `brain add` writes it.
 */

/** What to enrol: a local repo at `path`, or a clone of `url` that is (or will be) at `path`. */
export interface Source {
  /** What the person gave. */
  given: string;
  name: string;
  path: string;
  /** What to clone; null for a local repo. */
  url: string | null;
}

export interface Remote {
  url: string;
  name: string;
}

const GITHUB_SSH = /^(?:ssh:\/\/)?git@github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i;
// A browser URL counts too: anything after owner/repo (/tree/main/src, ?tab=readme) is ignored.
const GITHUB_HTTPS = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/?#].*)?$/i;
const OWNER_REPO = /^([A-Za-z0-9][\w.-]*)\/([\w.-]+?)(?:\.git)?$/;
/** Any other git URL: a scheme (https://, ssh://, file://) or scp style (user@host:path). */
const GIT_URL = /^(?:[a-z][a-z0-9+.-]*:\/\/|[\w.-]+@[\w.-]+:)/i;

/**
 * The repo to clone, when `given` names one rather than a local folder: a GitHub URL (with or
 * without `.git`, or a page of it), its SSH form, `owner/repo`, or any other git URL. GitHub repos
 * are cloned over https unless given in SSH form, so each person's own credentials apply. A folder
 * that exists is always taken as one, so `owner/repo` never hides a relative path.
 */
export function parseRemote(given: string, isFolder: (path: string) => boolean = existsSync): Remote | null {
  const text = given.trim();
  const ssh = GITHUB_SSH.exec(text);
  if (ssh) return { url: `git@github.com:${ssh[1]}/${ssh[2]}.git`, name: ssh[2]! };
  const https = GITHUB_HTTPS.exec(text);
  if (https && (/^https?:/i.test(text) || !isFolder(text))) return { url: `https://github.com/${https[1]}/${https[2]}.git`, name: https[2]! };
  if (GIT_URL.test(text)) {
    const name = /([^/:\\]+?)(?:\.git)?\/*$/.exec(text.replace(/[?#].*$/, ""))?.[1];
    return name ? { url: text, name } : null;
  }
  if (isFolder(text)) return null;
  const short = OWNER_REPO.exec(text);
  return short ? { url: `https://github.com/${short[1]}/${short[2]}.git`, name: short[2]! } : null;
}

/** Works out the name and folder for a source. A local one must be a git repo; a remote isn't contacted yet. */
export async function resolveSource(given: string, options: { name?: string; dbPath?: string } = {}): Promise<Source> {
  // An agent passes the source: one starting with "-" would reach git as an option, not a repo.
  if (given.trim().startsWith("-")) throw new BrainError(`"${given}" isn't a folder, a GitHub URL or owner/repo.`);
  const remote = parseRemote(given);
  if (remote) {
    const name = checkRepoName(options.name ?? remote.name);
    return { given, name, path: join(clonesDir(options.dbPath), name), url: remote.url };
  }
  if (!existsSync(given)) throw new BrainError(`There is no folder ${given}, and it isn't a GitHub URL or owner/repo.`);
  const path = await repoRoot(given);
  return { given, name: checkRepoName(options.name ?? basename(path)), path, url: null };
}

/**
 * A path as the file system knows it, when it exists: on Windows a short name such as RAFE~1.LOV
 * (which temp folders use) and git's long one are the same folder.
 */
function realPath(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

/** Whether a repo lives in the brain's own clone folder, so the brain fetches it and may delete it. */
export function isBrainClone(path: string, dbPath?: string): boolean {
  const inside = relative(realPath(clonesDir(dbPath)), realPath(path));
  return inside !== "" && !inside.startsWith("..") && !isAbsolute(inside);
}

/** Two remote URLs for the same repo, whatever their scheme, user, case or `.git`. */
function sameRemote(a: string, b: string): boolean {
  const norm = (url: string) =>
    stripCredentials(url).toLowerCase().replace(/^[a-z+]+:\/\//, "").replace(/^[^@/]+@/, "").replace(":", "/").replace(/(\.git)?\/*$/, "");
  return norm(a) === norm(b);
}

/** Whether `path` is the top of a git repo (not just a folder inside one). */
async function isRepoRoot(path: string): Promise<boolean> {
  try {
    return realPath(await repoRoot(path)).toLowerCase() === realPath(path).toLowerCase();
  } catch (error) {
    if (error instanceof BrainError && /not inside a git repository/.test(error.message)) return false;
    throw error;
  }
}

/** Whether `name` is enrolled and done with: indexed, and not by an enrolment that failed or stopped. Adding it again would do nothing. */
export function fullyEnrolled(store: Store, name: string): boolean {
  const earlier = store.enrolment(name);
  return store.getRepo(name) !== undefined && store.getState(name) !== undefined && (!earlier || earlier.status === "done");
}

/**
 * Refuses a name that is enrolled already, or being enrolled by another process. One enrolled but
 * never indexed (`brain repo add`), or whose enrolment didn't finish, may be added again.
 */
export function checkCanEnrol(store: Store, name: string): void {
  const earlier = store.enrolment(name);
  if (earlier && liveStatus(earlier) === "running" && earlier.pid !== process.pid) {
    throw new BrainError(`${name} is already being enrolled (${earlier.step}), by process ${earlier.pid ?? "?"}.`);
  }
  if (fullyEnrolled(store, name)) throw new BrainError(`A repo named "${name}" is already enrolled.`);
}

/**
 * Turns a source into an enrolled repo. A remote is cloned into the brain's folder first, or a
 * clone of it already there (from a try that failed later) is used. A local repo is enrolled where
 * it is. A repo already enrolled by an enrolment that didn't finish is taken as it is: trying again
 * redoes only what's missing.
 */
export async function enrolSource(store: Store, source: Source, options: { ref?: string; note?: RepoNote; progress?: EnrolmentProgress } = {}): Promise<RepoRecord> {
  const existing = store.getRepo(source.name);
  if (existing) return existing;
  if (source.url) {
    options.progress?.step("cloning it");
    if (!existsSync(source.path)) {
      mkdirSync(dirname(source.path), { recursive: true });
      await cloneInto(source.url, source.path);
    } else if (!(await isRepoRoot(source.path)) || !sameRemote((await remoteUrl(source.path)) ?? "", source.url)) {
      throw new BrainError(`${source.path} already exists and isn't a clone of ${stripCredentials(source.url)}. Remove it, or enrol under another name.`);
    }
  }
  return enrolRepo(store, { path: source.path, name: source.name, ref: options.ref, note: options.note });
}

/** Files in a repo's committed tree at its tracked ref (the default one if not yet enrolled). */
export async function fileCount(path: string, ref?: string): Promise<number> {
  return (await listTree(path, await resolveCommit(path, ref ?? (await defaultRef(path))))).length;
}

/** A first enrolment's cost and time by file count, measured on the trial repos (decisions, 2026-10-07 and B4a). */
const BANDS: { files: number; costUsd: [number, number]; minutes: [number, number] }[] = [
  { files: 300, costUsd: [0.5, 2], minutes: [2, 5] },
  { files: 1000, costUsd: [1, 4], minutes: [5, 10] },
  { files: Infinity, costUsd: [8, 12], minutes: [15, 25] },
];
/** Earlier enrolments count as a guide when within this factor of the repo's size. */
const SIMILAR_SIZE = 3;

/**
 * How long and how much enrolling a repo of this size should take: what the nearest earlier
 * enrolments of a similar size took, when there are any, or else the size bands, labelled rough.
 * Only enrolments that ran Claude Code count.
 */
export function estimateEnrolment(store: Store, files: number): EnrolmentEstimate {
  const distance = (e: Enrolment) => Math.abs(Math.log(e.files! / Math.max(files, 1)));
  const similar = store
    .enrolments()
    .filter((e) => e.status === "done" && e.finishedAt && e.files && e.costUsd > 0 && distance(e) <= Math.log(SIMILAR_SIZE))
    .sort((a, b) => distance(a) - distance(b))
    .slice(0, 3);
  if (similar.length === 0) {
    const band = BANDS.find((b) => files <= b.files)!;
    return { minutes: band.minutes, costUsd: band.costUsd, basis: `rough: from its size alone, ${files} files` };
  }
  const took = similar.map((e) => (Date.parse(e.finishedAt!) - Date.parse(e.startedAt)) / 60_000);
  const lo = Math.max(1, Math.floor(Math.min(...took)));
  const costs = similar.map((e) => e.costUsd);
  const sizes = similar.map((e) => e.files!);
  const earlier = similar.length === 1 ? "an earlier enrolment" : `${similar.length} earlier enrolments`;
  const range = Math.min(...sizes) === Math.max(...sizes) ? `${sizes[0]}` : `${Math.min(...sizes)}–${Math.max(...sizes)}`;
  return {
    minutes: [lo, Math.max(lo + 1, Math.ceil(Math.max(...took)))],
    costUsd: [Math.min(...costs), Math.max(...costs)],
    basis: `from ${earlier} of a similar size (${range} files; this one has ${files})`,
  };
}

/** "$0.50–2", "$0.42". */
export function costText([lo, hi]: readonly [number, number]): string {
  const money = (n: number) => (n >= 10 || Number.isInteger(n) ? String(Math.round(n)) : n.toFixed(2));
  return money(lo) === money(hi) ? `$${money(lo)}` : `$${money(lo)}–${money(hi)}`;
}

/** "roughly 2–5 minutes and $0.50–2 of Claude Code usage (rough: from its size alone, 112 files)". */
export function estimateText(estimate: EnrolmentEstimate): string {
  return `roughly ${estimate.minutes[0]}–${estimate.minutes[1]} minutes and ${costText(estimate.costUsd)} of Claude Code usage (${estimate.basis})`;
}

/** Running, failed or done as recorded; "stopped" when it says running but its process has gone. */
export function liveStatus(e: Enrolment, now = Date.now()): Enrolment["status"] | "stopped" {
  if (e.status !== "running") return e.status;
  // No pid yet: the server writes it straight after starting the process.
  if (e.pid === null) return now - Date.parse(e.updatedAt) < 60_000 ? "running" : "stopped";
  return processAlive(e.pid) ? "running" : "stopped";
}

/** What an enrolment is doing, recorded as it goes so anyone can ask. */
export interface EnrolmentProgress {
  /** One step at a time: "cloning it", "indexing it", "installing its hook". */
  step(text: string): void;
  /** A step that runs beside others (links, wiki, fact checks); null once it's finished. */
  part(name: string, text: string | null): void;
  /** Once the repo's size is known; no estimate when no AI will run. */
  sized(files: number, estimate: EnrolmentEstimate | null): void;
  spent(costUsd: number): void;
  /** `step` names what failed, if not the step it was on. */
  fail(error: string, step?: string): void;
  done(): void;
}

/**
 * Starts recording an enrolment by this process. A row the MCP server wrote when it started this
 * process is carried on, keeping its start time and estimate.
 */
export function trackEnrolment(store: Store, source: Source, now = () => new Date().toISOString()): EnrolmentProgress {
  const earlier = store.enrolment(source.name);
  const ours = earlier?.status === "running" && earlier.pid === process.pid;
  const record: Enrolment = ours
    ? { ...earlier! }
    : {
        repo: source.name,
        source: source.given,
        status: "running",
        step: "starting",
        error: null,
        pid: process.pid,
        files: null,
        estimate: null,
        costUsd: 0,
        startedAt: now(),
        updatedAt: now(),
        finishedAt: null,
      };
  const parts = new Map<string, string>();
  const save = (change: Partial<Enrolment>) => {
    Object.assign(record, change, { updatedAt: now() });
    store.saveEnrolment(record);
  };
  save({});
  return {
    step: (text) => {
      parts.clear();
      save({ step: text });
    },
    part: (name, text) => {
      if (text === null) parts.delete(name);
      else parts.set(name, text);
      if (parts.size) save({ step: [...parts.values()].join("; ") });
    },
    sized: (files, estimate) => save({ files, estimate }),
    spent: (costUsd) => save({ costUsd: record.costUsd + costUsd }),
    fail: (error, step) => save({ status: "failed", error, step: step ?? record.step, finishedAt: now() }),
    done: () => save({ status: "done", step: "ready", error: null, finishedAt: now() }),
  };
}

/** Local time as the hook writes it in the log: 2026-10-13 14:02:11. */
function stamp(date = new Date()): string {
  const two = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`;
}

/**
 * Starts enrolling a repo in a process of its own, the same `brain add` a person would run, so it
 * carries on after the MCP session that asked for it has ended. It logs where background syncs do
 * and syncs under the same per-repo lock. Returns at once with the enrolment as recorded.
 */
export function enrolInBackground(store: Store, source: Source, options: { note?: string; files?: number; estimate?: EnrolmentEstimate; command: HookCommand }): Enrolment {
  const { command } = options;
  const now = new Date().toISOString();
  const record: Enrolment = {
    repo: source.name,
    source: source.given,
    status: "running",
    step: source.url ? "starting: it will be cloned first" : "starting",
    error: null,
    pid: null,
    files: options.files ?? null,
    estimate: options.estimate ?? null,
    costUsd: 0,
    startedAt: now,
    updatedAt: now,
    finishedAt: null,
  };
  store.saveEnrolment(record);
  mkdirSync(dirname(command.logPath), { recursive: true });
  appendFileSync(command.logPath, `${stamp()} ${source.name}: enrolling from ${source.given}\n`);
  const log = openSync(command.logPath, "a");
  try {
    const args = [command.brain, "add", source.url ?? source.path, "--name", source.name, ...(options.note ? ["--note", options.note] : []), ...(command.syncFlags ?? [])];
    const child = spawn(command.node, args, {
      detached: true,
      windowsHide: true,
      stdio: ["ignore", log, log],
      env: command.dbPath ? { ...process.env, BRAIN_DB: command.dbPath } : process.env,
    });
    child.on("error", () => {});
    child.unref();
    if (child.pid === undefined) {
      Object.assign(record, { status: "failed", error: "the background process didn't start", finishedAt: now });
    } else {
      record.pid = child.pid;
    }
    store.saveEnrolment(record);
  } finally {
    closeSync(log);
  }
  return record;
}

const HOUR = 60 * 60 * 1000;

/**
 * Fetches the brain's own clones, which nobody else pulls, in the background and at most once an
 * hour; each clone's hook then syncs it as it would for anyone's fetch. Never prompts for
 * credentials: a clone that needs them is tried again next time, and the log says why. One still
 * being enrolled is left alone. Returns the repos it fetched.
 */
export function fetchClones(store: Store, command: HookCommand, now = Date.now()): string[] {
  const fetched: string[] = [];
  for (const repo of store.listRepos()) {
    if (!isBrainClone(repo.path, command.dbPath) || !existsSync(repo.path)) continue;
    const enrolment = store.enrolment(repo.name);
    if (enrolment && liveStatus(enrolment) === "running") continue;
    const head = join(repo.path, ".git", "FETCH_HEAD");
    if (existsSync(head) && now - statSync(head).mtimeMs < HOUR) continue;
    mkdirSync(dirname(command.logPath), { recursive: true });
    appendFileSync(command.logPath, `${stamp()} ${repo.name}: fetching the brain's clone\n`);
    const log = openSync(command.logPath, "a");
    try {
      const child = spawn("git", ["-C", repo.path, "fetch", "--quiet"], {
        detached: true,
        windowsHide: true,
        stdio: ["ignore", log, log],
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" },
      });
      child.on("error", () => {});
      child.unref();
      fetched.push(repo.name);
    } finally {
      closeSync(log);
    }
  }
  return fetched;
}
