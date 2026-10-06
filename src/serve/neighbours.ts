import type { Store } from "../store/store.js";
import { groupRoutes, linkCalls, type SeamLink } from "./tools/common.js";

export interface Neighbour {
  repo: string;
  /** Distinct endpoints called (for `calls`) or calls made (for `calledBy`). */
  count: number;
  /** Whether any of the matches ignored a base path. */
  suffix: boolean;
}

export interface Neighbours {
  /** Repos serving endpoints this repo calls. */
  calls: Neighbour[];
  /** Repos calling endpoints this repo serves. */
  calledBy: Neighbour[];
}

/**
 * The repos a repo talks to over HTTP, from the seam graph, among the repos the caller can read.
 * Worked out on every request, never stored: it changes whenever any other repo syncs.
 */
export function neighbours(store: Store, repo: string, readable: readonly string[]): Neighbours {
  const others = readable.filter((name) => name !== repo);
  const routesOf = (repos: readonly string[]) => groupRoutes(store.seams({ repos, kind: "http-route" })).map((g) => g.primary);
  const callsOf = (repos: readonly string[]) => store.seams({ repos, kind: "http-call" });
  return {
    calls: tally(linkCalls(callsOf([repo]), routesOf(others), routesOf([repo])), (link) => link.route.repo, (link) => `${link.route.method} ${link.route.key}`),
    calledBy: tally(linkCalls(callsOf(others), routesOf([repo]), routesOf(others)), (link) => link.call.repo, (link) => link.call),
  };
}

function tally(links: readonly SeamLink[], repoOf: (link: SeamLink) => string, idOf: (link: SeamLink) => unknown): Neighbour[] {
  const byRepo = new Map<string, { ids: Set<unknown>; suffix: boolean }>();
  for (const link of links) {
    const entry = byRepo.get(repoOf(link)) ?? { ids: new Set(), suffix: false };
    entry.ids.add(idOf(link));
    entry.suffix ||= link.match === "suffix";
    byRepo.set(repoOf(link), entry);
  }
  return [...byRepo]
    .map(([name, { ids, suffix }]) => ({ repo: name, count: ids.size, suffix }))
    .sort((a, b) => b.count - a.count || a.repo.localeCompare(b.repo));
}
