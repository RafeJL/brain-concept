/**
 * How a fact was made, carried on every answer so an agent knows how far to trust it.
 * See docs/architecture.md, "Three kinds of fact".
 */
export type Tier = "parser-built" | "human-reviewed" | "llm-generated";

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
}

/** The commit a repo's facts currently describe. */
export interface RepoState {
  repo: string;
  commit: string;
  syncedAt: string;
  fileCount: number;
  /** EXTRACTOR_VERSION the seams were built with; a mismatch forces a full re-extract. */
  extractorVersion: number;
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
  /** Markdown in which every claim cites `[path:start-end]`. */
  markdown: string;
  commit: string;
  model: string;
  costUsd: number;
  generatedAt: string;
}

export interface LanguageShare {
  language: string;
  files: number;
  bytes: number;
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
