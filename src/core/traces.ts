import type { Seam, SeamKind } from "./seams.js";

/**
 * Where handling starts in a repo: a route it serves, an event it handles, a gRPC method it
 * serves (all links the brain already maps), or something that starts on its own or from a
 * person: a job (a timer, background worker or start-up task) or a UI action (a page or
 * component a person triggers).
 */
export type EntryKind = "http-route" | "event-subscribe" | "grpc-serve" | "job" | "ui";
/** Where handling leaves the repo: a call it makes, an event it publishes, a gRPC call. */
export type ExitKind = "http-call" | "event-publish" | "grpc-call";

export const ENTRY_KINDS: readonly SeamKind[] = ["http-route", "event-subscribe", "grpc-serve"];
export const EXIT_KINDS: readonly SeamKind[] = ["http-call", "event-publish", "grpc-call"];

/** One step of a chain: lines read, and the function they call next (none on the last step). */
export interface TraceStep {
  path: string;
  start: number;
  end: number;
  calls?: string;
}

/** What one entry point's handling reaches: an exit point, a table, or nothing at all. */
export type TraceTarget =
  | { type: "exit"; ref: string }
  | { type: "table"; name: string; access: "read" | "write" }
  | { type: "none" }
  /** No chain held at this commit: recorded so it isn't asked about again until its code changes. */
  | { type: "unmapped"; reason: string };

/**
 * One checked chain from an entry point to what it reaches, stored per repo. An entry that
 * reaches nothing has one link of type "none", so "ends here" is a cited fact, not a gap.
 */
export interface TraceLink {
  repo: string;
  /** The entry point's ref (see `seamRef`, or `job Name @path`). */
  entry: string;
  entryKind: EntryKind;
  /** As shown in answers: `POST /api/orders`, `GracePeriodManagerService`. */
  entryLabel: string;
  entryPath: string;
  entryLine: number;
  target: TraceTarget;
  steps: TraceStep[];
  commit: string;
}

/** A link's stable name within its repo: kind and method and path, or kind and name. Survives re-mapping. */
export function seamRef(seam: Pick<Seam, "kind" | "method" | "rawPath">): string {
  return seam.kind.startsWith("http-") ? `${seam.kind} ${seam.method} ${seam.rawPath}` : `${seam.kind} ${seam.rawPath}`;
}

/** A job's or UI action's ref: its kind, name and file. */
export function foundRef(kind: "job" | "ui", name: string, path: string): string {
  return `${kind} ${name} @${path}`;
}
