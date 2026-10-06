import { posix } from "node:path";
import type { ChangedFile } from "../core/git.js";
import { parseCitations } from "./check.js";

/**
 * Whether a change could make a page wrong or incomplete: a file it cites was changed or
 * deleted, or a file was added in a folder it cites (a new controller beside the cited ones
 * belongs on the API page). `null` changes mean the history couldn't be compared, so assume yes.
 */
export function isAffected(markdown: string, changes: readonly ChangedFile[] | null): boolean {
  if (changes === null) return true;
  const cited = new Set(parseCitations(markdown).map((c) => c.path));
  const folders = new Set([...cited].map((path) => posix.dirname(path)));
  return changes.some((change) => cited.has(change.path) || (change.status === "A" && folders.has(posix.dirname(change.path))));
}
