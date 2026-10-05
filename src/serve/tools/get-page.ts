import type { Freshness, WikiPage } from "../../core/types.js";
import type { Caller } from "../access.js";
import { describeFreshness, freshnessOf } from "../freshness.js";
import { requireSyncedRepo, type ToolDeps, type ToolResult } from "./common.js";

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

const CAUTION =
  "AI-written (llm-generated). Each [path:lines] cites the code a sentence is based on; confirm there before relying on it.";

/** A repo's AI-written wiki: the page list, or one page. Backs `brain_get` and `brain page`. */
export async function getPage(deps: ToolDeps, caller: Caller, input: PageInput): Promise<ToolResult<PageAnswer>> {
  const found = await requireSyncedRepo(deps, caller, input.repo);
  if (!found.ok) return found;
  const { repo, state } = found;

  const pages = deps.store.pages(repo.name);
  if (pages.length === 0) {
    return { ok: false, text: `${repo.name} has no wiki yet. Generate it with: brain wiki ${repo.name}` };
  }
  if (!input.page) {
    const rows = pages.map((p) => `  ${p.slug.padEnd(24)} ${p.title}`);
    const freshness = await freshnessOf(repo, { ...state, commit: pages[0]!.commit });
    const text = [
      `${repo.name} wiki · ${pages.length} pages · ${describeFreshness(freshness, repo.ref)} · llm-generated`,
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
    `${repo.name} · ${page.slug} · ${describeFreshness(freshness, repo.ref)} · llm-generated`,
    "",
    page.markdown,
    "",
    CAUTION,
  ].join("\n");
  return { ok: true, data: { repo: repo.name, pages, page, freshness }, text };
}
