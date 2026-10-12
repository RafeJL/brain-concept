import { familyOf, isProvider, type SeamFamily } from "../core/seams.js";
import type { Store } from "../store/store.js";
import { count, groupRoutes, linkCalls, type SeamLink } from "./tools/common.js";

export interface Neighbour {
  repo: string;
  /** Distinct endpoints called (for `calls`) or calls made (for `calledBy`), over HTTP. */
  count: number;
  /** Whether any of the matches ignored a base path. */
  suffix: boolean;
  /** Links other than HTTP, by family: distinct names used (for `calls`) or uses (for `calledBy`). Absent when none. */
  links?: Partial<Record<Exclude<SeamFamily, "http">, number>>;
}

export interface Neighbours {
  /** Repos serving endpoints this repo calls (or publishing events it handles, serving gRPC it calls, publishing packages it uses). */
  calls: Neighbour[];
  /** Repos calling endpoints this repo serves (or handling its events, calling its gRPC, using its packages). */
  calledBy: Neighbour[];
}

/**
 * The repos a repo talks to, over HTTP, events, gRPC or packages, from the seam graph, among the
 * repos the caller can read. Worked out on every request, never stored: it changes whenever any
 * other repo syncs.
 */
export function neighbours(store: Store, repo: string, readable: readonly string[]): Neighbours {
  const others = readable.filter((name) => name !== repo);
  const providersOf = (repos: readonly string[]) => groupRoutes(store.seams({ repos }).filter((s) => isProvider(s.kind))).map((g) => g.primary);
  const usesOf = (repos: readonly string[]) => store.seams({ repos }).filter((s) => !isProvider(s.kind));
  return {
    calls: tally(linkCalls(usesOf([repo]), providersOf(others), providersOf([repo])), (link) => link.route.repo, (link) => `${link.route.method} ${link.route.key}`),
    calledBy: tally(linkCalls(usesOf(others), providersOf([repo]), providersOf(others)), (link) => link.call.repo, (link) => link.call),
  };
}

/** What a neighbour count counts, by family: what this repo uses of theirs, and their uses of this repo's. */
const NOUNS: Record<SeamFamily, { calls: string; calledBy: string }> = {
  http: { calls: "endpoint", calledBy: "call" },
  event: { calls: "event", calledBy: "handler" },
  grpc: { calls: "gRPC method", calledBy: "gRPC call" },
  package: { calls: "package", calledBy: "package use" },
};

/** "22 endpoints, 2 events" for a repo this one calls, or "5 calls, 1 handler" for one calling it. */
export function linkSummary(neighbour: Neighbour, side: keyof Neighbours): string {
  return [
    ...(neighbour.count ? [count(neighbour.count, NOUNS.http[side])] : []),
    ...Object.entries(neighbour.links ?? {}).map(([family, n]) => count(n, NOUNS[family as SeamFamily][side])),
  ].join(", ");
}

function tally(links: readonly SeamLink[], repoOf: (link: SeamLink) => string, idOf: (link: SeamLink) => unknown): Neighbour[] {
  const byRepo = new Map<string, { ids: Map<SeamFamily, Set<unknown>>; suffix: boolean }>();
  for (const link of links) {
    const entry = byRepo.get(repoOf(link)) ?? { ids: new Map(), suffix: false };
    const family = familyOf(link.route.kind);
    entry.ids.set(family, (entry.ids.get(family) ?? new Set()).add(idOf(link)));
    entry.suffix ||= link.match === "suffix";
    byRepo.set(repoOf(link), entry);
  }
  return [...byRepo]
    .map(([name, { ids, suffix }]) => {
      const neighbour: Neighbour = { repo: name, count: ids.get("http")?.size ?? 0, suffix };
      const other = [...ids].filter(([family]) => family !== "http");
      if (other.length) neighbour.links = Object.fromEntries(other.map(([family, set]) => [family, set.size]));
      return neighbour;
    })
    .sort((a, b) => total(b) - total(a) || a.repo.localeCompare(b.repo));
}

function total(neighbour: Neighbour): number {
  return neighbour.count + Object.values(neighbour.links ?? {}).reduce((sum, n) => sum + n, 0);
}
