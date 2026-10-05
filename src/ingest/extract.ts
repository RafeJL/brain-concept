import { readBlobs, type TreeEntry } from "../core/git.js";
import type { FactDraft } from "../core/facts.js";
import type { SeamDraft } from "../core/seams.js";
import { PLUGINS } from "./extractors/index.js";
import { READERS } from "./facts/index.js";
import { grammarFor, parse } from "./parse.js";

/** Decodes UTF-8 and drops a leading byte order mark, which .NET tooling often writes. */
const utf8 = new TextDecoder();

/** Files above this size are generated or vendored far more often than hand-written. */
export const MAX_EXTRACT_BYTES = 1024 * 1024;

export interface ExtractionResult {
  seams: Map<string, SeamDraft[]>;
  facts: Map<string, FactDraft[]>;
  /** Files a plugin or reader threw on. The sync carries on. */
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

/**
 * Runs every fact reader that wants this file. With no source (unreadable, binary or too big)
 * only readers that go by the path alone run.
 */
export function readFacts(path: string, source: string | null): FactDraft[] {
  return READERS.filter((r) => r.wants(path) && (source !== null || !r.needsContent)).flatMap((reader) =>
    reader.read(path, reader.needsContent ? source! : ""),
  );
}

function needsContent(path: string): boolean {
  return PLUGINS.some((p) => p.wants(path)) || READERS.some((r) => r.needsContent && r.wants(path));
}

/** Extracts seams and facts from each entry. Only files a plugin or reader needs are read. */
export async function extractFiles(repoPath: string, entries: readonly TreeEntry[]): Promise<ExtractionResult> {
  const toRead = entries.filter((e) => e.bytes <= MAX_EXTRACT_BYTES && needsContent(e.path));
  const blobs = await readBlobs(repoPath, [...new Set(toRead.map((e) => e.blob))]);
  const seams = new Map<string, SeamDraft[]>();
  const facts = new Map<string, FactDraft[]>();
  const failures: string[] = [];

  for (const entry of entries) {
    const content = blobs.get(entry.blob);
    const source = content && !content.includes(0) ? utf8.decode(content) : null;
    try {
      const found = readFacts(entry.path, source);
      if (found.length > 0) facts.set(entry.path, found);
      const drafts = source === null ? [] : await extractSource(entry.path, source);
      if (drafts.length > 0) seams.set(entry.path, drafts);
    } catch {
      failures.push(entry.path);
    }
  }
  return { seams, facts, failures };
}
