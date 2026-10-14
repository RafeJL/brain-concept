import type { SeamFamily, SeamPiece } from "../core/seams.js";
import type { Store } from "../store/store.js";

/**
 * How much of a repo's own code its link map covers, from what its last full map recorded for
 * each piece of each file. "complete": every piece flagged for routes, calls or messages was read
 * by a mapping run. "partial": some weren't, so what they declare is unknown. "unknown": the map
 * was made before the brain recorded coverage (2026-10-14), so it may be a sample.
 */
export interface MapCoverage {
  state: "complete" | "partial" | "unknown";
  /** Pieces no mapping run answered for. */
  unmapped: SeamPiece[];
}

/** The run that maps a family: HTTP routes and calls, or the other links. */
function passOf(family: SeamFamily): "http" | "links" {
  return family === "http" ? "http" : "links";
}

/** A repo's coverage for one family, optionally within one file. */
export function coverageOf(store: Store, repo: string, family: SeamFamily, path?: string): MapCoverage {
  // Coverage is known once a full map has kept its survey; pieces alone may be from an update.
  if (!store.linkSurvey(repo)) return { state: "unknown", unmapped: [] };
  const pass = passOf(family);
  const unmapped = store.seamPieces(repo).filter((p) => p[pass] === "unmapped" && (!path || p.path === path));
  return { state: unmapped.length ? "partial" : "complete", unmapped };
}

function pieces(unmapped: readonly SeamPiece[]): string {
  const shown = unmapped.slice(0, 3).map((p) => `${p.path}:${p.start === p.end ? p.start : `${p.start}-${p.end}`}`);
  return `${shown.join(", ")}${unmapped.length > 3 ? `, +${unmapped.length - 3} more` : ""}`;
}

/**
 * Said under an answer that found nothing, or no caller, in a repo: why that isn't proof of none
 * when its map is partial, or was made before coverage was recorded. Empty when complete.
 */
export function coverageNote(store: Store, repos: readonly string[], family: SeamFamily, path?: string): string {
  const partial = repos.flatMap((repo) => {
    const c = coverageOf(store, repo, family, path);
    return c.state === "partial" ? [`${repo} (${c.unmapped.length} not mapped: ${pieces(c.unmapped)})`] : [];
  });
  if (partial.length) return `Parts of the link map are unknown in ${partial.join("; ")}: no run answered for them, so a missing route or caller there isn't proof there is none.`;
  return "";
}

/** For an answer that found nothing at all in one repo: also says when its map predates coverage. */
export function absenceNote(store: Store, repo: string, family: SeamFamily, path?: string): string {
  const c = coverageOf(store, repo, family, path);
  if (c.state === "complete") return "";
  if (c.state === "partial") return coverageNote(store, [repo], family, path);
  return `${repo}'s link map was made before the brain recorded what it covered, so on a large repo it may be a sample: treat "none" as unknown. Mapping its links again (brain sync ${repo} --only links --full) records coverage.`;
}

/** One line for a repo's card: how complete its link map is. */
export function coverageLine(store: Store, repo: string): string {
  if (!store.linkSurvey(repo)) return "Link map: coverage not recorded (made before 2026-10-14); a large repo's may be a sample.";
  const all = store.seamPieces(repo);
  const unmapped = all.filter((p) => p.http === "unmapped" || p.links === "unmapped");
  const read = new Set(all.map((p) => p.path)).size;
  return unmapped.length
    ? `Link map: partial. ${read} files screened; ${unmapped.length} flagged pieces not mapped (${pieces(unmapped)}), so what they declare is unknown.`
    : `Link map: complete. All ${read} files of its own code screened, and every flagged one mapped.`;
}
