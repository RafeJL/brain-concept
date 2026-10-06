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
  `
  CREATE TABLE facts (
    id         INTEGER PRIMARY KEY,
    repo       TEXT NOT NULL,
    path       TEXT NOT NULL,
    kind       TEXT NOT NULL,
    name       TEXT NOT NULL,
    value      TEXT NOT NULL,
    line       INTEGER,
    commit_sha TEXT NOT NULL,
    FOREIGN KEY (repo, path) REFERENCES files(repo, path) ON DELETE CASCADE
  );
  CREATE INDEX facts_by_file ON facts(repo, path);
  `,
  `
  CREATE TABLE pages (
    repo         TEXT NOT NULL REFERENCES repos(name) ON DELETE CASCADE,
    slug         TEXT NOT NULL,
    position     INTEGER NOT NULL,
    title        TEXT NOT NULL,
    markdown     TEXT NOT NULL,
    commit_sha   TEXT NOT NULL,
    model        TEXT NOT NULL,
    cost_usd     REAL NOT NULL,
    generated_at TEXT NOT NULL,
    PRIMARY KEY (repo, slug)
  );
  `,
  // The fact readers were replaced by the wiki (W1).
  `
  DROP TABLE IF EXISTS facts;
  `,
  // W2: what the citation checker found on each page.
  `
  ALTER TABLE pages ADD COLUMN claims INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE pages ADD COLUMN removed INTEGER NOT NULL DEFAULT 0;
  `,
  // W4: seams come from Claude Code, not parsers. Parser seams are dropped; the next sync finds
  // them again. cites holds the lines that contribute to a seam's path (JSON); seams_commit is
  // the commit the seams describe, so an update knows what changed since.
  `
  DELETE FROM seams;
  ALTER TABLE seams ADD COLUMN cites TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE repo_state ADD COLUMN seams_commit TEXT;
  ALTER TABLE repo_state DROP COLUMN extractor_version;
  `,
];
