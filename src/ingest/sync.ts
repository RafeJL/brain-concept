import { listTree, resolveCommit } from "../core/git.js";
import { detectLanguage } from "../core/languages.js";
import type { FileRecord } from "../core/types.js";
import type { Store } from "../store/store.js";
import { refreshFacts } from "./facts.js";
import { requireRepo } from "./registry.js";

export interface SyncResult {
  repo: string;
  commit: string;
  previousCommit: string | null;
  added: number;
  changed: number;
  removed: number;
  unchanged: number;
  /** Facts whose anchored code changed in this sync, so they need re-confirming. */
  staleFacts: number;
}

/**
 * Brings a repo's file index up to the commit its tracked ref points at. Reads the committed
 * tree, never the working copy, and only records files whose blob changed. No AI: the routes,
 * calls and wiki are brought up to the same commit afterwards (`refreshRepo`).
 */
export async function syncRepo(store: Store, name: string): Promise<SyncResult> {
  const repo = requireRepo(store, name);

  const commit = await resolveCommit(repo.path, repo.ref);
  const previous = store.getState(name);
  const tree = await listTree(repo.path, commit);
  const known = new Map(store.getFiles(name).map((file) => [file.path, file]));

  const upsert: FileRecord[] = [];
  let added = 0;
  let changed = 0;
  for (const entry of tree) {
    const existing = known.get(entry.path);
    known.delete(entry.path);
    if (existing?.blob === entry.blob) continue;
    if (existing) changed++;
    else added++;
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

  store.applySync(name, { commit, fileCount: tree.length, upsert, remove });
  const stale = previous?.commit === commit ? [] : await refreshFacts(store, name, repo.path, commit);
  return {
    repo: name,
    commit,
    previousCommit: previous?.commit ?? null,
    added,
    changed,
    removed: remove.length,
    unchanged: tree.length - added - changed,
    staleFacts: stale.length,
  };
}
