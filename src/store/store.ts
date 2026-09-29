import type { Seam, SeamCoverage, SeamKind } from "../core/seams.js";
import type { FileRecord, LanguageShare, RepoRecord, RepoState } from "../core/types.js";

/** Everything one sync changes, applied atomically. */
export interface SyncUpdate {
  commit: string;
  fileCount: number;
  extractorVersion: number;
  upsert: FileRecord[];
  remove: string[];
  /** Files whose seams are replaced: old seams for these paths are dropped, `seams` inserted. */
  seamPaths: string[];
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
  /** Deletes the repo and every row that belongs to it. */
  removeRepo(name: string): boolean;

  getState(repo: string): RepoState | undefined;
  getFiles(repo: string): FileRecord[];
  applySync(repo: string, update: SyncUpdate): void;
  languageShares(repo: string): LanguageShare[];

  seams(filter: SeamFilter): Seam[];
  seamCoverage(repo: string): SeamCoverage;

  close(): void;
}
