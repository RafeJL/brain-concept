import { prompt } from "./prompts.js";
import type { Runner } from "./runner.js";

/** A piece of a file given to one run: the whole file, or a range of lines of a long one. */
export interface Piece {
  path: string;
  start: number;
  end: number;
}

/** What screening found a piece may declare. */
export interface Flags {
  route: boolean;
  call: boolean;
  message: boolean;
}

/**
 * Lines per piece of a long file. A run asked to map a 6,000-line controller listed 23 of its
 * ~130 actions (atlas, 2026-10-14 spike); pieces this size are read whole.
 */
export const PIECE_LINES = 600;
/**
 * Characters of file text per screening run. Haiku read 250,000 at a time on atlas's RD.Web and
 * flagged all 59 of its controllers, answering for every file.
 */
const SCREEN_CHARS = 250_000;
export const SCREEN_MODEL = "haiku";

const SCHEMA = {
  type: "object",
  properties: {
    files: {
      type: "array",
      items: {
        type: "object",
        properties: { file: { type: "string" }, from: { type: "integer" }, route: { type: "boolean" }, call: { type: "boolean" }, message: { type: "boolean" } },
        required: ["file", "from", "route", "call", "message"],
      },
    },
  },
  required: ["files"],
};

export function pieceKey(piece: Pick<Piece, "path" | "start">): string {
  return `${piece.path}:${piece.start}`;
}

/** Each file whole, or in ranges of `PIECE_LINES` when it is longer. Files that can't be read are left out. */
export function piecesOf(paths: readonly string[], linesOf: (path: string) => string[] | null): Piece[] {
  return paths.flatMap((path) => {
    const lines = linesOf(path);
    if (!lines) return [];
    const count = Math.max(1, lineCount(lines));
    const pieces: Piece[] = [];
    for (let start = 1; start <= count; start += PIECE_LINES) pieces.push({ path, start, end: Math.min(count, start + PIECE_LINES - 1) });
    return pieces;
  });
}

/** A file's lines, not counting the empty one after a final newline. */
function lineCount(lines: readonly string[]): number {
  return lines.length && lines.at(-1) === "" ? lines.length - 1 : lines.length;
}

/** A piece as given to a run: a header naming it, then its text, numbered when the run must cite lines. */
export function pieceText(piece: Piece, lines: readonly string[], numbered: boolean): string {
  const whole = piece.start === 1 && piece.end >= lineCount(lines);
  const body = lines.slice(piece.start - 1, piece.end).map((line, i) => (numbered ? `${piece.start + i}| ${line}` : line));
  return [`===== FILE ${piece.path}${whole ? "" : ` (lines ${piece.start}-${piece.end})`} =====`, ...body].join("\n");
}

/** Pieces packed into runs of at most `chars` characters of text and `most` pieces, in order; a piece never splits. */
export function packPieces(pieces: readonly Piece[], linesOf: (path: string) => string[] | null, chars: number, most = Infinity): Piece[][] {
  const runs: Piece[][] = [];
  let current: Piece[] = [];
  let size = 0;
  for (const piece of pieces) {
    const length = (linesOf(piece.path) ?? []).slice(piece.start - 1, piece.end).reduce((n, line) => n + line.length + 1, 0) + piece.path.length + 40;
    if (current.length && (size + length > chars || current.length >= most)) {
      runs.push(current);
      current = [];
      size = 0;
    }
    current.push(piece);
    size += length;
  }
  if (current.length) runs.push(current);
  return runs;
}

export interface Screened {
  flags: Map<string, Flags>;
  /** Pieces no run answered for, even when asked again: counted as flagged for everything, so nothing is lost. */
  unanswered: number;
  costUsd: number;
}

/**
 * Has a fast model read every piece, its text in the prompt so it can't skip one, and say whether
 * it declares a route, makes a call or sends or handles a message. Only flagged pieces go on to
 * the mapping runs, which read closely. Pieces left unanswered are asked once more, then counted
 * as flagged. No tools: the run answers from the text it was given.
 */
export async function screenPieces(runner: Runner, cwd: string, pieces: readonly Piece[], linesOf: (path: string) => string[] | null, model = SCREEN_MODEL): Promise<Screened> {
  const flags = new Map<string, Flags>();
  let costUsd = 0;
  const ask = async (batch: readonly Piece[]) => {
    const files = batch.map((p) => pieceText(p, linesOf(p.path) ?? [], false)).join("\n");
    try {
      const run = await runner.run<{ files?: unknown }>({ cwd, prompt: prompt("screen-links", { files }), schema: SCHEMA, model, explore: false });
      costUsd += run.costUsd;
      const wanted = new Set(batch.map(pieceKey));
      for (const answer of Array.isArray(run.output?.files) ? run.output.files : []) {
        const a = answer as Partial<{ file: string; from: number; route: boolean; call: boolean; message: boolean }>;
        const key = pieceKey({ path: String(a?.file ?? ""), start: Number(a?.from ?? 1) });
        if (wanted.has(key)) flags.set(key, { route: a.route === true, call: a.call === true, message: a.message === true });
      }
    } catch {
      // A failed run leaves its pieces unanswered: they are asked again, then counted as flagged.
    }
  };
  await Promise.all(packPieces(pieces, linesOf, SCREEN_CHARS).map(ask));
  const missing = pieces.filter((p) => !flags.has(pieceKey(p)));
  if (missing.length) await Promise.all(packPieces(missing, linesOf, SCREEN_CHARS / 2).map(ask));
  const unanswered = pieces.filter((p) => !flags.has(pieceKey(p)));
  for (const p of unanswered) flags.set(pieceKey(p), { route: true, call: true, message: true });
  return { flags, unanswered: unanswered.length, costUsd };
}
