import { formatCitation } from "../../core/citations.js";
import { hasLiteralSegment, matchEndpoints, type Endpoint, type MatchQuality } from "../../core/http.js";
import type { LinkTarget } from "../../core/links.js";
import { FAMILIES, familyOf, type Seam, type SeamFamily } from "../../core/seams.js";
import type { Freshness, RepoRecord, RepoState, WikiPage } from "../../core/types.js";
import { liveStatus } from "../../ingest/enrol.js";
import type { Store } from "../../store/store.js";
import type { AccessPolicy, Caller } from "../access.js";
import { enrolmentLines, readableEnrolment, unfinished } from "../enrolment.js";
import { coverageNote } from "../coverage.js";
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
 * The repos in `names` without a wiki, for a note on what a search couldn't cover: each marked
 * "being enrolled" while its enrolment runs, so an agent waits rather than syncs.
 */
export function withoutWiki(deps: ToolDeps, names: readonly string[]): string[] {
  return names
    .filter((name) => deps.store.pages(name).length === 0)
    .map((name) => {
      const enrolment = deps.store.enrolment(name);
      return enrolment && liveStatus(enrolment) === "running" ? `${name} (being enrolled)` : name;
    });
}

/** The text cut to at most `max` characters, ending in "…" when cut. */
export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

/** What every tool says when there's nothing to read. */
export const NO_REPOS = "No repos are enrolled yet. Add one with brain_add_repo (a GitHub URL, owner/repo or a local folder).";

/** The repos a tool looks in: those asked for that the caller can read, or every one they can. */
export async function scopeOf(deps: ToolDeps, caller: Caller, repos: readonly string[] | undefined): Promise<{ ok: true; readable: string[]; scope: string[] } | Failure> {
  const readable = await readableRepos(deps, caller);
  const scope = repos?.length ? readable.filter((name) => repos.includes(name)) : readable;
  if (readable.length === 0) return { ok: false, text: NO_REPOS };
  if (scope.length === 0) return { ok: false, text: `None of the requested repos are enrolled or readable. Repos you can read: ${readable.join(", ")}.` };
  return { ok: true, readable, scope };
}

/**
 * A repo the caller may read and that has been synced. Unknown and unreadable repos get the same
 * answer, so a repo's existence never leaks. One still being enrolled (cloned, or indexed) says
 * where it has got to instead, or why its enrolment failed and how to try again.
 */
export async function requireSyncedRepo(deps: ToolDeps, caller: Caller, name: string): Promise<SyncedRepo | Failure> {
  const readable = await readableRepos(deps, caller);
  const repo = readable.includes(name) ? deps.store.getRepo(name) : undefined;
  const state = repo && deps.store.getState(name);
  if (!state) {
    const enrolment = await readableEnrolment(deps, caller, name);
    if (unfinished(enrolment)) return { ok: false, text: [`"${name}" isn't ready yet.`, ...enrolmentLines(enrolment)].join("\n") };
  }
  if (!repo) {
    const list = readable.length ? `Repos you can read: ${readable.join(", ")}.` : NO_REPOS;
    return { ok: false, text: `No readable repo named "${name}". ${list}` };
  }
  if (!state) return { ok: false, text: `"${name}" is enrolled but hasn't been indexed yet. Adding it again with brain_add_repo indexes it.` };
  return { ok: true, repo, state, readable };
}

/** A seam with a key, as an endpoint to match against. */
export function endpointOf(seam: Seam): Endpoint {
  return { method: seam.method, key: seam.key! };
}

/**
 * How two seams of the same family match, if they do: HTTP by method and path (exact or suffix),
 * events, gRPC and packages exactly on their normalised name.
 */
export function matchSeams(a: Seam, b: Seam): MatchQuality | null {
  const family = familyOf(a.kind);
  if (family !== familyOf(b.kind)) return null;
  if (family === "http") return matchEndpoints(endpointOf(a), endpointOf(b));
  return a.key === b.key ? "exact" : null;
}

/** How a seam matches what the caller asked about, if it does, by the same rules as `matchSeams`. */
export function matchTarget(seam: Seam, target: LinkTarget): MatchQuality | null {
  if (familyOf(seam.kind) !== target.family) return null;
  if (target.family === "http") return matchEndpoints(endpointOf(seam), target.endpoint);
  return seam.key === target.key ? "exact" : null;
}

/** A call that reaches a route (or a subscription its event, a dependency its package…), and how well the two matched. */
export interface SeamLink {
  call: Seam;
  route: Seam;
  match: MatchQuality;
}

