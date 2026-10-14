import type { FactCheck, FactRecord, Gap, GapSummary, NewFact } from "../core/facts.js";
import type { LinkSurvey, Seam, SeamCoverage, SeamKind, SeamPiece } from "../core/seams.js";
import type { SystemRecord } from "../core/systems.js";
import type { TraceLink } from "../core/traces.js";
import type { Enrolment, FileRecord, LanguageShare, PlannedPage, RepoNote, RepoRecord, RepoState, WikiPage } from "../core/types.js";

/** Everything one sync changes, applied atomically. Removing a file removes its seams. */
export interface SyncUpdate {
  commit: string;
  fileCount: number;
  upsert: FileRecord[];
  remove: string[];
}

/** New seams for a repo at `commit`, replacing those declared in `paths` (every seam if null). */
export interface SeamUpdate {
  commit: string;
  paths: readonly string[] | null;
  seams: readonly Seam[];
  /** Pieces mapped this time, replacing those of the same files (or all of them when `paths` is null). */
  pieces?: readonly SeamPiece[];
  /** Every inherited route, replacing all earlier ones: worked out again on every map. */
  derived?: readonly Seam[];
  /** The survey the map was made with, kept for updates. */
  survey?: LinkSurvey;
}

export interface SeamFilter {
  /** Only these repos. Always pass the caller's readable set. */
  repos: readonly string[];
  kind?: SeamKind;
  path?: string;
  /** Include unresolved calls (no key). Default false. */
  includeUnresolved?: boolean;
}

/** A search over the index: an FTS5 `match` expression, limited to the caller's repos. */
export interface SearchFilter {
  /** Only these repos. Always pass the caller's readable set. */
  repos: readonly string[];
  match: string;
  limit: number;
  offset?: number;
  /** Snippet length in words. */
  snippetWords?: number;
}

/** A wiki section that matched, best first. */
export interface SectionHit {
  repo: string;
  slug: string;
  pageTitle: string;
  heading: string;
  /** The matching part of the section, citations taken out. */
  snippet: string;
  /** Files the section cites. */
  paths: string[];
  /** How well it matched (bm25, higher is better), for comparing hits of one search. */
  score: number;
}

/** Which facts to read: those on these repos and these systems (by name). */
export interface FactFilter {
  /** Always the caller's readable set. */
  repos: readonly string[];
  /** Systems the caller can see. */
  systems: readonly string[];
  /** Include retired facts. Default false. */
  retired?: boolean;
}

/** What `updateFact` may change. Anchors change together with the commit they were checked at. */
export type FactChange = Partial<Pick<FactRecord, "text" | "status" | "confirmedBy" | "confirmedAt" | "confirmedWith" | "staleSince" | "anchors" | "anchorCommit" | "anchorsFound">>;

export interface SearchPage<T> {
  /** How many rows match in all, for paging. */
  total: number;
  /** Every repo with a matching row, not only those on this page. */
  repos: string[];
  hits: T[];
}

/**
 * Everything the brain knows, keyed by repo. SQLite implements it for the POC; Postgres will
 * implement it when hosted. Keep it small: callers compose queries, the store stays dumb.
 */
export interface Store {
  addRepo(repo: RepoRecord): void;
  getRepo(name: string): RepoRecord | undefined;
  listRepos(): RepoRecord[];
  /** Changes which ref a repo is indexed from; the next sync catches up. */
  setRepoRef(name: string, ref: string): boolean;
  /** Sets or clears the note that steers a repo's wiki. */
  setRepoNote(name: string, note: RepoNote | null): void;
  /** Sets or clears a note waiting for a person to confirm it. */
  setProposedNote(name: string, note: RepoNote | null): void;
  /** Deletes the repo and every row that belongs to it, its enrolment included. */
  removeRepo(name: string): boolean;

  /** Where enrolling a repo has got to, whether or not it is enrolled yet. */
  enrolment(repo: string): Enrolment | undefined;
  /** Every enrolment, newest first: running, failed and finished. */
  enrolments(): Enrolment[];
  /** Records an enrolment, replacing what was recorded for that name. */
  saveEnrolment(enrolment: Enrolment): void;
  /** Forgets an enrolment, e.g. a failed clone of a repo that was never enrolled. */
  removeEnrolment(repo: string): boolean;

