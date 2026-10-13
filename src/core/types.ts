/** A repository enrolled in the registry. The repo is the unit of work, permission and deletion. */
export interface RepoRecord {
  name: string;
  /** Absolute path to the local clone (POC) or worker cache (hosted). */
  path: string;
  /** The ref whose committed tree is indexed, e.g. "main". Never the working copy. */
  ref: string;
  /** origin URL with any credentials stripped, or null when there is no origin. */
  remote: string | null;
  enrolledAt: string;
  /** What a person wants the wiki to focus on; steers which pages are written and what they stress. */
  note: RepoNote | null;
  /** A note an agent proposed where the person couldn't be asked; it steers nothing until confirmed. */
  proposedNote: RepoNote | null;
}

/** A steering note on a repo's wiki, and who set it. */
export interface RepoNote {
  text: string;
  by: string;
  at: string;
  /** The person's words agreeing to it, when they set it in a conversation with an agent. */
  with?: string;
}

/** The commit a repo's facts currently describe. */
export interface RepoState {
  repo: string;
  commit: string;
  syncedAt: string;
  fileCount: number;
  /** The commit the stored seams describe; null until Claude Code first lists them. */
  seamsCommit: string | null;
  /**
   * The commit at which a page every wiki should have was written and failed the check. It isn't
   * tried again until the code moves on (or `--full`), so a page that keeps failing costs once per
   * change, not once per sync.
   */
  pagesFailedAt: string | null;
  /** The commit the wiki's page plan was made at; null for a repo without one (a small repo). */
  planCommit: string | null;
  /** The steering note the plan was made with, so a changed note plans again. */
  planNote: string | null;
}

/** One file in a repo's committed tree. */
export interface FileRecord {
  repo: string;
  path: string;
  /** Git blob sha; unchanged blobs are skipped on the next sync. */
  blob: string;
  bytes: number;
  language: string | null;
  /** The sync commit at which this blob was last read. */
  commit: string;
}

/** One AI-written wiki page about a repo, describing the commit it was generated from. */
export interface WikiPage {
  repo: string;
  /** Stable id within the repo, e.g. "overview", "build-run-test". */
  slug: string;
  title: string;
  kind: PageKind;
  /** Markdown in which every claim cites `[path:start-end]`. */
  markdown: string;
  commit: string;
  /** Claims the citation checker examined, and how many it removed (0 and 0 for pages stored before it existed). */
  claims: number;
  removed: number;
  model: string;
  costUsd: number;
  generatedAt: string;
}

/**
 * What a page is about: one of the pages every wiki has, a part of the repo, a journey through
 * several parts, the data model, or the outside systems it talks to.
 */
export type PageKind = "core" | "area" | "flow" | "data-model" | "integrations";
export const PAGE_KINDS: readonly PageKind[] = ["core", "area", "flow", "data-model", "integrations"];

/** One page of a large repo's plan: what to write, and where to start reading. */
export interface PlannedPage {
  slug: string;
  title: string;
  kind: PageKind;
  /** One line on what the page covers. */
  brief: string;
  /** Folders the page covers; a new project or area outside all of them plans again. */
  covers: string[];
  /** The files to start reading from. */
  keyFiles: string[];
}

export interface LanguageShare {
  language: string;
  files: number;
  bytes: number;
}

/**
 * Where enrolling a repo has got to. Enrolling runs in the background for minutes or longer, so it
 * is kept where both the process doing it and the MCP server can read it.
 */
export interface Enrolment {
  /** The name the repo is, or will be, enrolled under. */
  repo: string;
  /** What the person gave: a local path, a GitHub URL or owner/repo. */
  source: string;
  status: "running" | "failed" | "done";
  /** What it is doing now, in words ("cloning it", "writing the wiki (4 of 18 pages)"); when failed, the step that failed. */
  step: string;
  /** Why it failed. */
  error: string | null;
  /** The process doing it. A running enrolment whose process has gone stopped without finishing. */
  pid: number | null;
  /** Files in the repo's tree, once known. */
  files: number | null;
  /** How long and how much the whole enrolment should take, once its size is known. */
  estimate: EnrolmentEstimate | null;
  /** What Claude Code cost so far. */
  costUsd: number;
  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

export interface EnrolmentEstimate {
  minutes: [number, number];
  costUsd: [number, number];
  /** What it is based on: earlier enrolments of repos of a similar size, or the size alone ("rough"). */
  basis: string;
}

export interface Freshness {
  commit: string;
  /** Commits on the tracked ref since the indexed commit; null when that can't be worked out. */
  commitsBehind: number | null;
  syncedAt: string;
}

/** A failure the user can act on; printed without a stack trace. */
export class BrainError extends Error {
  override name = "BrainError";
}
