import { citationProblem } from "../ai/check.js";
import { parseCitations, type Citation } from "../core/citations.js";
import type { FactRecord } from "../core/facts.js";
import { changedLines, fileAtCommit, type Hunk } from "../core/git.js";
import type { Store } from "../store/store.js";

/** `src/a.ts:10-20` or `src/a.ts:12` as a citation; null for anything else. */
export function parseAnchor(text: string): Citation | null {
  const cites = parseCitations(`[${text.trim()}]`);
  return cites.length === 1 ? cites[0]! : null;
}

/**
 * Why anchors can't be stored, checked like wiki citations against the committed file: each must
 * name lines that exist, at most 80 of them. Empty when they're all fine.
 */
export async function anchorProblems(repoPath: string, commit: string, anchors: readonly Citation[]): Promise<string[]> {
  const problems: string[] = [];
  for (const anchor of anchors) {
    const problem = citationProblem(anchor, await fileAtCommit(repoPath, commit, anchor.path));
    if (problem) problems.push(problem);
  }
  return problems;
}

/**
 * Anchors a person gave, read and checked against the repo at `commit`: their citations, or one
 * sentence saying why they can't be stored.
 */
export async function checkAnchors(repoPath: string, commit: string, anchors: readonly string[]): Promise<{ cites: Citation[] } | { error: string }> {
  const unreadable = anchors.filter((a) => !parseAnchor(a));
  if (unreadable.length) return { error: `Anchors are file:lines, e.g. src/follow.ts:12-20. Can't read: ${unreadable.join(", ")}.` };
  const cites = anchors.map((a) => parseAnchor(a)!);
  const problems = await anchorProblems(repoPath, commit, cites);
  if (problems.length) return { error: `The anchors don't hold at @${commit.slice(0, 7)}: ${problems.join("; ")}.` };
  return { cites };
}

/** The change that sets a person's anchors on a fact: no longer stale, and no longer Claude Code's. */
export function personAnchors(cites: Citation[], commit: string): Pick<FactRecord, "anchors" | "anchorCommit" | "staleSince" | "anchorsFound"> {
  return { anchors: cites, anchorCommit: commit, staleSince: null, anchorsFound: false };
}

/**
 * Where an anchor's lines are after a change: moved by the lines added or removed above it, or
 * null when the change touches them.
 */
export function moveAnchor(anchor: Citation, hunks: readonly Hunk[]): Citation | null {
  let shift = 0;
  for (const hunk of hunks) {
    if (hunk.oldLines === 0) {
      // Lines inserted after line oldStart: inside the anchor unless it's before or at its end.
      if (hunk.oldStart >= anchor.start && hunk.oldStart < anchor.end) return null;
      if (hunk.oldStart < anchor.start) shift += hunk.newLines;
      continue;
    }
    const last = hunk.oldStart + hunk.oldLines - 1;
    if (last < anchor.start) shift += hunk.newLines - hunk.oldLines;
    else if (hunk.oldStart <= anchor.end) return null;
  }
  return { path: anchor.path, start: anchor.start + shift, end: anchor.end + shift };
}

/**
 * After a repo syncs to `commit`, checks each of its live facts that is anchored to code. One
 * whose anchored lines changed, or whose file went, is marked stale until a person re-confirms it.
 * Otherwise its anchors move with the lines around them. No AI. Returns the facts made stale.
 */
export async function refreshFacts(store: Store, repo: string, repoPath: string, commit: string): Promise<FactRecord[]> {
  const stale: FactRecord[] = [];
  for (const fact of store.facts({ repos: [repo], systems: [] })) {
    if (fact.anchors.length === 0 || !fact.anchorCommit || fact.anchorCommit === commit || fact.staleSince) continue;
    const changes = await changedLines(repoPath, fact.anchorCommit, commit, [...new Set(fact.anchors.map((a) => a.path))]);
    // A commit no longer known here (history rewritten): leave the fact as it is.
    if (!changes) continue;
    const moved = fact.anchors.map((anchor) => {
      const change = changes.get(anchor.path);
      if (change === undefined) return anchor;
      return change === "deleted" ? null : moveAnchor(anchor, change);
    });
    if (moved.some((anchor) => anchor === null)) {
      store.updateFact(fact.id, { staleSince: commit });
      stale.push(fact);
    } else {
      store.updateFact(fact.id, { anchors: moved as Citation[], anchorCommit: commit });
    }
  }
  return stale;
}