  getState(repo: string): RepoState | undefined;
  getFiles(repo: string): FileRecord[];
  applySync(repo: string, update: SyncUpdate): void;
  languageShares(repo: string): LanguageShare[];

  seams(filter: SeamFilter): Seam[];
  seamCoverage(repo: string): SeamCoverage;
  /** Swaps in Claude Code's seams and records the commit they describe, in one step. */
  replaceSeams(repo: string, update: SeamUpdate): void;
  /** What the last maps made of each piece of the repo's files; empty for a map made before pieces were kept. */
  seamPieces(repo: string): SeamPiece[];
  /** The survey the repo's last full map was made with. */
  linkSurvey(repo: string): LinkSurvey | null;

  /** Records the commit at which a missing required page failed the check (null to clear it). */
  setPagesFailedAt(repo: string, commit: string | null): void;
  /** Replaces a repo's whole wiki in one step, keeping the pages' order. */
  replacePages(repo: string, pages: readonly WikiPage[]): void;
  /** A repo's wiki pages in the order they were written. */
  pages(repo: string): WikiPage[];
  /** A large repo's page plan, in order; empty for a repo without one. */
  wikiPlan(repo: string): PlannedPage[];
  /** Replaces a repo's page plan, recording the commit and note it was made with (empty and null to clear). */
  replaceWikiPlan(repo: string, plan: readonly PlannedPage[], madeWith: { commit: string | null; note: string | null }): void;

  /** Wiki sections matching a search, best first. Kept in step with pages by `replacePages`. */
  searchSections(filter: SearchFilter): SearchPage<SectionHit>;
  /** Routes and calls matching a search, best first. Kept in step with seams by `replaceSeams`. */
  searchSeams(filter: SearchFilter): SearchPage<Seam>;

  /** A repo's checked chains from entry points to what they reach. */
  traceLinks(repo: string): TraceLink[];
  /** Replaces the chains of these entry points (every entry point when null) with `links`, in one step. */
  replaceTraceLinks(repo: string, entries: readonly string[] | null, links: readonly TraceLink[]): void;

  /** Every system with its member repos, by name. Callers filter members to the readable set. */
  systems(): SystemRecord[];
  /** Swaps every suggested system for these, in one step. Confirmed systems are untouched. */
  replaceSuggestedSystems(systems: readonly Pick<SystemRecord, "name" | "summary" | "reason" | "repos">[]): void;
  /** Confirms the named systems, or every suggested one when null. Returns the names confirmed. */
  confirmSystems(names: readonly string[] | null): string[];
  /**
   * Adds repos to a system, moving them out of any other, and changes its summary when given.
   * The system is confirmed afterwards, whether new or suggested: a person has decided it.
   */
  setSystem(name: string, repos: readonly string[], summary?: string): void;
  /** False when there is no such system; throws when another system already has the new name. */
  renameSystem(name: string, to: string): boolean;
  removeSystem(name: string): boolean;
  /** Names of the systems whose name or summary match an FTS5 expression, best first. */
  searchSystems(match: string): string[];

  /** Stores a fact on a repo or a system (by name) and returns its id. */
  addFact(fact: NewFact): number;
  getFact(id: number): FactRecord | undefined;
  /** Facts on the given repos and systems, newest first. */
  facts(filter: FactFilter): FactRecord[];
  /** False when there is no such fact. */
  updateFact(id: number, change: FactChange): boolean;
  /** Stores checks, replacing any earlier check of the same fact in the same repo. */
  saveFactChecks(checks: readonly FactCheck[]): void;
  /** Facts matching an FTS5 expression: confirmed and current ones first, then best match. */
  searchFacts(filter: FactFilter & { match: string; limit: number }): FactRecord[];

  logGap(gap: Gap): void;
  /**
   * Logged gaps grouped by question (ignoring case), most asked first. Given the repos a caller can
   * read, a search limited to a repo they can't read is left out.
   */
  gaps(limit: number, readable?: readonly string[]): GapSummary[];

  close(): void;
}
