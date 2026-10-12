import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { parseCitations, unreadableCitation, withoutCitations, type Citation } from "../core/citations.js";

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
  const lines = markdown.split(/\r?\n/);
  lines.forEach((line, i) => {
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
      return;
    }
    const kept = sentences(line).filter(keep);
    if (kept.length) out.push(kept.join(" "));
  });

  return {
    markdown: out.join("\n").replace(/\[([^\]]+)\]\(https?:[^)]*\)/g, "$1"),
    claims,
    removed,
    publishable: claims > 0 && claims - removed.length >= claims / 2,
  };
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

  const spans: string[] = [];
  for (const cite of cites) {
    const lines = linesOf(cite.path);
    const problem = citationProblem(cite, lines);
    if (problem) return problem;
    spans.push(spanText(lines!, cite));
  }

  for (const [, term] of withoutCitations(text).matchAll(/`([^`]+)`/g)) {
    if (!supported(term!.trim(), cites, root, spans)) return `\`${term}\` isn't in the cited lines`;
  }
  return null;
}

/**
 * A named term is supported when it is a cited file or a path in the repo; when its most
 * specific word appears in a cited span; or when that word names a cited file or a file beside
 * one (`ArticleFilter` citing ArticleFilter.php, `FollowedPeople` citing Domain/Article.cs next
 * to Domain/FollowedPeople.cs). Code is paraphrased (`dotnet tool restore` for
 * Run("dotnet", "tool restore")) and namespaced (`App\User` for class User), so whole-term
 * matching rejects correct claims. Dashes and underscores count as the same.
 */
function supported(term: string, cites: readonly Citation[], root: string, spans: readonly string[]): boolean {
  if (term.length < 2) return true;
  const path = term.replace(/^\.?\//, "").replace(/\/\*{1,2}$/, "").replace(/\/$/, "");
  if (cites.some((c) => c.path === path)) return true;
  if (/[/\\]|\.\w{1,6}$/.test(path) && !/\s/.test(path) && existsSync(join(root, path))) return true;
  // A route (`PATCH /articles/{slug}`, `GET articles`, a bare `PUT`) needs its method in the cited
  // lines too, as get, HttpGet, Route::get…, or a resource declaration there.
  const verb = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)(?=\s|$)/i.exec(term)?.[1]?.toLowerCase();
  if (verb && !methodShown(verb, spans)) return false;
  if (verb && term.length === verb.length) return true;
  const words = term.match(/[A-Za-z_][A-Za-z0-9_-]*/g)?.filter((w) => w.length >= 3) ?? [];
  const needle = loose(words.at(-1) ?? term);
  if (spans.some((span) => loose(span).includes(needle))) return true;
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
