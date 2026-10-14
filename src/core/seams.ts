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
  /**
   * A route a class gets from the base class it derives from (`EmployeeController` serving the
   * CRUD actions of `AtlasEntityApiController`), worked out by the brain from the survey's rule
   * rather than listed by Claude Code. Cited and checked like any route.
   */
  derived?: boolean;
}

/**
 * What a full map made of one piece of a file (the whole file, or a range of a long one), for each
 * of its two runs: HTTP, and the other links. "unflagged": screening read it and found nothing to
 * map; "mapped": a checked seam is declared in it; "none": the mapping run read it and found
 * none; "unmapped": no run answered for it, so what it declares is unknown.
 */
export type PieceOutcome = "unflagged" | "mapped" | "none" | "unmapped";

export interface SeamPiece {
  path: string;
  start: number;
  end: number;
  http: PieceOutcome;
  links: PieceOutcome;
}

/**
 * What a survey run found about how a repo forms its routes, given to every mapping run and used
 * to work out inherited routes. Each part was checked against the lines it cites.
 */
export interface LinkSurvey {
  /** Convention route templates, as written: `api/{controller}/{action}/{id}`. */
  templates: { template: string; cites: SeamCite[] }[];
  /** Base classes whose public methods are routes of every class derived from them. */
  inherited: InheritedRoutes[];
  /** Files holding settings such as base URLs and queue names. */
  configFiles: string[];
}

export interface InheritedRoutes {
  /** The base class's name, without type parameters: `AtlasEntityApiController`. */
  base: string;
  /** What a derived class's name drops to fill `{controller}`: "Controller". Empty when nothing. */
  suffix: string;
  /** The routes each derived class serves, with `{controller}` in the path. */
  routes: { method: string; path: string; cites: SeamCite[] }[];
  /** The base class's declaration. */
  cites: SeamCite[];
}

export interface SeamCoverage {
  routes: number;
  calls: number;
  unresolvedCalls: number;
  /** Events, gRPC and packages: how many of each kind there are, and how many have a run-time name. */
  links: Array<{ kind: SeamKind; count: number; runtime: number }>;
}
