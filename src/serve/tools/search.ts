import type { FactRecord } from "../../core/facts.js";
import { KIND_LABEL, type Seam } from "../../core/seams.js";
import type { SystemRecord } from "../../core/systems.js";
import type { FactFilter, SectionHit } from "../../store/store.js";
import type { Caller } from "../access.js";
import { factLine, readableChecks, visibleFacts } from "../facts.js";
import { visibleSystems } from "../systems.js";
import { builtFrom, count, indexedAt, PAGE_SIZE, pointer, scopeOf, TIER, withoutWiki, type Format, type ToolDeps, type ToolResult } from "./common.js";

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
  /** Systems whose name or summary match, best first. Only on the first page. */
  systems: SystemRecord[];
  /** Facts people stated that match, best first. Only on the first page. */
  facts: FactRecord[];
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
/** Facts from people listed per answer. */
const FACTS = 5;

/**
 * The query as an FTS5 expression: its words, OR'd. Stemming already matches other forms
 * ("tests" finds "testing"); prefixes aren't used, since "run" would find "runtime" and "calls"
 * "Callback". Quotes and operators become plain words, so nobody writes FTS syntax by accident.
 * With `all`, every word must match instead. Null when the query has no words.
 */
export function matchExpression(query: string, all = false): string | null {
  const words = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])];
  const meaningful = words.filter((w) => !STOP_WORDS.has(w));
  const terms = meaningful.length ? meaningful : words;
  if (terms.length === 0) return null;
  return terms.map((w) => `"${w}"`).join(all ? " AND " : " OR ");
}

/**
 * Wiki sections and endpoints matching a question, across every repo the caller can read. Backs
 * `brain_search` and `brain search`: for when you don't know which repo or page holds the answer.
 */
export async function search(deps: ToolDeps, caller: Caller, input: SearchInput): Promise<ToolResult<SearchAnswer>> {
  const match = matchExpression(input.query);
  if (!match) return { ok: false, text: `"${input.query}" has no words to search for.` };
  const scoped = await scopeOf(deps, caller, input.repos);
  if (!scoped.ok) return scoped;
  const { readable, scope } = scoped;

  const offset = input.offset ?? 0;
  const detailed = input.format === "detailed";
  const sections = deps.store.searchSections({ repos: scope, match, limit: SECTIONS[input.format], offset, snippetWords: detailed ? 40 : 24 });
  const seams = deps.store.searchSeams({ repos: scope, match, limit: ENDPOINT_POOL });
  const endpoints = offset === 0 ? distinctEndpoints(seams.hits) : [];
  const matchedRepos = [...new Set([...sections.repos, ...seams.repos])].sort();
  const visible = visibleSystems(deps.store, scope);
  const systems = offset === 0 ? deps.store.searchSystems(match).flatMap((name) => visible.filter((s) => s.name === name)) : [];
  const factFilter = visibleFacts(deps.store, scope);
  const facts = offset === 0 ? readableChecks(deps.store.searchFacts({ ...factFilter, match, limit: FACTS }), readable) : [];
  if (offset === 0 && !answers(deps, scope, factFilter, input.query)) {
    // Worth an owner writing down (brain gaps).
    deps.store.logGap({ tool: "brain_search", query: input.query, repos: input.repos ?? [], askedAt: new Date().toISOString() });
  }

  const data: SearchAnswer = { query: input.query, sections: sections.hits, sectionTotal: sections.total, matchedRepos, endpoints, systems, facts };
  return { ok: true, data, text: await render(deps, data, scope, input.format, offset) };
}

/**
 * Whether anything the brain holds mentions every word of the question: a fact, a wiki section or
 * an endpoint. Words are OR'd for ranking, so "refund approval policy" still lists sections that
 * only say "policy"; when none has all three, the brain didn't really answer it.
 */
function answers(deps: ToolDeps, scope: readonly string[], factFilter: FactFilter, query: string): boolean {
  const all = matchExpression(query, true);
  if (!all) return true;
  const filter = { repos: scope, match: all, limit: 1 };
  return (
    deps.store.searchFacts({ ...factFilter, match: all, limit: 1 }).length > 0 ||
    deps.store.searchSections(filter).total > 0 ||
    deps.store.searchSeams(filter).total > 0
  );
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
  const { sections, sectionTotal, endpoints, systems, facts } = answer;
  const noWiki = withoutWiki(deps, scope);
  const noWikiNote = noWiki.length ? `No wiki yet, so not searched: ${noWiki.join(", ")} (brain sync <repo> writes one).` : "";

  if (sectionTotal === 0 && endpoints.length === 0 && systems.length === 0 && facts.length === 0) {
    return [`No wiki sections or endpoints match "${answer.query}" in ${count(scope.length, "repo")}.`, noWikiNote].filter(Boolean).join("\n");
  }

  const found = new Set([...sections.map((s) => s.repo), ...endpoints.map((s) => s.repo)]);
  const summary = [
    ...(facts.length ? [count(facts.length, "fact") + " from people"] : []),
    ...(sectionTotal ? [count(sectionTotal, "section")] : []),
    ...(endpoints.length ? [count(endpoints.length, "endpoint")] : []),
  ].join(", ");
  const lines = [summary ? `${summary} match "${answer.query}" across ${count(answer.matchedRepos.length, "repo")}` : `No wiki sections or endpoints match "${answer.query}"`, ""];

  // What people stated comes first: it is the team's own word, not the AI's reading of the code.
  if (facts.length) {
    lines.push("From people:");
    for (const fact of facts) lines.push(`  ${fact.repo ?? fact.system}: ${factLine(fact)}`);
    lines.push("");
  }

  // Then systems: a match on a product's name or summary is usually what the question is about.
  if (systems.length) {
    lines.push("Systems:");
    for (const system of systems) {
      const label = system.status === "suggested" ? "suggested" : "confirmed";
      lines.push(`  ${system.name} (${label}) · ${count(system.repos.length, "repo")}: ${system.repos.join(", ")}${system.summary ? ` · ${system.summary}` : ""}`);
    }
    lines.push(`  Read one with brain_get (system "${systems[0]!.name}").`, "");
  }

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
      const role = KIND_LABEL[seam.kind];
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
  if (found.size) lines.push(`Indexed: ${(await indexedAt(deps, [...found].sort())).join("; ")}`);
  lines.push(`${TIER}: written by Claude Code from the code; confirm at the citation before relying on it.`);
  return lines.join("\n");
}
