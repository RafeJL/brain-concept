/** One cited span: `path` lines `start`–`end` (1-based, inclusive). */
export interface Citation {
  path: string;
  start: number;
  end: number;
}

const BRACKET = /\[([^[\]]+)\](?!\()/g;
const SOURCE = /^\s*([^\s:;,[\]]+):(\d+(?:\s*-\s*\d+)?(?:\s*,\s*\d+(?:\s*-\s*\d+)?)*)\s*$/;

/** Splits a bracket between files: at a ";", or at a "," followed by another `path:line`. */
const BETWEEN_FILES = /;|,(?=\s*[^\s:;,[\]\d][^\s:;,[\]]*:\d)/;

/**
 * Citations in a piece of text, in every form the AI writes them: `[a.ts:12]`, `[a.ts:12-20]`,
 * `[a.ts:1-2,13-14]`, `[a.ts:3; b.ts:4-9]`, `[a.ts:3, b.ts:4-9]`, ranges written with an en or em
 * dash (`12–20`), and several brackets in a row. Markdown links (`[text](url)`) and bracketed
 * prose are ignored.
 */
export function parseCitations(text: string): Citation[] {
  return [...text.matchAll(BRACKET)].flatMap(([, inside]) => citationsIn(inside!));
}

function citationsIn(inside: string): Citation[] {
  return inside.replace(/[\u2013\u2014]/g, "-").split(BETWEEN_FILES).flatMap((part) => {
    const source = SOURCE.exec(part);
    if (!source) return [];
    const path = cleanPath(source[1]!);
    return source[2]!.split(",").map((range) => {
      const [start, end = start] = range.split("-").map((n) => Number(n.trim()));
      return { path, start: start!, end: end! };
    });
  });
}

/** A cited path as stored: forward slashes, no leading `./` or `/`. */
export function cleanPath(file: string): string {
  return file.trim().replace(/\\/g, "/").replace(/^\.?\//, "");
}

/** The first bracket in the text that looks like a citation (`path:line`) but can't be read, if any. */
export function unreadableCitation(text: string): string | null {
  for (const [whole, inside] of text.matchAll(BRACKET)) {
    if (/[^\s:;,]:\S/.test(inside!) && citationsIn(inside!).length === 0) return whole;
  }
  return null;
}

/** `path:start-end`, or `path:line` for one line. */
export function formatCitation(cite: Citation): string {
  return `${cite.path}:${cite.start === cite.end ? cite.start : `${cite.start}-${cite.end}`}`;
}

/** The text with each citation bracket rewritten from `move`'s answer for each of its citations. */
export function mapCitations(text: string, move: (cite: Citation) => Citation): string {
  return text.replace(BRACKET, (whole, inside: string) => {
    const cites = citationsIn(inside);
    return cites.length ? `[${cites.map((c) => formatCitation(move(c))).join("; ")}]` : whole;
  });
}

/** The text with its citations taken out; other brackets (`[Authorize]`, links) stay. */
export function withoutCitations(text: string): string {
  return text.replace(BRACKET, (whole, inside: string) => (citationsIn(inside).length ? "" : whole));
}
