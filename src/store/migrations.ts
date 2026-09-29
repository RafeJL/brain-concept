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
];
