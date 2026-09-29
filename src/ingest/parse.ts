import { createRequire } from "node:module";
import { dirname, extname, join } from "node:path";
import type { Parser as ParserType, Tree } from "@vscode/tree-sitter-wasm";

// The package is UMD, so it is loaded through require. The grammars are WASM, which means
// no native builds and nothing for group policy to block.
const require = createRequire(import.meta.url);
const treeSitter = require("@vscode/tree-sitter-wasm") as typeof import("@vscode/tree-sitter-wasm");
const WASM_DIR = dirname(require.resolve("@vscode/tree-sitter-wasm"));

export type Grammar = "typescript" | "tsx" | "javascript" | "c-sharp";

const BY_EXTENSION: Record<string, Grammar> = {
  ".ts": "typescript", ".mts": "typescript", ".cts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript", ".cjs": "javascript",
  ".cs": "c-sharp",
};

export function grammarFor(path: string): Grammar | null {
  if (path.endsWith(".d.ts")) return null;
  return BY_EXTENSION[extname(path).toLowerCase()] ?? null;
}

let runtime: Promise<void> | undefined;
const parsers = new Map<Grammar, Promise<ParserType>>();

/** One parser per grammar, created on first use. The WASM runtime starts once. */
function parserFor(grammar: Grammar): Promise<ParserType> {
  let parser = parsers.get(grammar);
  if (!parser) {
    parser = (async () => {
      runtime ??= treeSitter.Parser.init();
      await runtime;
      const created = new treeSitter.Parser();
      created.setLanguage(await treeSitter.Language.load(join(WASM_DIR, `tree-sitter-${grammar}.wasm`)));
      return created;
    })();
    parsers.set(grammar, parser);
  }
  return parser;
}

/** Parses source with the grammar's shared parser. Callers must `tree.delete()` when done. */
export async function parse(grammar: Grammar, source: string): Promise<Tree | null> {
  return (await parserFor(grammar)).parse(source);
}
