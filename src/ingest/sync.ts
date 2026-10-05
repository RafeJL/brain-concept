import { listTree, resolveCommit, type TreeEntry } from "../core/git.js";
import { detectLanguage } from "../core/languages.js";
import type { Seam } from "../core/seams.js";
import type { FileRecord } from "../core/types.js";
import type { Store } from "../store/store.js";
import { extractFiles } from "./extract.js";
import { EXTRACTOR_VERSION } from "./extractors/index.js";
import { requireRepo } from "./registry.js";

export interface SyncResult {
  repo: string;
  commit: string;
  previousCommit: string | null;
  added: number;
  changed: number;
  removed: number;
  unchanged: number;
  /** Files whose seams were (re)extracted in this sync. */
  extracted: number;
  /** True when the extractor version changed and every file was re-read. */
  fullExtract: boolean;
  failures: string[];
}

/**
 * Brings a repo's facts up to the commit its tracked ref points at. Reads the committed tree,
 * never the working copy, and only re-reads files whose blob changed, unless the extractors
 * themselves changed, in which case every file is re-extracted.
 */
export async function syncRepo(store: Store, name: string): Promise<SyncResult> {
  const repo = requireRepo(store, name);

  const commit = await resolveCommit(repo.path, repo.ref);
  const previous = store.getState(name);
  const tree = await listTree(repo.path, commit);
  const known = new Map(store.getFiles(name).map((file) => [file.path, file]));

  const upsert: FileRecord[] = [];
  const changedEntries: TreeEntry[] = [];
  let added = 0;
  let changed = 0;
  for (const entry of tree) {
    const existing = known.get(entry.path);
    known.delete(entry.path);
    if (existing?.blob === entry.blob) continue;
    if (existing) changed++;
    else added++;
    changedEntries.push(entry);
    upsert.push({
      repo: name,
      path: entry.path,
      blob: entry.blob,
      bytes: entry.bytes,
      language: detectLanguage(entry.path),
      commit,
    });
  }
  const remove = [...known.keys()];

  const fullExtract = previous !== undefined && previous.extractorVersion !== EXTRACTOR_VERSION;
  const toExtract = fullExtract ? tree : changedEntries;
  const extraction = await extractFiles(repo.path, toExtract);
  const seams: Seam[] = [];
  for (const [path, drafts] of extraction.seams) {
    for (const draft of drafts) seams.push({ ...draft, repo: name, path, commit });
  }

  store.applySync(name, {
    commit,
    fileCount: tree.length,
    extractorVersion: EXTRACTOR_VERSION,
    upsert,
    remove,
    extractedPaths: toExtract.map((entry) => entry.path),
    seams,
  });
  return {
    repo: name,
    commit,
    previousCommit: previous?.commit ?? null,
    added,
    changed,
    removed: remove.length,
    unchanged: tree.length - added - changed,
    extracted: extraction.seams.size,
    fullExtract,
    failures: extraction.failures,
  };
}
