import type { Endpoint } from "../../core/http.js";
import type { Seam } from "../../core/seams.js";
import type { Freshness, RepoRecord, RepoState } from "../../core/types.js";
import type { Store } from "../../store/store.js";
import type { AccessPolicy, Caller } from "../access.js";
import { describeFreshness, freshnessOf } from "../freshness.js";

export type Format = "concise" | "detailed";

export interface ToolDeps {
  store: Store;
  access: AccessPolicy;
}

export type ToolResult<T> = { ok: true; data: T; text: string } | { ok: false; text: string };
export type Failure = Extract<ToolResult<never>, { ok: false }>;

export const PAGE_SIZE = 20;

/** The enrolled repos this caller may read. Every tool starts here. */
export async function readableRepos(deps: ToolDeps, caller: Caller): Promise<string[]> {
  const enrolled = deps.store.listRepos().map((repo) => repo.name);
  return [...(await deps.access.readableRepos(caller, enrolled))].sort();
}

export interface SyncedRepo {
  ok: true;
  repo: RepoRecord;
  state: RepoState;
  readable: string[];
}

/**
 * A repo the caller may read and that has been synced. Unknown and unreadable repos get the same
 * answer, so a repo's existence never leaks.
 */
export async function requireSyncedRepo(deps: ToolDeps, caller: Caller, name: string): Promise<SyncedRepo | Failure> {
  const readable = await readableRepos(deps, caller);
  const repo = readable.includes(name) ? deps.store.getRepo(name) : undefined;
  if (!repo) {
    const list = readable.length ? `Repos you can read: ${readable.join(", ")}.` : "No repos are enrolled yet.";
    return { ok: false, text: `No readable repo named "${name}". ${list}` };
  }
  const state = deps.store.getState(name);
  if (!state) return { ok: false, text: `"${name}" is enrolled but has not been synced yet. Run: brain sync ${name}` };
  return { ok: true, repo, state, readable };
}

/** A seam with a key, as an endpoint to match against. */
export function endpointOf(seam: Seam): Endpoint {
  return { method: seam.method, key: seam.key! };
}

/** "1 route", "3 routes". */
export function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

export function lineRange(start: number, end: number): string {
  return start === end ? `${start}` : `${start}-${end}`;
}

/** `repo · path:12-18`, the pointer every answer uses. */
export function pointer(seam: Seam): string {
  return `${seam.repo} · ${seam.path}:${lineRange(seam.startLine, seam.endLine)}`;
}

/** Freshness of each named repo's index, for stamping on answers. */
export async function freshnessByRepo(deps: ToolDeps, repos: Iterable<string>): Promise<Map<string, Freshness>> {
  const result = new Map<string, Freshness>();
  for (const name of new Set(repos)) {
    const repo = deps.store.getRepo(name);
    const state = deps.store.getState(name);
    if (repo && state) result.set(name, await freshnessOf(repo, state));
  }
  return result;
}

/**
 * Where the calls with run-time URLs are, so an agent can tell a wrapper (one file, a few
 * lines) from callers the index might be missing. Empty when there are none.
 */
export function unresolvedNote(deps: ToolDeps, repos: readonly string[]): string {
  const calls = deps.store.seams({ repos, kind: "http-call", includeUnresolved: true }).filter((s) => s.key === null);
  if (calls.length === 0) return "";
  const byFile = new Map<string, { start: number; end: number }>();
  for (const call of calls) {
    const place = `${call.repo} · ${call.path}`;
    const seen = byFile.get(place);
    byFile.set(place, { start: Math.min(seen?.start ?? call.startLine, call.startLine), end: Math.max(seen?.end ?? call.endLine, call.endLine) });
  }
  const places = [...byFile].slice(0, 3).map(([place, r]) => `${place}:${lineRange(r.start, r.end)}`);
  const more = byFile.size > 3 ? `, +${byFile.size - 3} more files` : "";
  const subject = calls.length === 1 ? "1 call uses a URL" : `${calls.length} calls use URLs`;
  return `${subject} only known at run time (${places.join(", ")}${more}), so a missing caller isn't proof there is none.`;
}

export interface FooterOptions {
  /** Paging: how many results exist, where this page starts and how long it is. */
  total: number;
  offset: number;
  pageLength: number;
  /** Whether any shown match ignored a base path. */
  suffix: boolean;
  /** Repos whose index freshness to state. */
  freshnessRepos: Iterable<string>;
  /** Repos whose run-time URLs to point out. */
  unresolvedIn: readonly string[];
  closing: string;
}

/** The lines every answer ends with: paging, match notes, freshness, coverage gaps, a caution. */
export async function footer(deps: ToolDeps, options: FooterOptions): Promise<string[]> {
  const lines = [""];
  if (options.total > options.offset + PAGE_SIZE) {
    const next = options.offset + PAGE_SIZE;
    lines.push(`Showing ${options.offset + 1}-${options.offset + options.pageLength} of ${options.total}. Pass offset=${next} for more.`);
  }
  if (options.suffix) lines.push("suffix = matched ignoring a base path such as /api.");
  const freshness = await freshnessByRepo(deps, options.freshnessRepos);
  const indexed = [...freshness].map(([name, f]) => `${name} ${describeFreshness(f, deps.store.getRepo(name)?.ref ?? "?")}`);
  lines.push(`Indexed: ${indexed.join("; ")}`);
  const gap = unresolvedNote(deps, options.unresolvedIn);
  if (gap) lines.push(gap);
  lines.push(options.closing);
  return lines;
}

/** One endpoint of one repo, however many files declare it (code, OpenAPI specs). */
export interface RouteGroup {
  /** The declaration to cite first: code over specs. */
  primary: Seam;
  also: Seam[];
}

/** Merges routes of the same repo, method and key so answers don't repeat callers per spec file. */
export function groupRoutes(routes: readonly Seam[]): RouteGroup[] {
  const groups = new Map<string, Seam[]>();
  for (const route of routes) {
    const id = `${route.repo}\u0000${route.method}\u0000${route.key}`;
    groups.set(id, [...(groups.get(id) ?? []), route]);
  }
  return [...groups.values()].map((members) => {
    const primary = members.find((m) => m.plugin !== "openapi") ?? members[0]!;
    return { primary, also: members.filter((m) => m !== primary) };
  });
}

export function alsoDeclared(also: readonly Seam[]): string {
  return `also declared in ${also.map((s) => `${s.path}:${lineRange(s.startLine, s.endLine)}`).join(", ")}`;
}
