import type { FileRecord, LanguageShare, RepoRecord, RepoState } from "../core/types.js";

export interface SyncChanges {
  upsert: FileRecord[];
  remove: string[];
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
  /** Applies one sync atomically: file changes plus the new indexed commit. */
  applySync(repo: string, commit: string, changes: SyncChanges, fileCount: number): void;
  languageShares(repo: string): LanguageShare[];

  close(): void;
}
