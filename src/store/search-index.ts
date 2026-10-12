import type { DatabaseSync } from "node:sqlite";
import { searchWords, splitSections } from "../core/sections.js";
import { KIND_LABEL, type SeamKind } from "../core/seams.js";

/**
 * The search index: one FTS5 row per wiki section and per seam. A section's row id is twice its
 * `sections.id`, a seam's twice its `seams.id` plus one, so one table ranks both. Rows are added
 * in code (sections need splitting, paths need their camelCase words) and removed by triggers,
 * so a page rewrite, a seam update, a deleted file or a removed repo can't leave stale rows.
 */
export const SEARCH_SCHEMA = `
  CREATE TABLE sections (
    id       INTEGER PRIMARY KEY,
    repo     TEXT NOT NULL,
    slug     TEXT NOT NULL,
    position INTEGER NOT NULL,
    heading  TEXT NOT NULL,
    body     TEXT NOT NULL,
    paths    TEXT NOT NULL,
    FOREIGN KEY (repo, slug) REFERENCES pages(repo, slug) ON DELETE CASCADE
  );
  CREATE INDEX sections_by_page ON sections(repo, slug);

  CREATE VIRTUAL TABLE search USING fts5(repo, title, heading, body, paths, tokenize = 'porter unicode61');

  CREATE TRIGGER sections_unindex AFTER DELETE ON sections BEGIN
    DELETE FROM search WHERE rowid = old.id * 2;
  END;
  CREATE TRIGGER seams_unindex AFTER DELETE ON seams BEGIN
    DELETE FROM search WHERE rowid = old.id * 2 + 1;
  END;
`;

/**
 * Column weights for repo, page title, heading, body and paths. A section's heading decides most.
 * The page title counts like body text: every section of "Build, run and test" carries it, so
 * weighting it more ranked that page's shortest section first for any build question. The repo
 * name is searched too, so "tests in eshop" puts eshop's sections first. Tuned on the W5 gate
 * questions.
 */
export const SEARCH_WEIGHTS = "1, 1, 4, 1, 1";

/** Splits a stored page into sections and indexes each. */
export function indexPage(db: DatabaseSync, repo: string, slug: string, title: string, markdown: string): void {
  const insert = db.prepare("INSERT INTO sections (repo, slug, position, heading, body, paths) VALUES (?, ?, ?, ?, ?, ?)");
  const index = db.prepare("INSERT INTO search (rowid, repo, title, heading, body, paths) VALUES (?, ?, ?, ?, ?, ?)");
  splitSections(markdown).forEach((section, i) => {
    const paths = section.paths.join(" ");
    const { lastInsertRowid } = insert.run(repo, slug, i, section.heading, section.body, paths);
    index.run(Number(lastInsertRowid) * 2, repo, title, section.heading, section.body, searchWords(paths));
  });
}

/**
 * Indexes a stored seam: `GET /api/orders/{id}` (or `event OrderStarted`) as its title, its kind
 * as heading, its file as path.
 */
export function indexSeam(db: DatabaseSync, id: number, seam: { repo: string; path: string; kind: string; method: string; rawPath: string }): void {
  db.prepare("INSERT INTO search (rowid, repo, title, heading, body, paths) VALUES (?, ?, ?, ?, '', ?)").run(
    id * 2 + 1,
    seam.repo,
    searchWords(`${seam.method} ${seam.rawPath}`),
    KIND_LABEL[seam.kind as SeamKind] ?? seam.kind,
    searchWords(seam.path),
  );
}

/** Migration 8: the index, filled from the pages and seams already stored, so nobody re-syncs. */
export function createSearchIndex(db: DatabaseSync): void {
  db.exec(SEARCH_SCHEMA);
  for (const page of db.prepare("SELECT repo, slug, title, markdown FROM pages").all()) {
    indexPage(db, String(page.repo), String(page.slug), String(page.title), String(page.markdown));
  }
  for (const seam of db.prepare("SELECT id, repo, path, kind, method, raw_path FROM seams").all()) {
    indexSeam(db, Number(seam.id), {
      repo: String(seam.repo),
      path: String(seam.path),
      kind: String(seam.kind),
      method: String(seam.method),
      rawPath: String(seam.raw_path ?? ""),
    });
  }
}
