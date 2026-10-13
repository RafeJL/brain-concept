import { firstSentence, withoutDiagrams } from "../../core/sections.js";
import type { Freshness, PageKind, WikiPage } from "../../core/types.js";
import type { Caller } from "../access.js";
import { factBlock, factsAbout } from "../facts.js";
import { describeFreshness, freshnessOf } from "../freshness.js";
import { linkSummary, neighbours } from "../neighbours.js";
import { count, requireSyncedRepo, TIER, wikiCommit, type ToolDeps, type ToolResult } from "./common.js";
import { systemOverview } from "./system-overview.js";

export interface PageInput {
  repo: string;
  /** A page slug; omitted to list the repo's pages. */
  page?: string;
  /** Include the page's Mermaid diagrams. Agents rarely need them: the text says the same. */
  diagrams?: boolean;
}

export interface PageAnswer {
  repo: string;
  pages: WikiPage[];
  /** Set when one page was asked for. */
  page?: WikiPage;
  freshness?: Freshness;
}

/** What the citation checker found, for the page header. */
function checkedNote(page: WikiPage): string {
  if (page.claims === 0) return "citations not checked";
  const kept = page.claims - page.removed;
  return `citations checked: ${kept} of ${page.claims} claims kept${page.removed ? ` (${page.removed} removed)` : ""}`;
}

const CAUTION =
  "AI-written (llm-generated). Every claim kept here cites lines that exist and contain what it names; " +
  "whether it reads them correctly isn't checked, so confirm at the citation before relying on it.";

/** The page index's groups, in reading order. */
const KINDS: [PageKind, string][] = [
  ["core", "Core"],
  ["area", "Areas"],
  ["flow", "Flows"],
  ["data-model", "Data model"],
  ["integrations", "Integrations"],
];

const ABOUT_CHARS = 110;

/** A repo's AI-written wiki: the page list, or one page. Backs `brain_get` and `brain page`. */
export async function getPage(deps: ToolDeps, caller: Caller, input: PageInput): Promise<ToolResult<PageAnswer>> {
  const found = await requireSyncedRepo(deps, caller, input.repo);
  if (!found.ok) return found;
  const { repo, state } = found;

  const pages = deps.store.pages(repo.name);
  if (pages.length === 0) {
    return { ok: false, text: `${repo.name} has no wiki yet. Generate it with: brain sync ${repo.name}` };
  }
  const newest = wikiCommit(pages, state.commit);
  const keptNote = (p: WikiPage) =>
    p.commit === newest ? "" : `kept from @${p.commit.slice(0, 7)}: its rewrite at @${newest.slice(0, 7)} failed the citation check`;
  if (!input.page) {
    // Grouped by kind, with what each page covers, so a twenty-page wiki reads as a map.
    const row = (p: WikiPage) => {
      const about = firstSentence(p.markdown);
      return `  ${p.slug.padEnd(24)} ${p.title}${about ? `: ${clip(about)}` : ""}${keptNote(p) ? ` (${keptNote(p)})` : ""}`;
    };
    const groups = KINDS.flatMap(([kind, heading]) => {
      const of = pages.filter((p) => p.kind === kind);
      return of.length ? [`${heading}:`, ...of.map(row)] : [];
    });
    const freshness = await freshnessOf(repo, { ...state, commit: newest });
    const start = pages.some((p) => p.slug === "overview") ? "overview" : pages[0]!.slug;
    const text = [
      `${repo.name} wiki · ${pages.length} pages · ${describeFreshness(freshness, repo.ref)} · ${TIER}`,
      ...groups,
      "",
      `Read one with page set to its name; start with "${start}".`,
    ].join("\n");
    return { ok: true, data: { repo: repo.name, pages, freshness }, text };
  }

  const page = pages.find((p) => p.slug === input.page);
  if (!page) {
    return { ok: false, text: `${repo.name} has no page "${input.page}". Pages: ${pages.map((p) => p.slug).join(", ")}.` };
  }
  const freshness = await freshnessOf(repo, { ...state, commit: page.commit });
  // The product page opens with what people have stated about the repo and its system.
  const facts = page.slug === "product" ? factsAbout(deps.store, repo.name, found.readable) : [];
  const markdown = input.diagrams ? page.markdown : withoutDiagrams(page.markdown);
  // The integrations page names outside systems; the enrolled repos it talks to come from the
  // link map, worked out now, so they're never out of date.
  const links = page.kind === "integrations" ? linkLines(deps, repo.name, found.readable) : [];
  const text = [
    `${repo.name} · ${page.slug} · ${describeFreshness(freshness, repo.ref)} · ${TIER}${facts.length ? `, with ${count(facts.length, "fact")} from people` : ""} · ${checkedNote(page)}`,
    ...(keptNote(page) ? [`Note: ${keptNote(page)}, so this older version is shown.`] : []),
    "",
    ...factBlock(facts),
    markdown,
    ...links,
    "",
    ...(markdown !== page.markdown ? ["Its diagrams are left out: pass diagrams true to see them.", ""] : []),
    CAUTION,
  ].join("\n");
  return { ok: true, data: { repo: repo.name, pages, page, freshness }, text };
}

function clip(text: string): string {
  return text.length <= ABOUT_CHARS ? text : `${text.slice(0, ABOUT_CHARS - 1).trimEnd()}…`;
}

/** The enrolled repos this one talks to, from the checked link map. */
function linkLines(deps: ToolDeps, repo: string, readable: readonly string[]): string[] {
  const { calls, calledBy } = neighbours(deps.store, repo, readable);
  if (calls.length + calledBy.length === 0) return [];
  return [
    "",
    "## Other enrolled repos (from the brain's link map, checked against the code)",
    ...calls.map((n) => `- Uses ${n.repo}: ${linkSummary(n, "calls")}`),
    ...calledBy.map((n) => `- Used by ${n.repo}: ${linkSummary(n, "calledBy")}`),
    "",
    "Each link's file and line: brain_find_consumers or brain_impact.",
  ];
}

/**
 * `brain_get`: a system's overview when `system` is given, otherwise a repo's wiki (`getPage`).
 * Exactly one of `repo` and `system` is needed.
 */
export async function getRequest(
  deps: ToolDeps,
  caller: Caller,
  input: { repo?: string; page?: string; system?: string; diagrams?: boolean },
): Promise<ToolResult<unknown>> {
  if (input.system && (input.repo || input.page)) return { ok: false, text: "Give either a system, or a repo (with an optional page), not both." };
  if (input.system) return systemOverview(deps, caller, input.system);
  if (!input.repo) return { ok: false, text: "Give a repo (with an optional page), or a system to see its overview." };
  return getPage(deps, caller, input as PageInput);
}
