import { changedLines } from "../core/git.js";
import { formatCitation, withoutCitations, type Citation } from "../core/citations.js";
import type { WikiPage } from "../core/types.js";
import { moveAnchor } from "../ingest/facts.js";
import { citationProblem, claimProblem, claimsOf, distinctiveWords, fileReader, loose, namesIn } from "./check.js";

/**
 * Why a claim of the old wiki isn't cited by the new one:
 * - "lost": its page is still there, and no new claim says the same;
 * - "page-renamed": its page is gone, but a page new to the wiki cites half or more of its files, without it;
 * - "page-removed": its page is gone, and no page new to the wiki covers its files;
 * - "restated": a new claim says the same (the same names, or most of its words), citing other lines;
 * - "code-changed": its cited lines changed since, so the code moved on, not the wiki.
 */
export type DroppedKind = "lost" | "page-renamed" | "page-removed" | "restated" | "code-changed";

/** A fact the previous wiki cited that a full rewrite no longer does, and why. */
export interface DroppedFact {
  /** The previous page it was on. */
  slug: string;
  claim: string;
  /** As the previous page cited it, at that page's commit. */
  cites: string[];
  kind: DroppedKind;
  /** The same citations at the new commit; empty when its lines changed, so they couldn't be moved. */
  moved: string[];
  /** For "restated", the new claim saying it and its page; for "page-renamed", the page that carried on. */
  match?: { slug: string; claim?: string };
}

/** A new page, as the dropped facts are compared against it. */
export interface NewPage {
  slug: string;
  markdown: string;
}

/** The order the kinds are reported in: real losses first. */
export const DROPPED_KINDS: readonly DroppedKind[] = ["lost", "page-renamed", "page-removed", "restated", "code-changed"];

/** A gone page carried on under another name when a new page cites at least this share of its files. */
const RENAMED_SHARE = 0.5;
/** A claim with no names is restated by a new one holding at least this share of its distinctive words. */
const RESTATED_WORDS = 2 / 3;

const overlaps = (a: Citation, b: Citation) => a.path === b.path && a.start <= b.end && b.start <= a.end;

/**
 * Every claim of the old pages that no citation of the new pages overlaps, once its citations have
 * moved to `commit` with the lines around them, and why each wasn't kept. `root` is a checkout of
 * `commit`, `repoPath` the repo the old pages' commits are in. No AI: the person reading the
 * report judges which losses matter.
 */
export async function droppedFacts(old: readonly WikiPage[], now: readonly NewPage[], repoPath: string, root: string, commit: string): Promise<DroppedFact[]> {
  const linesOf = fileReader(root);
  const claimsNow = now.flatMap((page) => claimsOf(page.markdown).map((claim) => ({ slug: page.slug, ...claim })));
  const kept = claimsNow.flatMap((c) => c.cites);
  const filesOf = (markdown: string) => new Set(claimsOf(markdown).flatMap((c) => c.cites.map((cite) => cite.path)));
  // A renamed page shows up under a slug the old wiki didn't have.
  const filesNew = now.filter((page) => !old.some((p) => p.slug === page.slug)).map((page) => ({ slug: page.slug, files: filesOf(page.markdown) }));

  const dropped: DroppedFact[] = [];
  for (const page of old) {
    const claims = claimsOf(page.markdown);
    const move = await mover(page, claims.flatMap((c) => c.cites), repoPath, commit);
    const gone = !now.some((p) => p.slug === page.slug);
    const heir = gone ? renamedTo(filesOf(page.markdown), filesNew) : null;
    for (const { text, cites } of claims) {
      const moved = cites.map(move);
      // Lines changed inside a span leave it about where it was, so it still counts as kept there.
      if (moved.some((c, i) => kept.some((k) => overlaps(c ?? cites[i]!, k)))) continue;
      const fact = { slug: page.slug, claim: text, cites: cites.map(formatCitation) };
      if (moved.some((c) => c === null)) {
        dropped.push({ ...fact, kind: "code-changed", moved: [] });
        continue;
      }
      const at = moved as Citation[];
      const shown = { ...fact, moved: at.map(formatCitation) };
      if (at.some((c) => citationProblem(c, linesOf(c.path)) !== null) || claimProblem(text, at, root, linesOf) !== null) {
        dropped.push({ ...shown, kind: "code-changed" });
        continue;
      }
      const same = claimsNow.find((c) => restates(text, c.text));
      if (same) dropped.push({ ...shown, kind: "restated", match: { slug: same.slug, claim: same.text } });
      else if (!gone) dropped.push({ ...shown, kind: "lost" });
      else if (heir) dropped.push({ ...shown, kind: "page-renamed", match: { slug: heir } });
      else dropped.push({ ...shown, kind: "page-removed" });
    }
  }
  return dropped;
}

/**
 * Moves an old page's citations from its commit to `commit`: null for one whose lines changed or
 * whose file went. When the history can't be compared they stay as they are.
 */
async function mover(page: WikiPage, cites: readonly Citation[], repoPath: string, commit: string): Promise<(cite: Citation) => Citation | null> {
  if (page.commit === commit || cites.length === 0) return (cite) => cite;
  const changes = await changedLines(repoPath, page.commit, commit, [...new Set(cites.map((c) => c.path))]);
  if (!changes) return (cite) => cite;
  return (cite) => {
    const change = changes.get(cite.path);
    if (change === undefined) return cite;
    return change === "deleted" ? null : moveAnchor(cite, change);
  };
}

/** Of the pages new to the wiki, the one citing the largest share of a gone page's files, if that share is big enough. */
function renamedTo(files: ReadonlySet<string>, pages: readonly { slug: string; files: ReadonlySet<string> }[]): string | null {
  if (files.size === 0) return null;
  let best: { slug: string; share: number } | null = null;
  for (const page of pages) {
    const share = [...files].filter((f) => page.files.has(f)).length / files.size;
    if (share >= RENAMED_SHARE && (!best || share > best.share)) best = { slug: page.slug, share };
  }
  return best?.slug ?? null;
}

/**
 * Whether `now` says what `old` said: every name `old` gives in backticks appears in it, or, when
 * `old` gives none, most of its distinctive words do. Same-looking claims about the same code
 * can still say different things; the report shows both so a person can tell.
 */
function restates(old: string, now: string): boolean {
  const text = withoutCitations(now);
  const names = namesIn(old).filter((name) => name.length >= 2);
  if (names.length) return names.every((name) => loose(text).includes(loose(name)));
  const words = new Set(distinctiveWords(withoutCitations(old)).map((w) => w.toLowerCase()));
  if (words.size < 2) return false;
  const have = new Set(distinctiveWords(text).map((w) => w.toLowerCase()));
  return [...words].filter((w) => have.has(w)).length >= words.size * RESTATED_WORDS;
}
