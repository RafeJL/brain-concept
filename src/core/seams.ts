/** A place where one repo meets another: a route it serves or a call it makes. */
export type SeamKind = "http-route" | "http-call";

/** What an extractor finds in one file, before the sync knows the repo and commit. */
export interface SeamDraft {
  kind: SeamKind;
  /** GET, POST, ... or "*" for any method. */
  method: string;
  /** The path or URL expression as written in the source, for display. */
  rawPath: string;
  /** Normalised key used for matching (see core/http.ts). Null for an unresolved call. */
  key: string | null;
  /** 1-based, inclusive. */
  startLine: number;
  endLine: number;
  plugin: string;
}

export interface Seam extends SeamDraft {
  repo: string;
  path: string;
  commit: string;
}

export interface SeamCoverage {
  routes: number;
  calls: number;
  unresolvedCalls: number;
  plugins: string[];
}
