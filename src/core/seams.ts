/** A place where one repo meets another: a route it serves or a call it makes. */
export type SeamKind = "http-route" | "http-call";

/** Lines in a file, 1-based and inclusive. */
export interface SeamCite {
  path: string;
  start: number;
  end: number;
}

/** A route or call Claude Code found and the brain verified against the lines it cites. */
export interface Seam {
  repo: string;
  /** The file that declares it: the route registration, the call site, the spec. */
  path: string;
  kind: SeamKind;
  /** GET, POST, ... or "*" for any method. */
  method: string;
  /** The full path as served or called, or the expression as written for a run-time URL. */
  rawPath: string;
  /** Normalised key used for matching (see core/http.ts). Null for a run-time URL. */
  key: string | null;
  /** The declaring lines in `path`, 1-based and inclusive. */
  startLine: number;
  endLine: number;
  /** Other lines that contribute part of the path: a global prefix, a router mount, a base URL. */
  cites: SeamCite[];
  commit: string;
}

export interface SeamCoverage {
  routes: number;
  calls: number;
  unresolvedCalls: number;
}
