import type { Seam } from "../../core/seams.js";
import type { SectionHit } from "../../store/store.js";
import type { Caller } from "../access.js";
import { describeFreshness, freshnessOf } from "../freshness.js";
import { builtFrom, count, PAGE_SIZE, pointer, readableRepos, type Format, type ToolDeps, type ToolResult } from "./common.js";
import { wikiCommit } from "./get-page.js";

export interface SearchInput {
  query: string;
  repos?: string[];
  format: Format;
  offset?: number;
}

export interface SearchAnswer {
  query: string;
  /** Matching wiki sections on this page of results, best first. */
  sections: SectionHit[];
  /** How many sections match in all. */
  sectionTotal: number;
  /** Every repo with a matching section or endpoint, not only those on this page. */
  matchedRepos: string[];
  /** Matching endpoints, one per repo, method and path, best first. Only on the first page. */
  endpoints: Seam[];
}

/** Words that say how a question is asked, not what it's about. */
const STOP_WORDS = new Set(
  ("a an and any are as at be by can do does for from has have how i in is it its me my of on or our the there " +
    "this to use used uses we what when where which who why with you your").split(" "),
);

/** Sections per page of results: each comes with a snippet, so fewer than other tools' rows. */
const SECTIONS = { concise: 8, detailed: PAGE_SIZE };
/** Endpoints listed per answer; brain_find_consumers has the rest. */
const ENDPOINTS = { concise: 5, detailed: 20 };
/** Endpoints looked at to fill that list, since one endpoint can be declared and called many times. */
const ENDPOINT_POOL = 200;

/**
 * The query as an FTS5 expression: its words, OR'd. Stemming already matches other forms
 * ("tests" finds "testing"); prefixes aren't used, since "run" would find "runtime" and "calls"
 * "Callback". Quotes and operators become plain words, so nobody writes FTS syntax by accident.
 * Null when the query has no words.
 */
export function matchExpression(query: string): string | null {
  const words = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])];
  const meaningful = words.filter((w) => !STOP_WORDS.has(w));
  const terms = meaningful.length ? meaningful : words;
  if (terms.length === 0) return null;
  return terms.map((w) => `"${w}"`).join(" OR ");
}

/**
 * Wiki sections and endpoints matching a question, across every repo the caller can read. Backs
 * `brain_search` and `brain search`: for when you don't know which repo or page holds the answer.
 */
export async function search(deps: ToolDeps, caller: Caller, input: SearchInput): Promise<ToolResult<SearchAnswer>> {
  const match = matchExpression(input.query);
  if (!match) return { ok: false, text: `"${input.query}" has no words to search for.` };
  const readable = await readableRepos(deps, caller);
  const scope = input.repos?.length ? readable.filter((name) => input.repos!.includes(name)) : readable;
  if (scope.length === 0) return { ok: false, text: "None of the requested repos are enrolled or readable." };

  const offset = input.offset ?? 0;
  const detailed = input.format === "detailed";
  const sections = deps.store.searchSections({ repos: scope, match, limit: SECTIONS[input.format], offset, snippetWords: detailed ? 40 : 24 });
  const seams = deps.store.searchSeams({ repos: scope, match, limit: ENDPOINT_POOL });
  const endpoints = offset === 0 ? distinctEndpoints(seams.hits) : [];
  const matchedRepos = [...new Set([...sections.repos, ...seams.repos])].sort();

  const data: SearchAnswer = { query: input.query, sections: sections.hits, sectionTotal: sections.total, matchedRepos, endpoints };
  return { ok: true, data, text: await render(deps, data, scope, input.format, offset) };
}

/** One endpoint per repo, kind, method and path: the best-ranked declaration or call of it. */
function distinctEndpoints(seams: readonly Seam[]): Seam[] {
  const seen = new Set<string>();
  return seams.filter((seam) => {
    const id = `${seam.repo}\u0000${seam.kind}\u0000${seam.method}\u0000${seam.rawPath}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

async function render(deps: ToolDeps, answer: SearchAnswer, scope: string[], format: Format, offset: number): Promise<string> {
  const { sections, sectionTotal, endpoints } = answer;
  const noWiki = scope.filter((name) => deps.store.pages(name).length === 0);
  const noWikiNote = noWiki.length ? `No wiki yet, so not searched: ${noWiki.join(", ")} (brain sync <repo> writes one).` : "";

  if (sectionTotal === 0 && endpoints.length === 0) {
    return [`No wiki sections or endpoints match "${answer.query}" in ${count(scope.length, "repo")}.`, noWikiNote].filter(Boolean).join("\n");
  }

  const found = new Set([...sections.map((s) => s.repo), ...endpoints.map((s) => s.repo)]);
  const summary = [
    ...(sectionTotal ? [count(sectionTotal, "section")] : []),
    ...(endpoints.length ? [count(endpoints.length, "endpoint")] : []),
  ].join(" and ");
  const lines = [`${summary} match "${answer.query}" across ${count(answer.matchedRepos.length, "repo")}`, ""];

  for (const hit of sections) {
    lines.push(`${hit.repo} · ${hit.slug} › ${hit.heading || hit.pageTitle}`);
    if (format === "detailed") {
      lines.push(`  page: ${hit.pageTitle}${hit.paths.length ? ` · cites ${hit.paths.slice(0, 5).join(", ")}${hit.paths.length > 5 ? ", …" : ""}` : ""}`);
    }
    lines.push(`  ${hit.snippet}`);
  }

  if (endpoints.length) {
    const shown = endpoints.slice(0, ENDPOINTS[format]);
    if (sections.length) lines.push("");
    lines.push("Endpoints:");
    for (const seam of shown) {
      const role = seam.kind === "http-route" ? "route" : "call";
      lines.push(`  ${seam.method} ${seam.rawPath} · ${pointer(seam)} (${role})${format === "detailed" ? builtFrom(seam) : ""}`);
    }
    if (endpoints.length > shown.length) lines.push(`  +${endpoints.length - shown.length} more.`);
  }

  lines.push("");
  const pageSize = SECTIONS[format];
  if (sectionTotal > offset + pageSize) {
    lines.push(`Showing sections ${offset + 1}-${offset + sections.length} of ${sectionTotal}. Pass offset=${offset + pageSize} for more.`);
  }
  const first = sections[0];
  if (first) lines.push(`Read a section's page with brain_get, e.g. repo "${first.repo}", page "${first.slug}".`);
  if (endpoints.length) lines.push("For every server and caller of an endpoint, use brain_find_consumers.");
  if (noWikiNote) lines.push(noWikiNote);
  lines.push(`Indexed: ${(await indexedAt(deps, [...found].sort())).join("; ")}`);
  lines.push("llm-generated: written by Claude Code from the code; confirm at the citation before relying on it.");
  return lines.join("\n");
}

/** Each repo's freshness: the commit its wiki describes, or its seams when it has no wiki. */
async function indexedAt(deps: ToolDeps, repos: readonly string[]): Promise<string[]> {
  const lines: string[] = [];
  for (const name of repos) {
    const repo = deps.store.getRepo(name);
    const state = deps.store.getState(name);
    if (!repo || !state) continue;
    const pages = deps.store.pages(name);
    const commit = pages.length ? wikiCommit(pages, state.commit) : (state.seamsCommit ?? state.commit);
    lines.push(`${name} ${describeFreshness(await freshnessOf(repo, { ...state, commit }), repo.ref)}`);
  }
  return lines;
}
