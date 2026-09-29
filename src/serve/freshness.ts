import { countCommits } from "../core/git.js";
import type { Freshness, RepoRecord, RepoState } from "../core/types.js";

export async function freshnessOf(repo: RepoRecord, state: RepoState): Promise<Freshness> {
  return {
    commit: state.commit,
    commitsBehind: await countCommits(repo.path, state.commit, repo.ref),
    syncedAt: state.syncedAt,
  };
}

/** "@3bd7882 · up to date", "@3bd7882 · 2 commits behind main". */
export function describeFreshness(freshness: Freshness, ref: string): string {
  const at = `@${freshness.commit.slice(0, 7)}`;
  const behind = freshness.commitsBehind;
  if (behind === null) return `${at} · can't compare with ${ref}`;
  if (behind === 0) return `${at} · up to date`;
  return `${at} · ${behind} commit${behind === 1 ? "" : "s"} behind ${ref}`;
}