/**
 * Every call that reaches one of the routes, or for the other families every use of what is
 * provided (a handler of a published event, a gRPC call, a dependency on a package). Two kinds
 * of use only link within their own repo:
 * - a key with no literal segment (`/`, `/{}`): every web app serves `/`, so across repos it says
 *   nothing about which one is meant;
 * - a call its own repo serves (`ownRoutes` holds the callers' routes): its tests or front end
 *   calling itself, which says nothing about another repo that happens to serve the same path.
 *   Likewise an event a repo publishes and handles itself.
 */
export function linkCalls(calls: readonly Seam[], routes: readonly Seam[], ownRoutes: readonly Seam[]): SeamLink[] {
  return calls.flatMap((call) => {
    const selfServed = ownRoutes.some((own) => own.repo === call.repo && matchSeams(call, own));
    return routes.flatMap((route) => {
      if (call.repo !== route.repo && (selfServed || !hasLiteralSegment(route.key!))) return [];
      const match = matchSeams(call, route);
      return match ? [{ call, route, match }] : [];
    });
  });
}

/** How each family is named in answers. */
export const FAMILY_LABEL: Record<SeamFamily, string> = { http: "HTTP", event: "event", grpc: "gRPC", package: "package" };

/** What each family's two sides are called in answers. */
export const ROLES: Record<SeamFamily, { provider: string; consumer: string; providedBy: string; usedBy: string }> = {
  http: { provider: "server", consumer: "caller", providedBy: "Served by", usedBy: "Called by" },
  event: { provider: "publisher", consumer: "handler", providedBy: "Published by", usedBy: "Handled by" },
  grpc: { provider: "server", consumer: "caller", providedBy: "Served by", usedBy: "Called by" },
  package: { provider: "publisher", consumer: "dependent", providedBy: "Published by", usedBy: "Used by" },
};

/** "1 route", "3 routes". */
export function count(n: number, noun: string, plural = `${noun}s`): string {
  return `${n} ${n === 1 ? noun : plural}`;
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

/**
 * The commit a wiki describes: the indexed one if any page is at it. Pages at an older commit
 * than that were kept because their rewrite failed the citation check.
 */
export function wikiCommit(pages: readonly WikiPage[], indexed: string): string {
  return pages.some((p) => p.commit === indexed) ? indexed : pages[0]!.commit;
}

/** Each repo's freshness: the commit its wiki describes, or its seams when it has no wiki. */
export async function indexedAt(deps: ToolDeps, repos: readonly string[]): Promise<string[]> {
  const lines: string[] = [];
  for (const name of repos) {
    const repo = deps.store.getRepo(name);
    const state = deps.store.getState(name);
    if (!repo || !state) continue;
    const pages = deps.store.pages(name);
    const commit = pages.length ? wikiCommit(pages, state.commit) : (state.seamsCommit ?? state.commit);
    lines.push(`${name} ${describeFreshness(await freshnessOf(repo, { ...state, commit }), repo.ref)}`);
  }
  return lines;
}

/** The other lines a seam's path was assembled from (a prefix, a base URL), for detailed answers. */
export function builtFrom(seam: Seam): string {
  return seam.cites.length ? ` · path built with ${seam.cites.map(formatCitation).join(", ")}` : "";
}

/**
 * Where the calls with run-time URLs are, so an agent can tell a wrapper (one file, a few
 * lines) from callers the index might be missing. Files in `relevant` repos (the ones the answer
 * is about) are listed first; the count covers every repo searched. Empty when there are none.
 * For events and gRPC, the same for names only known at run time, on either side.
 */
export function unresolvedNote(deps: ToolDeps, repos: readonly string[], relevant: Iterable<string>, family: SeamFamily): string {
  const kinds = family === "http" ? [FAMILIES.http.uses] : [FAMILIES[family].provides, FAMILIES[family].uses];
  const calls = deps.store.seams({ repos, includeUnresolved: true }).filter((s) => s.key === null && kinds.includes(s.kind));
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
  if (family !== "http") {
    const subject = `${count(calls.length, `${FAMILY_LABEL[family]} link`)} ${calls.length === 1 ? "uses a name" : "use names"}`;
    return `${subject} only known at run time (${places.join(", ")}${more}), so a missing link isn't proof there is none.`;
  }
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
  /** Which families' run-time URLs or names to point out; HTTP when not given. */
  families?: readonly SeamFamily[];
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
  for (const family of options.families ?? ["http"]) {
    const gap = unresolvedNote(deps, options.unresolvedIn, options.relevantRepos, family);
    if (gap) lines.push(gap);
    const unknown = coverageNote(deps.store, options.unresolvedIn, family);
    if (unknown) lines.push(unknown);
  }
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
