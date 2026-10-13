import type { DatabaseSync } from "node:sqlite";
import { createSearchIndex } from "./search-index.js";

/**
 * Schema versions, applied in order. Never edit a shipped migration; add a new one.
 * The index in this array + 1 is the schema version stored in PRAGMA user_version.
 * A migration is SQL, or code when it needs more than SQL can do.
 */
export const MIGRATIONS: (string | ((db: DatabaseSync) => void))[] = [
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
  // W5: the search index over wiki sections and seams.
  createSearchIndex,
  // Every seam comes from Claude Code since W4, so the column saying which parser found it is gone.
  `
  ALTER TABLE seams DROP COLUMN plugin;
  `,
  // B2a: systems, the groups of repos that make up a product. Claude Code suggests them and a
  // person confirms them. A repo belongs to at most one. system_search indexes their names and
  // summaries; triggers keep it in step, so nothing else writes to it.
  `
  CREATE TABLE systems (
    id           INTEGER PRIMARY KEY,
    name         TEXT NOT NULL UNIQUE COLLATE NOCASE,
    summary      TEXT NOT NULL,
    reason       TEXT NOT NULL,
    status       TEXT NOT NULL CHECK (status IN ('suggested', 'confirmed')),
    suggested_at TEXT,
    confirmed_at TEXT
  );
  CREATE TABLE system_repos (
    repo   TEXT PRIMARY KEY REFERENCES repos(name) ON DELETE CASCADE,
    system INTEGER NOT NULL REFERENCES systems(id) ON DELETE CASCADE
  );
  CREATE INDEX system_repos_by_system ON system_repos(system);

  CREATE VIRTUAL TABLE system_search USING fts5(name, summary, content = 'systems', content_rowid = 'id', tokenize = 'porter unicode61');
  CREATE TRIGGER systems_index AFTER INSERT ON systems BEGIN
    INSERT INTO system_search (rowid, name, summary) VALUES (new.id, new.name, new.summary);
  END;
  CREATE TRIGGER systems_unindex AFTER DELETE ON systems BEGIN
    INSERT INTO system_search (system_search, rowid, name, summary) VALUES ('delete', old.id, old.name, old.summary);
  END;
  CREATE TRIGGER systems_reindex AFTER UPDATE ON systems BEGIN
    INSERT INTO system_search (system_search, rowid, name, summary) VALUES ('delete', old.id, old.name, old.summary);
    INSERT INTO system_search (rowid, name, summary) VALUES (new.id, new.name, new.summary);
  END;
  `,
  // The commit at which a page every wiki should have failed the check, so it isn't written
  // again (at a cost) on every sync until the code changes.
  `
  ALTER TABLE repo_state ADD COLUMN pages_failed_at TEXT;
  `,
  // B3: facts people state in a conversation, about a repo or a system, and the searches the
  // brain couldn't answer. fact_search indexes the facts' text; triggers keep it in step.
  `
  CREATE TABLE facts (
    id            INTEGER PRIMARY KEY,
    repo          TEXT REFERENCES repos(name) ON DELETE CASCADE,
    system        INTEGER REFERENCES systems(id) ON DELETE CASCADE,
    kind          TEXT NOT NULL CHECK (kind IN ('rule', 'term', 'purpose', 'decision', 'answer')),
    text          TEXT NOT NULL,
    quote         TEXT NOT NULL,
    stated_by     TEXT NOT NULL,
    ticket        TEXT,
    anchors       TEXT NOT NULL DEFAULT '[]',
    anchor_commit TEXT,
    status        TEXT NOT NULL CHECK (status IN ('proposed', 'confirmed', 'retired')),
    recorded_at   TEXT NOT NULL,
    confirmed_by  TEXT,
    confirmed_at  TEXT,
    stale_since   TEXT,
    CHECK ((repo IS NULL) <> (system IS NULL))
  );
  CREATE INDEX facts_by_repo ON facts(repo);
  CREATE INDEX facts_by_system ON facts(system);

  CREATE VIRTUAL TABLE fact_search USING fts5(text, quote, content = 'facts', content_rowid = 'id', tokenize = 'porter unicode61');
  CREATE TRIGGER facts_index AFTER INSERT ON facts BEGIN
    INSERT INTO fact_search (rowid, text, quote) VALUES (new.id, new.text, new.quote);
  END;
  CREATE TRIGGER facts_unindex AFTER DELETE ON facts BEGIN
    INSERT INTO fact_search (fact_search, rowid, text, quote) VALUES ('delete', old.id, old.text, old.quote);
  END;
  CREATE TRIGGER facts_reindex AFTER UPDATE OF text, quote ON facts BEGIN
    INSERT INTO fact_search (fact_search, rowid, text, quote) VALUES ('delete', old.id, old.text, old.quote);
    INSERT INTO fact_search (rowid, text, quote) VALUES (new.id, new.text, new.quote);
  END;

  CREATE TABLE gaps (
    id       INTEGER PRIMARY KEY,
    tool     TEXT NOT NULL,
    query    TEXT NOT NULL,
    repos    TEXT NOT NULL,
    asked_at TEXT NOT NULL
  );
  `,
  // A fact can replace an earlier one ("the cap is now 1000, not 500"). The earlier fact is
  // retired when the new one is confirmed, so the two never both stand.
  `
  ALTER TABLE facts ADD COLUMN replaces INTEGER REFERENCES facts(id) ON DELETE SET NULL;
  `,
  // B3b: what Claude Code found the code does about each fact, per repo, and whether a fact's
  // anchors came from such a check rather than from a person.
  `
  CREATE TABLE fact_checks (
    fact       INTEGER NOT NULL REFERENCES facts(id) ON DELETE CASCADE,
    repo       TEXT NOT NULL REFERENCES repos(name) ON DELETE CASCADE,
    commit_sha TEXT NOT NULL,
    verdict    TEXT NOT NULL CHECK (verdict IN ('agrees', 'contradicts', 'absent', 'unclear')),
    summary    TEXT NOT NULL,
    cites      TEXT NOT NULL,
    looked_at  TEXT NOT NULL,
    fact_text  TEXT NOT NULL,
    checked_at TEXT NOT NULL,
    cost_usd   REAL NOT NULL,
    PRIMARY KEY (fact, repo)
  );
  ALTER TABLE facts ADD COLUMN anchors_found INTEGER NOT NULL DEFAULT 0;
  `,
];
