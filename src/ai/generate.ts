import { changedFiles, withWorktree, type ChangedFile } from "../core/git.js";
import { BrainError, type WikiPage } from "../core/types.js";
import { requireRepo } from "../ingest/registry.js";
import type { Store } from "../store/store.js";
import { isAffected } from "./affected.js";
import { checkPage, type CheckedPage, type RemovedClaim } from "./check.js";
import { prompt } from "./prompts.js";
import type { Runner } from "./runner.js";

/** Sonnet wrote pages as well as Opus at a quarter of the cost in the first trial (docs/decisions.md). */
export const DEFAULT_MODEL = "sonnet";

/** At most this many changed files are listed in an update prompt; the AI can read the rest. */
const MAX_LISTED_CHANGES = 200;

function updatePrompt(pages: readonly WikiPage[], changes: readonly ChangedFile[] | null): string {
  const listed = (changes ?? []).slice(0, MAX_LISTED_CHANGES).map((c) => `- ${c.status} ${c.path}`);
  if (changes && changes.length > MAX_LISTED_CHANGES) listed.push(`- … and ${changes.length - MAX_LISTED_CHANGES} more`);
  if (changes === null) listed.push("- (the earlier commit can't be compared; check everything)");
  return prompt("update-pages", {
    changes: listed.join("\n"),
    pages: pages.map((p) => pageBlock(p.slug, p.markdown)).join("\n"),
    product: productGuide(pages.map((p) => p.slug)),
  });
}

/** Asks for pages every wiki should have but this one lacks, such as a wiki written before the product page existed. */
function addPrompt(slugs: readonly string[]): string {
  const wanted = requiredPages();
  return prompt("add-pages", { pages: slugs.map((slug) => wanted.get(slug)!).join("\n"), product: productGuide(slugs) });
}

/** The product page's own rules, for any run that writes it. */
function productGuide(slugs: readonly string[]): string {
  return slugs.includes(PRODUCT) ? prompt("product-page") : "";
}

/** The slug of the page written in product language, for a PO or a new joiner. */
export const PRODUCT = "product";

/**
 * The pages every wiki has (prompts/pages.md), by slug, with the line asking for each. The page
 * on the most important module isn't among them: its slug is the AI's choice.
 */
export function requiredPages(): Map<string, string> {
  return new Map(
    prompt("pages")
      .split(/\r?\n/)
      .flatMap((line) => {
        const slug = /^- slug "([a-z0-9-]+)"/.exec(line)?.[1];
        return slug ? [[slug, line] as const] : [];
      }),
  );
}

function retryPrompt(failed: readonly Checked[]): string {
  const blocks = failed.map(({ draft, check }) => {
    const removed = check.removed.map((r) => `- "${r.text}": ${r.reason}`).join("\n");
    return `${pageBlock(draft.slug, draft.markdown)}\nClaims the check removed from it:\n${removed || "- (none: the page had no cited claims)"}`;
  });
  return prompt("retry-pages", { pages: blocks.join("\n"), product: productGuide(failed.map((c) => c.draft.slug)) });
}

function pageBlock(slug: string, markdown: string): string {
  return `<page slug="${slug}">\n${markdown}\n</page>`;
}

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** The structured output every run returns; `slugs` restricts it to the pages asked for. */
function pagesSchema(slugs?: readonly string[]): object {
  return {
    type: "object",
    properties: {
      pages: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          properties: {
            slug: slugs ? { type: "string", enum: slugs } : { type: "string", pattern: SLUG.source },
            title: { type: "string" },
            markdown: { type: "string" },
          },
          required: ["slug", "title", "markdown"],
        },
      },
    },
    required: ["pages"],
  };
}

interface DraftPage {
  slug: string;
  title: string;
  markdown: string;
}

interface Checked {
  draft: DraftPage;
  check: CheckedPage;
  attempts: number;
}

/** What the citation checker did to one page the AI wrote this run. */
export interface PageReport {
  slug: string;
  claims: number;
  removed: RemovedClaim[];
  /** False when the page failed the check; its previous version (if any) was kept instead. */
  published: boolean;
  /** 2 when the first draft failed the check and the page was written again. */
  attempts: number;
}

export interface WikiOptions {
  model?: string;
  /** Rewrite every page even if the wiki exists. Without it, only pages a change affects are. */
  full?: boolean;
}

