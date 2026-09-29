import { readBlobs, type TreeEntry } from "../core/git.js";
import type { SeamDraft } from "../core/seams.js";
import { PLUGINS } from "./extractors/index.js";
import { grammarFor, parse } from "./parse.js";

/** Files above this size are generated or vendored far more often than hand-written. */
export const MAX_EXTRACT_BYTES = 1024 * 1024;

export interface ExtractionResult {
  seams: Map<string, SeamDraft[]>;
  /** Files a plugin threw on. The sync carries on; the count shows up on the repo card later. */
  failures: string[];
}

/** Runs every plugin that wants this file over its source, parsing it at most once. */
export async function extractSource(path: string, source: string): Promise<SeamDraft[]> {
  const plugins = PLUGINS.filter((p) => p.wants(path));
  if (plugins.length === 0) return [];
  const grammar = grammarFor(path);
  const tree = grammar && plugins.some((p) => p.needsTree) ? await parse(grammar, source) : null;
  try {
    return plugins.flatMap((plugin) => plugin.extract({ path, source, tree }));
  } finally {
    tree?.delete();
  }
}

/** Extracts seams from each entry. Only files some plugin wants are read. */
export async function extractSeams(repoPath: string, entries: readonly TreeEntry[]): Promise<ExtractionResult> {
  const wanted = entries.filter((e) => e.bytes <= MAX_EXTRACT_BYTES && PLUGINS.some((p) => p.wants(e.path)));
  const blobs = await readBlobs(repoPath, [...new Set(wanted.map((e) => e.blob))]);
  const seams = new Map<string, SeamDraft[]>();
  const failures: string[] = [];

  for (const entry of wanted) {
    const content = blobs.get(entry.blob);
    if (!content || content.includes(0)) continue;
    try {
      const found = await extractSource(entry.path, content.toString("utf8"));
      if (found.length > 0) seams.set(entry.path, found);
    } catch {
      failures.push(entry.path);
    }
  }
  return { seams, failures };
}
