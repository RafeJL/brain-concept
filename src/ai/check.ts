import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { parseCitations, unreadableCitation, withoutCitations, type Citation } from "../core/citations.js";
import { opensDiagram } from "../core/sections.js";
import { checkDiagram } from "./diagrams.js";

export interface RemovedClaim {
  text: string;
  reason: string;
}

export interface CheckedPage {
  /** The page with unsupported claims removed and external links reduced to their text. */
  markdown: string;
  claims: number;
  removed: RemovedClaim[];
  /** False when fewer than half the claims survive, or there were none: don't publish. */
  publishable: boolean;
}

/** A citation wider than this proves little about any one sentence. */
export const MAX_SPAN_LINES = 80;
/** Cited lines are where a claim's words must appear, give or take this many lines. */
const SLACK = 3;
/** Shorter fragments (lead-ins like "Common invocations:") aren't claims. */
const MIN_CLAIM_CHARS = 20;

/**
 * Declarations that serve a resource's CRUD routes without naming them: Laravel
 * `Route::resource`/`apiResource`, Rails `resources :x`. They imply these methods and actions.
 */
const RESOURCE = /route::(api)?resources?\s*\(|->(api)?resources?\s*\(|^\s*resources?\s+:/m;
const CRUD = new Set(["get", "post", "put", "patch", "delete"]);
const CRUD_ACTIONS = new Set(["index", "create", "new", "store", "show", "edit", "update", "destroy"]);

/** The line under a Markdown table's header: |---|:---:|. */
const TABLE_RULE = /^\s*\|?\s*:?-{3}/;

/** Reads files under `root` once each, as lines; null for a path that isn't a file there. */
export function fileReader(root: string): (path: string) => string[] | null {
  const files = new Map<string, string[] | null>();
  return (path) => {
    if (!files.has(path)) {
      const full = join(root, path);
      files.set(path, existsSync(full) && statSync(full).isFile() ? readFileSync(full, "utf8").split(/\r?\n/) : null);
    }
    return files.get(path)!;
  };
}

/** Why a citation can't support anything (missing file, outside it, too broad), or null. */
export function citationProblem(cite: Citation, lines: string[] | null): string | null {
  if (!lines) return `cites ${cite.path}, which doesn't exist at this commit`;
  if (!Number.isInteger(cite.start) || !Number.isInteger(cite.end) || cite.start < 1 || cite.end < cite.start || cite.end > lines.length) {
    return `cites ${cite.path}:${cite.start}-${cite.end}, outside the file (${lines.length} lines)`;
  }
  if (cite.end - cite.start + 1 > MAX_SPAN_LINES) {
    return `cites ${cite.end - cite.start + 1} lines of ${cite.path}; too broad to support one claim`;
  }
  return null;
}

/** The cited lines plus the slack either side, lower-cased: where a claim's words must appear. */
export function spanText(lines: readonly string[], cite: Citation): string {
  return lines.slice(Math.max(0, cite.start - 1 - SLACK), cite.end + SLACK).join("\n").toLowerCase();
}

/**
 * Whether cited spans show an HTTP method: as a word in the code (get, HttpGet, Route::get,
 * methods=['GET']) or, for the CRUD methods, a resource declaration.
 */
export function methodShown(method: string, spans: readonly string[]): boolean {
  const verb = method.toLowerCase();
  return spans.some(
    (span) => span.includes(verb) || (verb === "delete" && DEL.test(span)) || (CRUD.has(verb) && RESOURCE.test(span)),
  );
}

/** superagent, node's http helpers and others spell DELETE `del`. */
const DEL = /\bdel\s*\(/;

/** Checks a page against the repo checked out at `root` (the indexed commit). */
export function checkPage(markdown: string, root: string): CheckedPage {
  const linesOf = fileReader(root);

  let claims = 0;
  const removed: RemovedClaim[] = [];
  const keep = (text: string): boolean => {
    if (!isClaim(text)) return true;
    claims++;
    const reason = unsupported(text, root, linesOf);
    if (reason) removed.push({ text: text.trim(), reason });
    return reason === null;
  };

  const out: string[] = [];
  let inCode = false;
  let diagram: string[] | null = null;
  const lines = markdown.split(/\r?\n/);
  lines.forEach((line, i) => {
    // A Mermaid diagram is checked element by element once its closing fence is reached.
    if (diagram) {
      if (!/^\s*(```|~~~)/.test(line)) {
        diagram.push(line);
        return;
      }
      const checked = checkDiagram(diagram.slice(1), (label, cites) => elementProblem(label, cites, root, linesOf));
      claims += checked.claims;
      removed.push(...checked.removed);
      if (checked.lines) out.push(diagram[0]!, ...checked.lines, line);
      diagram = null;
      return;
    }
    if (!inCode && opensDiagram(line)) {
      diagram = [line];
      return;
    }
    if (/^\s*(```|~~~)/.test(line)) inCode = !inCode;
    // A table's header row (the row above its |---| line) names columns; it claims nothing.
    const header = /^\s*\|/.test(line) && TABLE_RULE.test(lines[i + 1] ?? "");
    if (inCode || header || /^\s*(```|~~~|#)/.test(line) || TABLE_RULE.test(line) || line.trim() === "") {
      out.push(line);
      return;
    }
    // List items and table rows are one claim each; paragraphs are split into sentences.
    if (/^\s*([-*+]|\d+\.)\s|^\s*\|/.test(line)) {
      if (keep(line)) out.push(line);
      else if (ORDERED.test(line)) out.push(GONE + line);
      return;
    }
    const kept = sentences(line).filter(keep);
    if (kept.length) out.push(kept.join(" "));
  });

  return {
    markdown: tidy(out).join("\n").replace(/\[([^\]]+)\]\(https?:[^)]*\)/g, "$1"),
    claims,
    removed,
    publishable: claims > 0 && claims - removed.length >= claims / 2,
  };
}

/**
 * The cited claims of a page, split as `checkPage` splits them: a list item or table row is one,
 * a paragraph is one per sentence. Code blocks and diagrams hold none.
 */
export function claimsOf(markdown: string): { text: string; cites: Citation[] }[] {
  const claims: { text: string; cites: Citation[] }[] = [];
  const add = (text: string) => {
    const cites = parseCitations(text);
    if (cites.length) claims.push({ text: text.trim(), cites });
  };
  let inCode = false;
  let inDiagram = false;
  const lines = markdown.split(/\r?\n/);
  lines.forEach((line, i) => {
    if (inDiagram) {
      inDiagram = !FENCE.test(line);
      return;
    }
    if (!inCode && opensDiagram(line)) {
      inDiagram = true;
      return;
    }
    if (FENCE.test(line)) inCode = !inCode;
    const header = /^\s*\|/.test(line) && TABLE_RULE.test(lines[i + 1] ?? "");
    if (inCode || header || /^\s*(```|~~~|#)/.test(line) || TABLE_RULE.test(line) || line.trim() === "") return;
    if (/^\s*([-*+]|\d+\.)\s|^\s*\|/.test(line)) add(line);
    else sentences(line).forEach(add);
  });
  return claims;
}

/** Marks a numbered step the check removed, so the steps after it can be counted again. Never output. */
const GONE = "\0";
const FENCE = /^\s*(```|~~~)/;
const ORDERED = /^(\s*)(\d+)([.)])(\s+)/;
const HEADING = /^\s{0,3}(#{1,6})(?:\s|$)/;

/**
 * Tidies what the line pass left: numbered steps count again from their run's first number (a
 * removed step leaves no gap), and a heading whose section lost all its content goes too. The
 * page's first heading, its title, stays. Code and diagrams are never touched.
 */
function tidy(lines: readonly string[]): string[] {
  const numbered = renumber(lines);
  let inCode = false;
  const level = numbered.map((line) => {
    if (FENCE.test(line)) {
      inCode = !inCode;
      return 0;
    }
    return inCode ? 0 : (HEADING.exec(line)?.[1]?.length ?? 0);
  });
  const dropped = new Set<number>();
  // Last heading first, so a sub-heading is settled before the section that holds it.
  for (let h = level.length - 1; h > level.findIndex((l) => l > 0); h--) {
    if (level[h] === 0) continue;
    let content = false;
    for (let i = h + 1; i < level.length && !content; i++) {
      if (level[i]! > 0 && level[i]! <= level[h]!) break;
      content = level[i]! > 0 ? !dropped.has(i) : numbered[i]!.trim() !== "";
    }
    if (!content) dropped.add(h);
  }
  const out: string[] = [];
  let skipBlank = false;
  numbered.forEach((line, i) => {
    if (dropped.has(i)) {
      skipBlank = true;
      return;
    }
    // The blank lines under a dropped heading go with it.
    if (skipBlank && line.trim() === "") return;
    skipBlank = false;
    out.push(line);
  });
  return out;
}

/** Each run of ordered items at one indentation, counted from its first number. */
function renumber(lines: readonly string[]): string[] {
  const runs: { indent: number; next: number }[] = [];
  let inCode = false;
  const counted = lines.map((marked) => {
    const gone = marked.startsWith(GONE);
    const line = gone ? marked.slice(GONE.length) : marked;
    if (FENCE.test(line)) {
      inCode = !inCode;
      runs.length = 0;
      return line;
    }
    if (inCode || line.trim() === "") return line;
    const indent = line.length - line.trimStart().length;
    const item = ORDERED.exec(line);
    // Text that isn't indented under a run ends it; so does a bullet or heading at its level.
    const ends = (run: { indent: number }) => (item ? run.indent > indent : run.indent >= indent);
    while (runs.length && ends(runs[runs.length - 1]!)) runs.pop();
    if (HEADING.test(line)) runs.length = 0;
    if (!item) return line;
    const top = runs[runs.length - 1];
    // A removed step takes no number, but a removed first step still starts the count at its own.
    if (gone) {
      if (!top || top.indent !== indent) runs.push({ indent, next: Number(item[2]) });
      return marked;
    }
    if (top && top.indent === indent) return `${item[1]}${top.next++}${item[3]}${item[4]}${line.slice(item[0].length)}`;
    runs.push({ indent, next: Number(item[2]) + 1 });
    return line;
  });
  return counted.filter((line) => !line.startsWith(GONE));
}

/**
 * A sentence ends after its citations: "… [a.ts:3]. Next …" or "… [a.ts:3] Next …". A citation
 * followed by lower-case text ("… [a.ts:3] and also …") is mid-sentence, so it doesn't split.
 */
function sentences(line: string): string[] {
  return line.split(/(?<=\]\.)\s+(?=\S)|(?<=\])\s+(?=[A-Z`*])/);
}

/** Anything that cites code is a claim, however short; uncited text is one once it says something. */
function isClaim(text: string): boolean {
  if (parseCitations(text).length > 0) return true;
  const prose = text.replace(/^\s*([-*+]|\d+\.)\s|\|/g, "").trim();
  return prose.length >= MIN_CLAIM_CHARS && !prose.endsWith(":");
}

/** Why a claim isn't supported by what it cites, or null if it is. */
function unsupported(text: string, root: string, linesOf: (path: string) => string[] | null): string | null {
  const cites = parseCitations(text);
  if (cites.length === 0) {
    const unreadable = unreadableCitation(text);
    return unreadable ? `no citation it can read: ${unreadable.slice(0, 80)}` : "no citation";
  }
  return claimProblem(text, cites, root, linesOf);
}

/**
 * Why `cites` don't support `text`, or null: each must name lines that exist (at most 80), and
 * every name in backticks must appear in them. Shared by wiki claims and fact checks.
 */
export function claimProblem(text: string, cites: readonly Citation[], root: string, linesOf: (path: string) => string[] | null): string | null {
  const spans: string[] = [];
  for (const cite of cites) {
    const lines = linesOf(cite.path);
    const problem = citationProblem(cite, lines);
    if (problem) return problem;
    spans.push(spanText(lines!, cite));
  }

  for (const [, term] of withoutCitations(text).matchAll(/`([^`]+)`/g)) {
    if (!supported(term!.trim(), cites, root, spans, linesOf)) return `\`${term}\` isn't in the cited lines`;
  }
  return null;
}

/** Words too common in diagram labels to show a box is about the cited lines. */
const GENERIC = new Set(["service", "services", "server", "client", "request", "response", "returns", "return", "calls", "call", "sends", "send", "with", "from", "into", "data", "user", "users", "then", "when", "each", "this", "that", "application", "app"]);

/**
 * Why a diagram element's citations don't support its label, or null: the citations must be
 * readable like a sentence's, and at least one of the label's distinctive words must be in the
 * cited lines, or name a cited file or one beside it.
 */
function elementProblem(label: string, cites: readonly Citation[], root: string, linesOf: (path: string) => string[] | null): string | null {
  const spans: string[] = [];
  for (const cite of cites) {
    const lines = linesOf(cite.path);
    const problem = citationProblem(cite, lines);
    if (problem) return problem;
    spans.push(spanText(lines!, cite));
  }
  const words = (label.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []).filter((w) => w.length >= 4 && !GENERIC.has(w.toLowerCase()));
  if (words.length === 0 || words.some((word) => supported(word, cites, root, spans, linesOf))) return null;
  return `none of "${label.trim()}" is in the cited lines`;
}

/**
 * A named term is supported when it is a cited file or a path in the repo; when its most
 * specific word appears in a cited span; or when that word names a cited file or a file beside
 * one (`ArticleFilter` citing ArticleFilter.php, `FollowedPeople` citing Domain/Article.cs next
 * to Domain/FollowedPeople.cs). Code is paraphrased (`dotnet tool restore` for
 * Run("dotnet", "tool restore")) and namespaced (`App\User` for class User), so whole-term
 * matching rejects correct claims. Dashes and underscores count as the same. A route's path word
 * may also be anywhere in a cited file, as a prefix declared apart from the route
 * (`APIRouter(prefix="/tasks")` above `@router.post("/")`).
 */
function supported(term: string, cites: readonly Citation[], root: string, spans: readonly string[], linesOf: (path: string) => string[] | null): boolean {
  if (term.length < 2) return true;
  const path = term.replace(/^\.?\//, "").replace(/\/\*{1,2}$/, "").replace(/\/$/, "");
  // A cited file, or the folder holding one (`src`).
  if (cites.some((c) => c.path === path || c.path.startsWith(`${path}/`))) return true;
  if (/[/\\]|\.\w{1,6}$/.test(path) && !/\s/.test(path) && existsSync(join(root, path))) return true;
  // A route (`PATCH /articles/{slug}`, `GET articles`, a bare `PUT`) needs its method in the cited
  // lines too, as get, HttpGet, Route::get…, or a resource declaration there.
  const verb = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)(?=\s|$)/i.exec(term)?.[1]?.toLowerCase();
  if (verb && !methodShown(verb, spans)) return false;
  if (verb && term.length === verb.length) return true;
  const words = term.match(/[A-Za-z_][A-Za-z0-9_-]*/g)?.filter((w) => w.length >= 3) ?? [];
  const needle = loose(words.at(-1) ?? term);
  if (spans.some((span) => loose(span).includes(needle))) return true;
  if (verb && cites.some((c) => linesOf(c.path)?.some((line) => loose(line).includes(needle)))) return true;
  // `ArticleController@show` for a resource's implied action.
  if (CRUD_ACTIONS.has(needle) && spans.some((span) => RESOURCE.test(span))) return true;
  return cites.some((c) => [c.path, ...siblings(root, c.path)].some((file) => loose(basename(file, extname(file))) === needle));
}

/** Case-insensitive, with dashes and underscores ignored (`follow_user` and `followUser` meet). */
export function loose(text: string): string {
  return text.toLowerCase().replace(/[-_]/g, "");
}

function siblings(root: string, path: string): string[] {
  try {
    return readdirSync(join(root, dirname(path)));
  } catch {
    return [];
  }
}