export interface WikiResult {
  repo: string;
  commit: string;
  /** "full": every page written from scratch; "update": only the pages changes affected. */
  mode: "full" | "update";
  /** The wiki as stored: pages written or carried to this commit, plus kept older versions. */
  pages: WikiPage[];
  /** One per page the AI wrote this run. Empty when nothing needed rewriting. */
  reports: PageReport[];
  /** Pages moved to this commit without the AI: nothing they cite changed and they still pass. */
  carried: string[];
  /** Pages every wiki should have that failed at this commit, so weren't tried again this run. */
  waiting: string[];
  costUsd: number;
  durationMs: number;
}

/**
 * Brings a repo's wiki up to the commit the brain has indexed. A new wiki is written in full.
 * An existing one is updated: only pages a change affects are rewritten; the rest are re-checked
 * against the new commit and carried forward with no AI run, and any page every wiki should have
 * but this one lacks (prompts/pages.md) is written on its own. Every page the AI writes is checked
 * against that commit, and one that mostly fails is written once more; if it fails again its
 * previous version stays. All of it happens in a temporary worktree of the commit, so pages
 * never describe uncommitted work. Malformed output leaves the wiki as it was.
 */
export async function generateWiki(store: Store, runner: Runner, name: string, options: WikiOptions = {}): Promise<WikiResult> {
  const repo = requireRepo(store, name);
  const state = store.getState(name);
  if (!state) throw new BrainError(`"${name}" has not been synced yet. Run: brain sync ${name}`);
  const model = options.model ?? DEFAULT_MODEL;
  const previous = store.pages(name);
  const mode = options.full || previous.length === 0 ? "full" : "update";
  const lacking = mode === "update" ? [...requiredPages().keys()].filter((slug) => !previous.some((p) => p.slug === slug)) : [];
  // A missing page that already failed at this commit waits for the code to change.
  const missing = state.pagesFailedAt === state.commit ? [] : lacking;

  // What changed since each page was written. A page kept after a failed rewrite is older than the rest.
  const changesSince = new Map<string, ChangedFile[] | null>();
  if (mode === "update") {
    for (const commit of new Set(previous.map((p) => p.commit))) {
      changesSince.set(commit, commit === state.commit ? [] : await changedFiles(repo.path, commit, state.commit));
    }
  }

  let costUsd = 0;
  let durationMs = 0;
  let modelUsed = model;
  const write = async (cwd: string, prompt: string, slugs?: string[]): Promise<DraftPage[]> => {
    const result = await runner.run<{ pages: DraftPage[] }>({ cwd, prompt, schema: pagesSchema(slugs), model });
    costUsd += result.costUsd;
    durationMs += result.durationMs;
    modelUsed = result.model;
    return validPages(result.output, slugs);
  };

  const { checked, carried } = await withWorktree(repo.path, state.commit, async (cwd) => {
    const carried = new Map<string, WikiPage>();
    let drafts: DraftPage[] = [];
    if (mode === "full") {
      drafts = await write(cwd, prompt("write-pages", { pages: prompt("pages"), product: prompt("product-page") }));
    } else {
      const stale: WikiPage[] = [];
      for (const page of previous) {
        if (page.commit === state.commit) continue;
        if (isAffected(page.markdown, changesSince.get(page.commit)!)) {
          stale.push(page);
          continue;
        }
        const check = checkPage(page.markdown, cwd);
        if (check.publishable) carried.set(page.slug, { ...page, ...counts(check), markdown: check.markdown.trim(), commit: state.commit });
        else stale.push(page);
      }
      if (stale.length) {
        const changes = unionOf(stale.map((p) => changesSince.get(p.commit)!));
        drafts = await write(cwd, updatePrompt(stale, changes), stale.map((p) => p.slug));
        // A page the AI left out counts as failed, so it's asked for again below.
        for (const page of stale) {
          if (!drafts.some((d) => d.slug === page.slug)) drafts.push({ slug: page.slug, title: page.title, markdown: "" });
        }
      }
      // A page every wiki should have but this one lacks (the product page, for wikis written
      // before it existed) is written on its own, without touching the others.
      if (missing.length) {
        const added = await write(cwd, addPrompt(missing), missing);
        drafts.push(...added);
        for (const slug of missing) {
          if (!added.some((d) => d.slug === slug)) drafts.push({ slug, title: slug, markdown: "" });
        }
      }
    }

    const checked: Checked[] = drafts.map((draft) => ({ draft, check: checkPage(draft.markdown, cwd), attempts: 1 }));
    const failed = checked.filter((c) => !c.check.publishable);
    if (failed.length) {
      try {
        for (const draft of await write(cwd, retryPrompt(failed), failed.map((c) => c.draft.slug))) {
          const index = checked.findIndex((c) => c.draft.slug === draft.slug);
          checked[index] = { draft, check: checkPage(draft.markdown, cwd), attempts: 2 };
        }
      } catch (error) {
        // A failed retry changes nothing: the first attempt's results stand.
        if (!(error instanceof BrainError)) throw error;
      }
    }
    return { checked, carried };
  });

  const generatedAt = new Date().toISOString();
  const costEach = checked.length ? costUsd / checked.length : 0;
  const written = new Map<string, WikiPage>();
  for (const { draft, check } of checked) {
    if (!check.publishable) continue;
    written.set(draft.slug, {
      repo: name,
      slug: draft.slug,
      title: draft.title.trim(),
      markdown: check.markdown.trim(),
      commit: state.commit,
      ...counts(check),
      model: modelUsed,
      costUsd: costEach,
      generatedAt,
    });
  }
  const reports = checked.map(({ draft, check, attempts }): PageReport => ({
    slug: draft.slug,
    claims: check.claims,
    removed: check.removed,
    published: check.publishable,
    attempts,
  }));

  if (mode === "full" && written.size === 0) {
    throw new BrainError(
      `No page passed the citation check, so the wiki was left as it was. ` +
        reports.map((r) => `${r.slug}: ${r.claims - r.removed.length}/${r.claims} claims supported`).join("; "),
    );
  }
  // A full run sets the page list; an update keeps it, adding any missing page that passed. Either
  // way a failed page keeps its old version.
  const before = new Map(previous.map((page) => [page.slug, page]));
  const slugs = mode === "full" ? checked.map((c) => c.draft.slug) : [...previous.map((p) => p.slug), ...missing];
  const pages = slugs.flatMap((slug) => written.get(slug) ?? carried.get(slug) ?? before.get(slug) ?? []);
  store.replacePages(name, pages);
  const stillMissing = [...requiredPages().keys()].filter((slug) => !pages.some((p) => p.slug === slug));
  // Only a run that tried a required page records whether it failed; a waiting page keeps waiting.
  if (missing.length || mode === "full") store.setPagesFailedAt(name, stillMissing.length ? state.commit : null);
  const waiting = missing.length ? [] : lacking;
  return { repo: name, commit: state.commit, mode, pages, reports, carried: [...carried.keys()], waiting, costUsd, durationMs };
}

