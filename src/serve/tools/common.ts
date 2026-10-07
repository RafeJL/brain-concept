import { hasLiteralSegment, matchEndpoints, type Endpoint, type MatchQuality } from "../../core/http.js";
import type { Seam } from "../../core/seams.js";
import type { Freshness, RepoRecord, RepoState } from "../../core/types.js";
import type { Store } from "../../store/store.js";
import type { AccessPolicy, Caller } from "../access.js";
import { describeFreshness, freshnessOf } from "../freshness.js";

export type Format = "concise" | "detailed";

/** How every answer's facts were made: by Claude Code, with each citation checked. */
export const TIER = "llm-generated";

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
    const list = readable.length ? `Repos you can read: ${readable.join(", ")}.` : "No repos are enrolled yet. Add one with: brain add <path>";
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

/** A call that reaches a route, and how well the two matched. */
export interface SeamLink {
  call: Seam;
  route: Seam;
  match: MatchQuality;
}

/**
 * Every call that reaches one of the routes. Two kinds of call only link within their own repo:
 * - a key with no literal segment (`/`, `/{}`): every web app serves `/`, so across repos it says
 *   nothing about which one is meant;
 * - a call its own repo serves (`ownRoutes` holds the callers' routes): its tests or front end
 *   calling itself, which says nothing about another repo that happens to serve the same path.
 */
export function linkCalls(calls: readonly Seam[], routes: readonly Seam[], ownRoutes: readonly Seam[] = []): SeamLink[] {
  return calls.flatMap((call) => {
    const selfServed = ownRoutes.some((own) => own.repo === call.repo && matchEndpoints(endpointOf(call), endpointOf(own)));
    return routes.flatMap((route) => {
      if (call.repo !== route.repo && (selfServed || !hasLiteralSegment(route.key!))) return [];
      const match = matchEndpoints(endpointOf(call), endpointOf(route));
      return match ? [{ call, route, match }] : [];
    });
  });
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

/** Freshness of each named repo's seams (the commit they were mapped at), for stamping on answers. */
export async function freshnessByRepo(deps: ToolDeps, repos: Iterable<string>): Promise<Map<string, Freshness>> {
  const result = new Map<string, Freshness>();
  for (const name of new Set(repos)) {
    const repo = deps.store.getRepo(name);
    const state = deps.store.getState(name);
    if (repo && state) result.set(name, await freshnessOf(repo, { ...state, commit: state.seamsCommit ?? state.commit }));
  }
  return result;
}

/** The other lines a seam's path was assembled from (a prefix, a base URL), for detailed answers. */
export function builtFrom(seam: Seam): string {
  return seam.cites.length ? ` · path built with ${seam.cites.map((c) => `${c.path}:${lineRange(c.start, c.end)}`).join(", ")}` : "";
}

/**
 * Where the calls with run-time URLs are, so an agent can tell a wrapper (one file, a few
 * lines) from callers the index might be missing. Files in `relevant` repos (the ones the answer
 * is about) are listed first; the count covers every repo searched. Empty when there are none.
 */
export function unresolvedNote(deps: ToolDeps, repos: readonly string[], relevant: Iterable<string> = []): string {
  const calls = deps.store.seams({ repos, kind: "http-call", includeUnresolved: true }).filter((s) => s.key === null);
  if (calls.length === 0) return "";
  const byFile = new Map<string, { start: number; end: number }>();
  const repoOf = (place: string) => place.split(" · ")[0]!;
  for (const call of calls) {
    const place = `${call.repo} · ${call.path}`;
    const seen = byFile.get(place);
    byFile.set(place, { start: Math.min(seen?.start ?? call.startLine, call.startLine), end: Math.max(seen?.end ?? call.endLine, call.endLine) });
  }
  const first = new Set(relevant);
  const ranked = [...byFile].sort(([a], [b]) => Number(!first.has(repoOf(a))) - Number(!first.has(repoOf(b))));
  const places = ranked.slice(0, 3).map(([place, r]) => `${place}:${lineRange(r.start, r.end)}`);
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
  /** Repos the answer is about; their run-time URLs are listed first. */
  relevantRepos: Iterable<string>;
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
  const gap = unresolvedNote(deps, options.unresolvedIn, options.relevantRepos);
  if (gap) lines.push(gap);
  lines.push(options.closing);
  return lines;
}

/** OpenAPI and Swagger specs are YAML or JSON; code is cited before them. */
const SPEC_FILE = /\.(ya?ml|json)$/i;

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
    const primary = members.find((m) => !SPEC_FILE.test(m.path)) ?? members[0]!;
    return { primary, also: members.filter((m) => m !== primary) };
  });
}

export function alsoDeclared(also: readonly Seam[]): string {
  return `also declared in ${also.map((s) => `${s.path}:${lineRange(s.startLine, s.endLine)}`).join(", ")}`;
}
