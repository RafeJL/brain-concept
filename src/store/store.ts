import type { Seam, SeamCoverage, SeamKind } from "../core/seams.js";
import type { FileRecord, LanguageShare, RepoRecord, RepoState, WikiPage } from "../core/types.js";

/** Everything one sync changes, applied atomically. */
export interface SyncUpdate {
  commit: string;
  fileCount: number;
  extractorVersion: number;
  upsert: FileRecord[];
  remove: string[];
  /** Files re-read in this sync: their old seams are dropped, `seams` inserted. */
  extractedPaths: string[];
  seams: Seam[];
}

export interface SeamFilter {
  /** Only these repos. Always pass the caller's readable set. */
  repos: readonly string[];
  kind?: SeamKind;
  path?: string;
  /** Include unresolved calls (no key). Default false. */
  includeUnresolved?: boolean;
}

/**
 * Everything the brain knows, keyed by repo. SQLite implements it for the POC; Postgres will
 * implement it when hosted. Keep it small: callers compose queries, the store stays dumb.
 */
export interface Store {
  addRepo(repo: RepoRecord): void;
  getRepo(name: string): RepoRecord | undefined;
  listRepos(): RepoRecord[];
  /** Changes which ref a repo's facts are read from; the next sync catches up. */
  setRepoRef(name: string, ref: string): boolean;
  /** Deletes the repo and every row that belongs to it. */
  removeRepo(name: string): boolean;

  getState(repo: string): RepoState | undefined;
  getFiles(repo: string): FileRecord[];
  applySync(repo: string, update: SyncUpdate): void;
  languageShares(repo: string): LanguageShare[];

  seams(filter: SeamFilter): Seam[];
  seamCoverage(repo: string): SeamCoverage;

  /** Replaces a repo's whole wiki in one step, keeping the pages' order. */
  replacePages(repo: string, pages: readonly WikiPage[]): void;
  /** A repo's wiki pages in the order they were written. */
  pages(repo: string): WikiPage[];

  close(): void;
}
