/**
 * Schema versions, applied in order. Never edit a shipped migration; add a new one.
 * The index in this array + 1 is the schema version stored in PRAGMA user_version.
 */
export const MIGRATIONS: string[] = [
  `
  CREATE TABLE repos (
    name        TEXT PRIMARY KEY,
    path        TEXT NOT NULL,
    ref         TEXT NOT NULL,
    remote      TEXT,
    enrolled_at TEXT NOT NULL
  );

  CREATE TABLE repo_state (
    repo       TEXT PRIMARY KEY REFERENCES repos(name) ON DELETE CASCADE,
    commit_sha TEXT NOT NULL,
    synced_at  TEXT NOT NULL,
    file_count INTEGER NOT NULL
  );

  CREATE TABLE files (
    repo       TEXT NOT NULL REFERENCES repos(name) ON DELETE CASCADE,
    path       TEXT NOT NULL,
    blob       TEXT NOT NULL,
    bytes      INTEGER NOT NULL,
    language   TEXT,
    commit_sha TEXT NOT NULL,
    PRIMARY KEY (repo, path)
  );
  `,
  `
  ALTER TABLE repo_state ADD COLUMN extractor_version INTEGER NOT NULL DEFAULT 0;

  CREATE TABLE seams (
    id         INTEGER PRIMARY KEY,
    repo       TEXT NOT NULL,
    path       TEXT NOT NULL,
    kind       TEXT NOT NULL,
    method     TEXT NOT NULL,
    raw_path   TEXT,
    route_key  TEXT,
    start_line INTEGER NOT NULL,
    end_line   INTEGER NOT NULL,
    plugin     TEXT NOT NULL,
    commit_sha TEXT NOT NULL,
    FOREIGN KEY (repo, path) REFERENCES files(repo, path) ON DELETE CASCADE
  );
  CREATE INDEX seams_by_file ON seams(repo, path);
  CREATE INDEX seams_by_key ON seams(route_key);
  `,
];
