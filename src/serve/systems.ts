import type { SystemRecord } from "../core/systems.js";
import type { Store } from "../store/store.js";
import { neighbours } from "./neighbours.js";

/**
 * The systems a caller can see, holding only the members they can read. A system with no readable
 * member isn't returned, so its name never leaks.
 */
export function visibleSystems(store: Store, readable: readonly string[]): SystemRecord[] {
  return store.systems().flatMap((system) => {
    const repos = system.repos.filter((repo) => readable.includes(repo));
    return repos.length ? [{ ...system, repos }] : [];
  });
}

/** The system a repo belongs to, as the caller sees it. */
export function systemOf(store: Store, repo: string, readable: readonly string[]): SystemRecord | undefined {
  return visibleSystems(store, readable).find((system) => system.repos.includes(repo));
}

/** A visible system by name, ignoring case. */
export function findSystem(store: Store, name: string, readable: readonly string[]): SystemRecord | undefined {
  return visibleSystems(store, readable).find((system) => system.name.toLowerCase() === name.toLowerCase());
}

/**
 * For a repo just added: if it calls, or is called by, a repo in a confirmed system, a line saying
 * so and how to add it. No AI: it comes from the seam graph. Null when the repo is already in a
 * system or touches none.
 */
export function joinHint(store: Store, repo: string): string | null {
  const all = store.listRepos().map((r) => r.name);
  const known = store.systems();
  if (known.some((s) => s.repos.includes(repo))) return null;
  const systems = known.filter((s) => s.status === "confirmed");
  const { calls, calledBy } = neighbours(store, repo, all);
  let best: { system: SystemRecord; calls: string[]; calledBy: string[] } | undefined;
  for (const system of systems) {
    const found = {
      system,
      calls: calls.filter((n) => system.repos.includes(n.repo)).map((n) => n.repo),
      calledBy: calledBy.filter((n) => system.repos.includes(n.repo)).map((n) => n.repo),
    };
    const links = found.calls.length + found.calledBy.length;
    if (links > 0 && links > (best ? best.calls.length + best.calledBy.length : 0)) best = found;
  }
  if (!best) return null;
  const why = [
    ...(best.calls.length ? [`it calls ${best.calls.join(", ")}`] : []),
    ...(best.calledBy.length ? [`${best.calledBy.join(", ")} ${best.calledBy.length === 1 ? "calls" : "call"} it`] : []),
  ].join("; ");
  return `Looks like part of ${best.system.name} (${why}). Add it with: brain systems set ${quoted(best.system.name)} ${repo}`;
}

/** A system name as typed on a command line: quoted when it has spaces. */
export function quoted(name: string): string {
  return /\s/.test(name) ? `"${name}"` : name;
}
