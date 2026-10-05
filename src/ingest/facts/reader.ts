import type { FactDraft } from "../../core/facts.js";

/**
 * Reads facts from one kind of well-known file (a manifest, CODEOWNERS, a README). Like extractor
 * plugins, readers are pure and precise: bad input gives no facts rather than an error.
 */
export interface FactReader {
  name: string;
  /** Cheap path check. */
  wants(path: string): boolean;
  /** False when the path alone is the fact (lockfiles), so the file is never read. */
  needsContent: boolean;
  /** `text` is "" when `needsContent` is false. */
  read(path: string, text: string): FactDraft[];
}

const NOT_THE_REPOS_OWN = new Set(["node_modules", "vendor", "fixtures", "__fixtures__", "testdata"]);

/** Manifests under these folders describe test inputs or third-party code, not the repo. */
export function isRepoOwn(path: string): boolean {
  return !path.split("/").some((segment) => NOT_THE_REPOS_OWN.has(segment));
}

export function fileName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** The folder a file is in, "" for the repo root. */
export function folderOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

/** 1-based line of the first match at or after line `from`, or null. */
export function lineMatching(text: string, pattern: RegExp, from = 1): number | null {
  const lines = text.split(/\r?\n/);
  for (let i = from - 1; i < lines.length; i++) if (pattern.test(lines[i]!)) return i + 1;
  return null;
}

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
