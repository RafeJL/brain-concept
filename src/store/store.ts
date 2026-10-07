import type { Seam, SeamCoverage, SeamKind } from "../core/seams.js";
import type { FileRecord, LanguageShare, RepoRecord, RepoState, WikiPage } from "../core/types.js";

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
}

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
  /** Deletes the repo and every row that belongs to it. */
  removeRepo(name: string): boolean;

  getState(repo: string): RepoState | undefined;
  getFiles(repo: string): FileRecord[];
  applySync(repo: string, update: SyncUpdate): void;
  languageShares(repo: string): LanguageShare[];

  seams(filter: SeamFilter): Seam[];
  seamCoverage(repo: string): SeamCoverage;
  /** Swaps in Claude Code's seams and records the commit they describe, in one step. */
  replaceSeams(repo: string, update: SeamUpdate): void;

  /** Replaces a repo's whole wiki in one step, keeping the pages' order. */
  replacePages(repo: string, pages: readonly WikiPage[]): void;
  /** A repo's wiki pages in the order they were written. */
  pages(repo: string): WikiPage[];

  /** Wiki sections matching a search, best first. Kept in step with pages by `replacePages`. */
  searchSections(filter: SearchFilter): SearchPage<SectionHit>;
  /** Routes and calls matching a search, best first. Kept in step with seams by `replaceSeams`. */
  searchSeams(filter: SearchFilter): SearchPage<Seam>;

  close(): void;
}