function counts(check: CheckedPage): Pick<WikiPage, "claims" | "removed"> {
  return { claims: check.claims, removed: check.removed.length };
}

/** Every change in any of the lists, once; null if any list is unknown. */
function unionOf(lists: readonly (ChangedFile[] | null)[]): ChangedFile[] | null {
  const byPath = new Map<string, ChangedFile>();
  for (const list of lists) {
    if (list === null) return null;
    for (const change of list) byPath.set(change.path, change);
  }
  return [...byPath.values()];
}

/** The schema is a request, not a guarantee: check the shape before anything is stored. */
function validPages(output: { pages?: unknown }, expected?: readonly string[]): DraftPage[] {
  const pages = Array.isArray(output?.pages) ? output.pages : [];
  const valid = pages.filter(
    (p): p is DraftPage =>
      typeof p?.slug === "string" &&
      SLUG.test(p.slug) &&
      (!expected || expected.includes(p.slug)) &&
      typeof p.title === "string" &&
      p.title.trim() !== "" &&
      typeof p.markdown === "string" &&
      p.markdown.trim() !== "",
  );
  const slugs = new Set(valid.map((p) => p.slug));
  if (valid.length === 0 || valid.length !== pages.length || slugs.size !== valid.length) {
    throw new BrainError("The AI's pages were malformed (missing fields, bad, unexpected or duplicate slugs). Nothing was stored.");
  }
  return valid;
}
