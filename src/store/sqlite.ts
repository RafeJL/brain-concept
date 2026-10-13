import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { FactRecord, Gap, GapSummary, NewFact } from "../core/facts.js";
import type { Seam, SeamCoverage, SeamKind } from "../core/seams.js";
import type { SystemRecord } from "../core/systems.js";
import { BrainError, type FileRecord, type LanguageShare, type RepoRecord, type RepoState, type WikiPage } from "../core/types.js";
import { MIGRATIONS } from "./migrations.js";
import { indexPage, indexSeam, SEARCH_WEIGHTS } from "./search-index.js";
import type { FactChange, FactFilter, SearchFilter, SearchPage, SeamFilter, SeamUpdate, SectionHit, Store, SyncUpdate } from "./store.js";

type Row = Record<string, unknown>;

/** Local POC store. Pass ":memory:" for tests. */
export class SqliteStore implements Store {
  private readonly db: DatabaseSync;

  constructor(file: string) {
    if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    // busy_timeout: background syncs started by git hooks can overlap (a pull fires a fetch and a
    // merge); the second waits for the first instead of failing.
    this.db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 10000;");
    this.migrate();
  }

  private migrate(): void {
    const { user_version: current } = this.db.prepare("PRAGMA user_version").get() as { user_version: number };
    for (let version = current; version < MIGRATIONS.length; version++) {
      this.transaction(() => {
        const migration = MIGRATIONS[version]!;
        if (typeof migration === "string") this.db.exec(migration);
        else migration(this.db);
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

  setRepoRef(name: string, ref: string): boolean {
    return Number(this.db.prepare("UPDATE repos SET ref = ? WHERE name = ?").run(ref, name).changes) > 0;
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
        seamsCommit: row.seams_commit === null ? null : String(row.seams_commit),
        pagesFailedAt: row.pages_failed_at === null ? null : String(row.pages_failed_at),
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

  applySync(repo: string, update: SyncUpdate): void {
    const upsert = this.db.prepare(
      `INSERT INTO files (repo, path, blob, bytes, language, commit_sha) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (repo, path) DO UPDATE SET
         blob = excluded.blob, bytes = excluded.bytes, language = excluded.language, commit_sha = excluded.commit_sha`,
    );
    // Removing a file cascades to its seams.
    const remove = this.db.prepare("DELETE FROM files WHERE repo = ? AND path = ?");
    const state = this.db.prepare(
      `INSERT INTO repo_state (repo, commit_sha, synced_at, file_count) VALUES (?, ?, ?, ?)
       ON CONFLICT (repo) DO UPDATE SET
         commit_sha = excluded.commit_sha, synced_at = excluded.synced_at, file_count = excluded.file_count`,
    );
    this.transaction(() => {
      for (const f of update.upsert) upsert.run(repo, f.path, f.blob, f.bytes, f.language, f.commit);
      for (const path of update.remove) remove.run(repo, path);
      state.run(repo, update.commit, new Date().toISOString(), update.fileCount);
    });
  }

  replaceSeams(repo: string, update: SeamUpdate): void {
    const clearAll = this.db.prepare("DELETE FROM seams WHERE repo = ?");
    const clear = this.db.prepare("DELETE FROM seams WHERE repo = ? AND path = ?");
    const insert = this.db.prepare(
      `INSERT INTO seams (repo, path, kind, method, raw_path, route_key, start_line, end_line, cites, commit_sha)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const state = this.db.prepare("UPDATE repo_state SET seams_commit = ? WHERE repo = ?");
    this.transaction(() => {
      if (update.paths === null) clearAll.run(repo);
      else for (const path of update.paths) clear.run(repo, path);
      for (const s of update.seams) {
        const { lastInsertRowid } = insert.run(repo, s.path, s.kind, s.method, s.rawPath, s.key, s.startLine, s.endLine, JSON.stringify(s.cites), s.commit);
        indexSeam(this.db, Number(lastInsertRowid), s);
      }
      state.run(update.commit, repo);
    });
  }

  seams(filter: SeamFilter): Seam[] {
    if (filter.repos.length === 0) return [];
    const where = [`repo IN (${filter.repos.map(() => "?").join(", ")})`];
    const params: string[] = [...filter.repos];
    if (filter.kind) {
      where.push("kind = ?");
      params.push(filter.kind);
    }
    if (filter.path) {
      where.push("path = ?");
      params.push(filter.path);
    }
    if (!filter.includeUnresolved) where.push("route_key IS NOT NULL");
    const rows = this.db
      .prepare(`SELECT * FROM seams WHERE ${where.join(" AND ")} ORDER BY repo, path, start_line`)
      .all(...params) as Row[];
    return rows.map(toSeam);
  }

  seamCoverage(repo: string): SeamCoverage {
    const counts = this.db
      .prepare(
        `SELECT
           SUM(kind = 'http-route') AS routes,
           SUM(kind = 'http-call' AND route_key IS NOT NULL) AS calls,
           SUM(kind = 'http-call' AND route_key IS NULL) AS unresolved
         FROM seams WHERE repo = ?`,
      )
      .get(repo) as Row;
    const links = this.db
      .prepare(
        `SELECT kind, COUNT(*) AS count, SUM(route_key IS NULL) AS runtime
         FROM seams WHERE repo = ? AND kind NOT LIKE 'http-%' GROUP BY kind ORDER BY kind`,
      )
      .all(repo) as Row[];
    return {
      routes: Number(counts.routes ?? 0),
      calls: Number(counts.calls ?? 0),
      unresolvedCalls: Number(counts.unresolved ?? 0),
      links: links.map((row) => ({ kind: String(row.kind) as SeamKind, count: Number(row.count), runtime: Number(row.runtime ?? 0) })),
    };
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

  setPagesFailedAt(repo: string, commit: string | null): void {
    this.db.prepare("UPDATE repo_state SET pages_failed_at = ? WHERE repo = ?").run(commit, repo);
  }

  replacePages(repo: string, pages: readonly WikiPage[]): void {
    const insert = this.db.prepare(
      `INSERT INTO pages (repo, slug, position, title, markdown, commit_sha, claims, removed, model, cost_usd, generated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.transaction(() => {
      this.db.prepare("DELETE FROM pages WHERE repo = ?").run(repo);
      // Deleting the pages deletes their sections and search rows.
      pages.forEach((p, i) => {
        insert.run(repo, p.slug, i, p.title, p.markdown, p.commit, p.claims, p.removed, p.model, p.costUsd, p.generatedAt);
        indexPage(this.db, repo, p.slug, p.title, p.markdown);
      });
    });
  }

  pages(repo: string): WikiPage[] {
    const rows = this.db.prepare("SELECT * FROM pages WHERE repo = ? ORDER BY position").all(repo) as Row[];
    return rows.map((row) => ({
      repo: String(row.repo),
      slug: String(row.slug),
      title: String(row.title),
      markdown: String(row.markdown),
      commit: String(row.commit_sha),
      claims: Number(row.claims),
      removed: Number(row.removed),
      model: String(row.model),
      costUsd: Number(row.cost_usd),
      generatedAt: String(row.generated_at),
    }));
  }

  searchSections(filter: SearchFilter): SearchPage<SectionHit> {
    const { where, params } = searchWhere(filter, 0);
    const { total, repos } = this.searchCounts(where, params);
    const words = filter.snippetWords ?? 24;
    const rows = this.db
      .prepare(
        `SELECT sections.repo, sections.slug, sections.heading, sections.paths, pages.title,
                snippet(search, 3, '', '', '…', ${Math.max(1, Math.min(64, words))}) AS snippet,
                -bm25(search, ${SEARCH_WEIGHTS}) AS score
         FROM search
         JOIN sections ON sections.id = search.rowid / 2
         JOIN pages ON pages.repo = sections.repo AND pages.slug = sections.slug
         WHERE ${where}
         ORDER BY bm25(search, ${SEARCH_WEIGHTS}), sections.repo, pages.position, sections.position
         LIMIT ? OFFSET ?`,
      )
      .all(...params, filter.limit, filter.offset ?? 0) as Row[];
    return {
      total,
      repos,
      hits: rows.map((row) => ({
        repo: String(row.repo),
        slug: String(row.slug),
        pageTitle: String(row.title),
        heading: String(row.heading),
        snippet: String(row.snippet),
        paths: String(row.paths).split(" ").filter(Boolean),
        score: Number(row.score),
      })),
    };
  }

  searchSeams(filter: SearchFilter): SearchPage<Seam> {
    // Only the method and path: a file under tests/ says nothing about which endpoint is meant.
    const { where, params } = searchWhere({ ...filter, match: `title : (${filter.match})` }, 1);
    const { total, repos } = this.searchCounts(where, params);
    const rows = this.db
      .prepare(
        `SELECT seams.* FROM search
         JOIN seams ON seams.id = (search.rowid - 1) / 2
         WHERE ${where}
         ORDER BY bm25(search, ${SEARCH_WEIGHTS}), seams.repo, seams.path, seams.start_line
         LIMIT ? OFFSET ?`,
      )
      .all(...params, filter.limit, filter.offset ?? 0) as Row[];
    return { total, repos, hits: rows.map(toSeam) };
  }

  /** How many rows match, and in which repos, for the answer's header and paging. */
  private searchCounts(where: string, params: string[]): { total: number; repos: string[] } {
    const rows = this.db.prepare(`SELECT repo, COUNT(*) AS n FROM search WHERE ${where} GROUP BY repo ORDER BY repo`).all(...params) as Row[];
    return { total: rows.reduce((sum, row) => sum + Number(row.n), 0), repos: rows.map((row) => String(row.repo)) };
  }

  systems(): SystemRecord[] {
    const members = new Map<number, string[]>();
    for (const row of this.db.prepare("SELECT system, repo FROM system_repos ORDER BY repo").all() as Row[]) {
      members.set(Number(row.system), [...(members.get(Number(row.system)) ?? []), String(row.repo)]);
    }
    const rows = this.db.prepare("SELECT * FROM systems ORDER BY name").all() as Row[];
    return rows.map((row) => ({
      name: String(row.name),
      summary: String(row.summary),
      reason: String(row.reason),
      status: String(row.status) as SystemRecord["status"],
      suggestedAt: row.suggested_at === null ? null : String(row.suggested_at),
      confirmedAt: row.confirmed_at === null ? null : String(row.confirmed_at),
      repos: members.get(Number(row.id)) ?? [],
    }));
  }

  replaceSuggestedSystems(systems: readonly Pick<SystemRecord, "name" | "summary" | "reason" | "repos">[]): void {
    const insert = this.db.prepare("INSERT INTO systems (name, summary, reason, status, suggested_at) VALUES (?, ?, ?, 'suggested', ?)");
    const member = this.db.prepare("INSERT INTO system_repos (repo, system) VALUES (?, ?)");
    const now = new Date().toISOString();
    this.transaction(() => {
      // Deleting a system deletes its members and its search row.
      this.db.exec("DELETE FROM systems WHERE status = 'suggested'");
      for (const system of systems) {
        const { lastInsertRowid } = insert.run(system.name, system.summary, system.reason, now);
        for (const repo of system.repos) member.run(repo, Number(lastInsertRowid));
      }
    });
  }

  confirmSystems(names: readonly string[] | null): string[] {
    const confirm = this.db.prepare("UPDATE systems SET status = 'confirmed', confirmed_at = ? WHERE id = ? AND status = 'suggested'");
    const candidates = this.systemRows().filter((row) => row.status === "suggested" && (!names || names.some((n) => n.toLowerCase() === String(row.name).toLowerCase())));
    const now = new Date().toISOString();
    this.transaction(() => {
      for (const row of candidates) confirm.run(now, Number(row.id));
    });
    return candidates.map((row) => String(row.name));
  }

  setSystem(name: string, repos: readonly string[], summary?: string): void {
    const member = this.db.prepare("INSERT INTO system_repos (repo, system) VALUES (?, ?) ON CONFLICT (repo) DO UPDATE SET system = excluded.system");
    const now = new Date().toISOString();
    this.transaction(() => {
      let id = this.systemId(name);
      if (id === undefined) {
        id = Number(this.db.prepare("INSERT INTO systems (name, summary, reason, status, confirmed_at) VALUES (?, ?, '', 'confirmed', ?)").run(name, summary ?? "", now).lastInsertRowid);
      } else {
        this.db
          .prepare("UPDATE systems SET summary = COALESCE(?, summary), status = 'confirmed', confirmed_at = COALESCE(confirmed_at, ?) WHERE id = ?")
          .run(summary ?? null, now, id);
      }
      for (const repo of repos) member.run(repo, id);
    });
  }

  renameSystem(name: string, to: string): boolean {
    const id = this.systemId(name);
    if (id === undefined) return false;
    const taken = this.systemId(to);
    if (taken !== undefined && taken !== id) throw new BrainError(`There is already a system named "${to}".`);
    this.db.prepare("UPDATE systems SET name = ? WHERE id = ?").run(to, id);
    return true;
  }

  removeSystem(name: string): boolean {
    return Number(this.db.prepare("DELETE FROM systems WHERE name = ?").run(name).changes) > 0;
  }

  searchSystems(match: string): string[] {
    const rows = this.db
      .prepare("SELECT systems.name FROM system_search JOIN systems ON systems.id = system_search.rowid WHERE system_search MATCH ? ORDER BY bm25(system_search), systems.name")
      .all(match) as Row[];
    return rows.map((row) => String(row.name));
  }

  addFact(fact: NewFact): number {
    let system: number | null = null;
    if (fact.system !== null) {
      system = this.systemId(fact.system) ?? null;
      if (system === null) throw new BrainError(`There is no system named "${fact.system}".`);
    }
    const { lastInsertRowid } = this.db
      .prepare(
        `INSERT INTO facts (repo, system, kind, text, quote, stated_by, ticket, anchors, anchor_commit, status, recorded_at, confirmed_by, confirmed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        fact.repo,
        system,
        fact.kind,
        fact.text,
        fact.quote,
        fact.statedBy,
        fact.ticket,
        JSON.stringify(fact.anchors),
        fact.anchorCommit,
        fact.status,
        fact.recordedAt,
        fact.confirmedBy,
        fact.confirmedAt,
      );
    return Number(lastInsertRowid);
  }

  getFact(id: number): FactRecord | undefined {
    const row = this.db.prepare(`${FACT_SELECT} WHERE facts.id = ?`).get(id) as Row | undefined;
    return row && toFact(row);
  }

  facts(filter: FactFilter): FactRecord[] {
    const { where, params } = factWhere(filter);
    return (this.db.prepare(`${FACT_SELECT} WHERE ${where} ORDER BY facts.recorded_at DESC, facts.id DESC`).all(...params) as Row[]).map(toFact);
  }

  updateFact(id: number, change: FactChange): boolean {
    const columns: Record<keyof FactChange, string> = {
      text: "text",
      status: "status",
      confirmedBy: "confirmed_by",
      confirmedAt: "confirmed_at",
      staleSince: "stale_since",
      anchors: "anchors",
      anchorCommit: "anchor_commit",
    };
    const keys = (Object.keys(change) as (keyof FactChange)[]).filter((key) => change[key] !== undefined);
    if (keys.length === 0) return this.getFact(id) !== undefined;
    const values = keys.map((key) => (key === "anchors" ? JSON.stringify(change.anchors) : (change[key] as string | null)));
    const set = keys.map((key) => `${columns[key]} = ?`).join(", ");
    return Number(this.db.prepare(`UPDATE facts SET ${set} WHERE id = ?`).run(...values, id).changes) > 0;
  }

  searchFacts(filter: FactFilter & { match: string; limit: number }): FactRecord[] {
    const { where, params } = factWhere(filter);
    return (
      this.db
        .prepare(`${FACT_SELECT} JOIN fact_search ON fact_search.rowid = facts.id WHERE fact_search MATCH ? AND ${where} ORDER BY facts.status <> 'confirmed', facts.stale_since IS NOT NULL, bm25(fact_search) LIMIT ?`)
        .all(filter.match, ...params, filter.limit) as Row[]
    ).map(toFact);
  }

  logGap(gap: Gap): void {
    this.db.prepare("INSERT INTO gaps (tool, query, repos, asked_at) VALUES (?, ?, ?, ?)").run(gap.tool, gap.query, gap.repos.join(" "), gap.askedAt);
  }

  gaps(limit: number): GapSummary[] {
    const rows = this.db
      .prepare(
        `SELECT MIN(query) AS query, GROUP_CONCAT(DISTINCT tool) AS tools, COUNT(*) AS times, MAX(asked_at) AS last_asked
         FROM gaps GROUP BY LOWER(TRIM(query)) ORDER BY times DESC, last_asked DESC LIMIT ?`,
      )
      .all(limit) as Row[];
    return rows.map((row) => ({ query: String(row.query), tools: String(row.tools).split(","), times: Number(row.times), lastAsked: String(row.last_asked) }));
  }

  private systemRows(): Row[] {
    return this.db.prepare("SELECT * FROM systems ORDER BY name").all() as Row[];
  }

  private systemId(name: string): number | undefined {
    const row = this.db.prepare("SELECT id FROM systems WHERE name = ?").get(name) as Row | undefined;
    return row && Number(row.id);
  }

  close(): void {
    this.db.close();
  }
}

const FACT_SELECT = "SELECT facts.*, systems.name AS system_name FROM facts LEFT JOIN systems ON systems.id = facts.system";

/** Facts on the filter's repos or systems, leaving out retired ones unless asked. */
function factWhere(filter: FactFilter): { where: string; params: string[] } {
  const marks = (items: readonly string[]) => items.map(() => "?").join(", ");
  const targets = [
    ...(filter.repos.length ? [`facts.repo IN (${marks(filter.repos)})`] : []),
    ...(filter.systems.length ? [`systems.name IN (${marks(filter.systems)})`] : []),
  ];
  const where = targets.length ? `(${targets.join(" OR ")})` : "0";
  return { where: filter.retired ? where : `${where} AND facts.status <> 'retired'`, params: [...filter.repos, ...filter.systems] };
}

function toFact(row: Row): FactRecord {
  const optional = (value: unknown) => (value === null ? null : String(value));
  return {
    id: Number(row.id),
    repo: optional(row.repo),
    system: optional(row.system_name),
    kind: String(row.kind) as FactRecord["kind"],
    text: String(row.text),
    quote: String(row.quote),
    statedBy: String(row.stated_by),
    ticket: optional(row.ticket),
    anchors: JSON.parse(String(row.anchors)) as FactRecord["anchors"],
    anchorCommit: optional(row.anchor_commit),
    status: String(row.status) as FactRecord["status"],
    recordedAt: String(row.recorded_at),
    confirmedBy: optional(row.confirmed_by),
    confirmedAt: optional(row.confirmed_at),
    staleSince: optional(row.stale_since),
  };
}

/** Rows of one kind (0 sections, 1 seams) matching the search in the given repos. */
function searchWhere(filter: SearchFilter, kind: 0 | 1): { where: string; params: string[] } {
  if (filter.repos.length === 0) return { where: "0", params: [] };
  const repos = filter.repos.map(() => "?").join(", ");
  return { where: `search MATCH ? AND search.rowid % 2 = ${kind} AND search.repo IN (${repos})`, params: [filter.match, ...filter.repos] };
}

function toSeam(row: Row): Seam {
  return {
    repo: String(row.repo),
    path: String(row.path),
    kind: String(row.kind) as Seam["kind"],
    method: String(row.method),
    rawPath: String(row.raw_path),
    key: row.route_key === null ? null : String(row.route_key),
    startLine: Number(row.start_line),
    endLine: Number(row.end_line),
    cites: JSON.parse(String(row.cites)) as Seam["cites"],
    commit: String(row.commit_sha),
  };
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
