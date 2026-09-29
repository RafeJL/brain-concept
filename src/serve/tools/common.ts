import type { Freshness } from "../../core/types.js";
import type { Store } from "../../store/store.js";
import type { AccessPolicy, Caller } from "../access.js";
import { describeFreshness, freshnessOf } from "../freshness.js";

export type Format = "concise" | "detailed";

export interface ToolDeps {
  store: Store;
  access: AccessPolicy;
}

export type ToolResult<T> = { ok: true; data: T; text: string } | { ok: false; text: string };

export const PAGE_SIZE = 20;

/** The enrolled repos this caller may read. Every tool starts here. */
export async function readableRepos(deps: ToolDeps, caller: Caller): Promise<string[]> {
  const enrolled = deps.store.listRepos().map((repo) => repo.name);
  return [...(await deps.access.readableRepos(caller, enrolled))].sort();
}

/** Freshness of each named repo's index, for stamping on answers. */
export async function freshnessByRepo(deps: ToolDeps, repos: Iterable<string>): Promise<Map<string, Freshness>> {
  const result = new Map<string, Freshness>();
  for (const name of new Set(repos)) {
    const repo = deps.store.getRepo(name);
    const state = deps.store.getState(name);
    if (repo && state) result.set(name, await freshnessOf(repo, state));
  }
  return result;
}

export function freshnessLine(deps: ToolDeps, freshness: Map<string, Freshness>): string {
  const parts = [...freshness].map(([name, f]) => `${name} ${describeFreshness(f, deps.store.getRepo(name)?.ref ?? "?")}`);
  return `Indexed: ${parts.join("; ")}`;
}

export function lineRange(start: number, end: number): string {
  return start === end ? `${start}` : `${start}-${end}`;
}
