import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { FileRecord, LanguageShare, RepoRecord, RepoState } from "../core/types.js";
import { MIGRATIONS } from "./migrations.js";
import type { Store, SyncChanges } from "./store.js";

type Row = Record<string, unknown>;

/** Local POC store. Pass ":memory:" for tests. */
export class SqliteStore implements Store {
  private readonly db: DatabaseSync;

  constructor(file: string) {
    if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
    this.migrate();
  }

  private migrate(): void {
    const { user_version: current } = this.db.prepare("PRAGMA user_version").get() as { user_version: number };
    for (let version = current; version < MIGRATIONS.length; version++) {
      this.transaction(() => {
        this.db.exec(MIGRATIONS[version]!);
        this.db.exec(`PRAGMA user_version = ${version + 1}`);
      });
    }
  }

  private transaction(work: () => void): void {
    this.db.exec("BEGIN");
    try {
      work();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  addRepo(repo: RepoRecord): void {
    this.db
      .prepare("INSERT INTO repos (name, path, ref, remote, enrolled_at) VALUES (?, ?, ?, ?, ?)")
      .run(repo.name, repo.path, repo.ref, repo.remote, repo.enrolledAt);
  }

  getRepo(name: string): RepoRecord | undefined {
    const row = this.db.prepare("SELECT * FROM repos WHERE name = ?").get(name) as Row | undefined;
    return row && toRepo(row);
  }

  listRepos(): RepoRecord[] {
    return (this.db.prepare("SELECT * FROM repos ORDER BY name").all() as Row[]).map(toRepo);
  }

  removeRepo(name: string): boolean {
    return Number(this.db.prepare("DELETE FROM repos WHERE name = ?").run(name).changes) > 0;
  }

  getState(repo: string): RepoState | undefined {
    const row = this.db.prepare("SELECT * FROM repo_state WHERE repo = ?").get(repo) as Row | undefined;
    return (
      row && {
        repo: String(row.repo),
        commit: String(row.commit_sha),
        syncedAt: String(row.synced_at),
        fileCount: Number(row.file_count),
      }
    );
  }

  getFiles(repo: string): FileRecord[] {
    const rows = this.db.prepare("SELECT * FROM files WHERE repo = ? ORDER BY path").all(repo) as Row[];
    return rows.map((row) => ({
      repo: String(row.repo),
      path: String(row.path),
      blob: String(row.blob),
      bytes: Number(row.bytes),
      language: row.language === null ? null : String(row.language),
      commit: String(row.commit_sha),
    }));
  }

  applySync(repo: string, commit: string, changes: SyncChanges, fileCount: number): void {
    const upsert = this.db.prepare(
      `INSERT INTO files (repo, path, blob, bytes, language, commit_sha) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (repo, path) DO UPDATE SET
         blob = excluded.blob, bytes = excluded.bytes, language = excluded.language, commit_sha = excluded.commit_sha`,
    );
    const remove = this.db.prepare("DELETE FROM files WHERE repo = ? AND path = ?");
    const state = this.db.prepare(
      `INSERT INTO repo_state (repo, commit_sha, synced_at, file_count) VALUES (?, ?, ?, ?)
       ON CONFLICT (repo) DO UPDATE SET
         commit_sha = excluded.commit_sha, synced_at = excluded.synced_at, file_count = excluded.file_count`,
    );
    this.transaction(() => {
      for (const f of changes.upsert) upsert.run(repo, f.path, f.blob, f.bytes, f.language, f.commit);
      for (const path of changes.remove) remove.run(repo, path);
      state.run(repo, commit, new Date().toISOString(), fileCount);
    });
  }

  languageShares(repo: string): LanguageShare[] {
    const rows = this.db
      .prepare(
        `SELECT COALESCE(language, 'Other') AS language, COUNT(*) AS files, SUM(bytes) AS bytes
         FROM files WHERE repo = ? GROUP BY 1 ORDER BY files DESC, language`,
      )
      .all(repo) as Row[];
    return rows.map((row) => ({ language: String(row.language), files: Number(row.files), bytes: Number(row.bytes) }));
  }

  close(): void {
    this.db.close();
  }
}

function toRepo(row: Row): RepoRecord {
  return {
    name: String(row.name),
    path: String(row.path),
    ref: String(row.ref),
    remote: row.remote === null ? null : String(row.remote),
    enrolledAt: String(row.enrolled_at),
  };
}
