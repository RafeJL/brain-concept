import type { Citation } from "./citations.js";

/**
 * A place where one repo meets another. Each family has a kind that provides something (a route
 * served, an event published, a gRPC method served, a package published) and a kind that uses
 * it (a call, a subscription, a gRPC call, a dependency).
 */
export type SeamKind =
  | "http-route"
  | "http-call"
  | "event-publish"
  | "event-subscribe"
  | "grpc-serve"
  | "grpc-call"
  | "package-publish"
  | "package-use";

export type SeamFamily = "http" | "event" | "grpc" | "package";

/** Each family's providing and using kind. */
export const FAMILIES: Record<SeamFamily, { provides: SeamKind; uses: SeamKind }> = {
  http: { provides: "http-route", uses: "http-call" },
  event: { provides: "event-publish", uses: "event-subscribe" },
  grpc: { provides: "grpc-serve", uses: "grpc-call" },
  package: { provides: "package-publish", uses: "package-use" },
};

/** How each kind is named in answers and in the search index. */
export const KIND_LABEL: Record<SeamKind, string> = {
  "http-route": "route",
  "http-call": "call",
  "event-publish": "event published",
  "event-subscribe": "event handled",
  "grpc-serve": "gRPC served",
  "grpc-call": "gRPC call",
  "package-publish": "package published",
  "package-use": "package used",
};

export function familyOf(kind: SeamKind): SeamFamily {
  return kind.split("-")[0] as SeamFamily;
}

/** Whether a seam is something other repos use (a route, a published event…) rather than a use of one. */
export function isProvider(kind: SeamKind): boolean {
  return FAMILIES[familyOf(kind)].provides === kind;
}

/** Lines in a file that a seam's path is built from: the same shape as a wiki citation. */
export type SeamCite = Citation;

/**
 * A seam Claude Code found and the brain verified against the lines it cites. Events, gRPC and
 * packages use the same fields as HTTP, so they need no migration: `method` holds the family
 * ("event", "grpc", "package"), `rawPath` the name as written and `key` its normalised form.
 */
export interface Seam {
  repo: string;
  /** The file that declares it: the route registration, the call site, the spec, the manifest. */
  path: string;
  kind: SeamKind;
  /** GET, POST, ... or "*" for any method; the family for events, gRPC and packages. */
  method: string;
  /** The full path as served or called, or the name; as written when only known at run time. */
  rawPath: string;
  /** Normalised key used for matching (see core/http.ts and core/links.ts). Null when only known at run time. */
  key: string | null;
  /** The declaring lines in `path`, 1-based and inclusive. */
  startLine: number;
  endLine: number;
  /** Other lines that contribute part of the path or name: a global prefix, a router mount, a base URL. */
  cites: SeamCite[];
  commit: string;
}

export interface SeamCoverage {
  routes: number;
  calls: number;
  unresolvedCalls: number;
  /** Events, gRPC and packages: how many of each kind there are, and how many have a run-time name. */
  links: Array<{ kind: SeamKind; count: number; runtime: number }>;
}
