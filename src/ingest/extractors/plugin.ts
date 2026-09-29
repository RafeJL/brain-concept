import type { Tree } from "@vscode/tree-sitter-wasm";
import type { SeamDraft } from "../../core/seams.js";

export interface SourceFile {
  path: string;
  source: string;
  /** Parsed with the file's grammar when a plugin asked for it; null otherwise. */
  tree: Tree | null;
}

/**
 * Finds seams in one kind of file. A new stack or framework is a new plugin; nothing else in the
 * pipeline changes. Plugins must be pure (no I/O) and precise: when unsure whether something is an
 * HTTP route or call, leave it out rather than guess.
 */
export interface ExtractorPlugin {
  name: string;
  /** Cheap path check; the file is only read if some plugin wants it. */
  wants(path: string): boolean;
  needsTree: boolean;
  extract(file: SourceFile): SeamDraft[];
}
