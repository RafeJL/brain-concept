import type { Node, Tree } from "@vscode/tree-sitter-wasm";
import { normalisePath } from "../../core/http.js";
import type { SeamDraft } from "../../core/seams.js";
import type { UrlResolution } from "./strings.js";

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
  /** Code languages whose seams this plugin reads (see core/languages.ts); [] for spec formats. */
  languages: readonly string[];
  /** Cheap path check; the file is only read if some plugin wants it. */
  wants(path: string): boolean;
  needsTree: boolean;
  extract(file: SourceFile): SeamDraft[];
}

export interface Lines {
  startLine: number;
  endLine: number;
}

/** 1-based inclusive line range of a node, for citations. */
export function lines(node: Node): Lines {
  return { startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1 };
}

export function routeSeam(plugin: string, method: string, rawPath: string, at: Lines): SeamDraft {
  return { kind: "http-route", method, rawPath, key: normalisePath(rawPath), ...at, plugin };
}

/** A call to a resolved path, a call with a run-time URL (no key), or nothing if it isn't a URL. */
export function callSeams(plugin: string, method: string, url: UrlResolution, at: Lines): SeamDraft[] {
  if (url.status === "not-url") return [];
  const key = url.status === "path" ? url.key : null;
  return [{ kind: "http-call", method, rawPath: url.raw, key, ...at, plugin }];
}
