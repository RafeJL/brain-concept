import type { Freshness, WikiPage } from "../../core/types.js";
import type { Caller } from "../access.js";
import { describeFreshness, freshnessOf } from "../freshness.js";
import { requireSyncedRepo, TIER, wikiCommit, type ToolDeps, type ToolResult } from "./common.js";
import { systemOverview } from "./system-overview.js";

export interface PageInput {
  repo: string;
  /** A page slug; omitted to list the repo's pages. */
  page?: string;
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
    const rows = pages.map((p) => `  ${p.slug.padEnd(24)} ${p.title}${keptNote(p) ? ` (${keptNote(p)})` : ""}`);
    const freshness = await freshnessOf(repo, { ...state, commit: newest });
    const text = [
      `${repo.name} wiki · ${pages.length} pages · ${describeFreshness(freshness, repo.ref)} · ${TIER}`,
      ...rows,
      "",
      `Read one with page set to its name, e.g. "${pages[0]!.slug}".`,
    ].join("\n");
    return { ok: true, data: { repo: repo.name, pages, freshness }, text };
  }

  const page = pages.find((p) => p.slug === input.page);
  if (!page) {
    return { ok: false, text: `${repo.name} has no page "${input.page}". Pages: ${pages.map((p) => p.slug).join(", ")}.` };
  }
  const freshness = await freshnessOf(repo, { ...state, commit: page.commit });
  const text = [
    `${repo.name} · ${page.slug} · ${describeFreshness(freshness, repo.ref)} · ${TIER} · ${checkedNote(page)}`,
    ...(keptNote(page) ? [`Note: ${keptNote(page)}, so this older version is shown.`] : []),
    "",
    page.markdown,
    "",
    CAUTION,
  ].join("\n");
  return { ok: true, data: { repo: repo.name, pages, page, freshness }, text };
}

/**
 * `brain_get`: a system's overview when `system` is given, otherwise a repo's wiki (`getPage`).
 * Exactly one of `repo` and `system` is needed.
 */
export async function getRequest(deps: ToolDeps, caller: Caller, input: { repo?: string; page?: string; system?: string }): Promise<ToolResult<unknown>> {
  if (input.system && (input.repo || input.page)) return { ok: false, text: "Give either a system, or a repo (with an optional page), not both." };
  if (input.system) return systemOverview(deps, caller, input.system);
  if (!input.repo) return { ok: false, text: "Give a repo (with an optional page), or a system to see its overview." };
  return getPage(deps, caller, { repo: input.repo, page: input.page });
}
