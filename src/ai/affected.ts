import { posix } from "node:path";
import { changedLines, type ChangedFile } from "../core/git.js";
import { mapCitations, parseCitations } from "../core/citations.js";
import { moveAnchor } from "../ingest/facts.js";

/**
 * A cited file that grew by this many lines or more probably gained something the page should
 * describe (a new route beside the cited ones), so the page is rewritten.
 */
const GROWTH_LINES = 10;

/**
 * A page as it reads after a change, without an AI run, or null when the change could make it
 * wrong or incomplete, so it must be rewritten:
 * - a cited file was deleted, or a cited line changed;
 * - a file was added in a folder it cites (a new controller beside the cited ones belongs on the
 *   API page);
 * - a cited file grew by GROWTH_LINES or more;
 * - the history couldn't be compared (`changes` null).
 *
 * Otherwise its citations move with the lines added or removed above them, as fact anchors do.
 * The result still has to pass the citation check before it's kept.
 */
export async function carriedPage(markdown: string, repoPath: string, from: string, to: string, changes: readonly ChangedFile[] | null): Promise<string | null> {
  if (changes === null) return null;
  const cited = new Set(parseCitations(markdown).map((c) => c.path));
  const folders = new Set([...cited].map((path) => posix.dirname(path)));
  if (changes.some((change) => change.status === "A" && folders.has(posix.dirname(change.path)))) return null;
  const touched = changes.filter((change) => cited.has(change.path)).map((change) => change.path);
  if (touched.length === 0) return markdown;

  const hunks = await changedLines(repoPath, from, to, touched);
  if (!hunks) return null;
  for (const change of hunks.values()) {
    if (change === "deleted" || change.reduce((sum, h) => sum + h.newLines - h.oldLines, 0) >= GROWTH_LINES) return null;
  }
  let lost = false;
  const moved = mapCitations(markdown, (cite) => {
    const change = hunks.get(cite.path);
    const next = change === undefined || change === "deleted" ? cite : moveAnchor(cite, change);
    if (!next) lost = true;
    return next ?? cite;
  });
  return lost ? null : moved;
}
