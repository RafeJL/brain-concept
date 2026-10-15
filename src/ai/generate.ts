import { changedFiles, inWorktree, type ChangedFile } from "../core/git.js";
import { BrainError, type PageKind, type PlannedPage, type WikiPage } from "../core/types.js";
import { requireRepo } from "../ingest/registry.js";
import type { Store } from "../store/store.js";
import { carriedPage } from "./affected.js";
import { checkPage, type CheckedPage, type RemovedClaim } from "./check.js";
import { inventory } from "./inventory.js";
import { CORE_PAGES, planLine, planOfPages, planPages, replanReason, withCorePages } from "./plan.js";
import { prompt } from "./prompts.js";
import type { Runner } from "./runner.js";

/** Sonnet wrote pages as well as Opus at a quarter of the cost in the first trial (docs/decisions.md). */
export const DEFAULT_MODEL = "sonnet";

/** At most this many changed files are listed in an update prompt; the AI can read the rest. */
const MAX_LISTED_CHANGES = 200;

/**
 * Pages one run writes at most; more are split into runs that go side by side. One run writing
 * twenty pages skims; four, starting from their key files, read closely.
 */
const BATCH_PAGES = 4;

/** The slug of the page written in product language, for a PO or a new joiner. */
export const PRODUCT = "product";

/**
 * The pages every small repo's wiki has (prompts/pages.md), by slug, with the line asking for
 * each. The page on the most important module isn't among them: its slug is the AI's choice.
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

/** A small repo's page kinds follow from their slugs. */
function kindOf(slug: string): PageKind {
  if (CORE_PAGES.includes(slug)) return "core";
  return slug === "data-model" || slug === "integrations" ? slug : "area";
}

/** What every page run is told besides its task: how each kind of page is written, the product page's rules, the steering note. */
function guide(slugs: readonly string[], note: string | null): string {
  return [slugs.includes(PRODUCT) ? prompt("product-page") : "", prompt("page-kinds"), note ? prompt("steering-note", { note }) : ""]
    .filter(Boolean)
    .join("\n");
}

function updatePrompt(pages: readonly WikiPage[], changes: readonly ChangedFile[] | null, note: string | null): string {
  const listed = (changes ?? []).slice(0, MAX_LISTED_CHANGES).map((c) => `- ${c.status} ${c.path}`);
  if (changes && changes.length > MAX_LISTED_CHANGES) listed.push(`- … and ${changes.length - MAX_LISTED_CHANGES} more`);
  if (changes === null) listed.push("- (the earlier commit can't be compared; check everything)");
  return prompt("update-pages", {
    changes: listed.join("\n"),
    pages: pages.map((p) => pageBlock(p.slug, p.markdown)).join("\n"),
    guide: guide(pages.map((p) => p.slug), note),
  });
}

/** Asks a small repo for pages every wiki should have but this one lacks, such as a wiki written before the product page existed. */
function addPrompt(slugs: readonly string[], note: string | null): string {
  const wanted = requiredPages();
  return prompt("add-pages", { pages: slugs.map((slug) => wanted.get(slug)!).join("\n"), guide: guide(slugs, note) });
}

/** Asks for some of a large repo's planned pages, with the whole plan for context. */
function plannedPrompt(plan: readonly PlannedPage[], pages: readonly PlannedPage[], note: string | null): string {
  const asked = pages.map(
    (p) =>
      `- slug "${p.slug}" (${p.kind}), title "${p.title}": ${p.brief || "as its title says"}.` +
      `${p.covers.length ? ` Covers ${p.covers.join(", ")}.` : ""}${p.keyFiles.length ? ` Start from ${p.keyFiles.join(", ")}.` : ""}`,
  );
  return prompt("write-planned-pages", { plan: plan.map(planLine).join("\n"), pages: asked.join("\n"), guide: guide(pages.map((p) => p.slug), note) });
}

function retryPrompt(failed: readonly Checked[], note: string | null): string {
  const blocks = failed.map(({ draft, check }) => {
    const removed = check.removed.map((r) => `- "${r.text}": ${r.reason}`).join("\n");
    return `${pageBlock(draft.slug, draft.markdown)}\nClaims the check removed from it:\n${removed || "- (none: the page had no cited claims)"}`;
  });
  return prompt("retry-pages", { pages: blocks.join("\n"), guide: guide(failed.map((c) => c.draft.slug), note) });
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

/** What planning did this run, for a large repo. */
export interface PlanReport {
  reason: string;
  /** Pages the new plan adds, and those it drops. Both empty when it kept the plan as it was. */
  added: string[];
  retired: string[];
  /** Why no plan passed the check, so the repo kept what it had. Empty when one did. */
  problems: string[];
}

export interface WikiOptions {
  model?: string;
  /** Rewrite every page even if the wiki exists. Without it, only pages a change affects are. */
  full?: boolean;
  /** A worktree of the indexed commit, shared with sync's other steps; one is made if not given. */
  cwd?: string;
  /** Told how many of the pages being written are done, once the number to write is known. */
  onPages?: (done: number, total: number) => void;
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
  /** Pages moved to this commit without the AI: nothing they cite changed, or only lines around it. */
  carried: string[];
  /** Pages the wiki should have that failed at this commit, so weren't tried again this run. */
  waiting: string[];
  /** Set when a large repo's wiki was planned this run. */
  plan: PlanReport | null;
  costUsd: number;
  durationMs: number;
}

/**
 * Brings a repo's wiki up to the commit the brain has indexed.
 *
 * A small repo gets the fixed pages (prompts/pages.md), plus data-model and integrations pages
 * where it has them, in one run. A large one (see `inventory`) is planned first: a page per area,
 * a few flow pages, and those two, written in runs of a few pages each, side by side. Its plan is
 * made again only when code arrives that no page covers, or the steering note changes.
 *
 * An existing wiki is updated: only pages whose cited lines changed (or whose folders gained a
 * file) are rewritten; the rest have their citations moved with the lines around them, are
 * re-checked and carried forward with no AI run. Every page the AI writes is checked against
 * the commit, and one that mostly fails is written once more; if it fails again its previous
 * version stays. All of it happens in a worktree of the commit, so pages never describe
 * uncommitted work. Malformed output leaves the wiki as it was.
 */
export async function generateWiki(store: Store, runner: Runner, name: string, options: WikiOptions = {}): Promise<WikiResult> {
  const repo = requireRepo(store, name);
  const state = store.getState(name);
  if (!state) throw new BrainError(`"${name}" has not been synced yet. Run: brain sync ${name}`);
  const started = Date.now();
  const model = options.model ?? DEFAULT_MODEL;
  const note = repo.note?.text ?? null;
  const previous = store.pages(name);
  const mode = options.full || previous.length === 0 ? "full" : "update";
  const map = inventory(store.getFiles(name));

  let costUsd = 0;
  let modelUsed = model;
  const write = async (cwd: string, ask: string, slugs?: string[]): Promise<DraftPage[]> => {
    const result = await runner.run<{ pages: DraftPage[] }>({ cwd, prompt: ask, schema: pagesSchema(slugs), model });
    costUsd += result.costUsd;
    modelUsed = result.model;
    return validPages(result.output, slugs);
  };
  // Pages written so far out of those this run writes, for anyone watching (retries aren't counted).
  const progress = { done: 0, total: 0 };
  const tally = (pages: number, more = 0) => {
    progress.done += pages;
    progress.total += more;
    if (progress.total) options.onPages?.(progress.done, progress.total);
  };
  /**
   * Runs of at most BATCH_PAGES pages, side by side. A run that fails counts its pages as failed
   * (empty), so they're retried or keep their old versions; the other runs' pages stand.
   */
  const inBatches = async <T extends { slug: string }>(cwd: string, items: readonly T[], ask: (batch: readonly T[]) => string, counted = true): Promise<DraftPage[]> => {
    const batches: T[][] = [];
    for (let i = 0; i < items.length; i += BATCH_PAGES) batches.push(items.slice(i, i + BATCH_PAGES));
    const drafts = await Promise.all(
      batches.map(async (batch) => {
        const slugs = batch.map((item) => item.slug);
        let got: DraftPage[] = [];
        try {
          got = await write(cwd, ask(batch), slugs);
        } catch (error) {
          if (!(error instanceof BrainError)) throw error;
        }
        if (counted) tally(slugs.length);
        return slugs.map((slug) => got.find((d) => d.slug === slug) ?? { slug, title: slug, markdown: "" });
      }),
    );
    return drafts.flat();
  };

  let plan = store.wikiPlan(name);
  let planReport: PlanReport | null = null;
  let replanned = false;
  let completed = false;

  const { checked, carried, planned } = await inWorktree(repo.path, state.commit, options.cwd, async (cwd) => {
    if (map.large) {
      const added = plan.length && state.planCommit && mode === "update" ? await changedFiles(repo.path, state.planCommit, state.commit) : null;
      const reason = mode === "full" ? "a full rewrite" : replanReason(plan, added, note !== state.planNote);
      if (reason) {
        // An update keeps the pages the wiki has; a wiki from before plans is its own plan to keep.
        const before = mode === "full" ? [] : plan.length ? plan : planOfPages(previous);
        const made = await planPages(runner, cwd, { inventory: map.text, note, current: before, model });
        costUsd += made.costUsd;
        if (made.plan) {
          const was = new Set((before.length ? before : previous).map((p) => p.slug));
          const now = new Set(made.plan.map((p) => p.slug));
          planReport = { reason, added: [...now].filter((s) => !was.has(s)), retired: [...was].filter((s) => !now.has(s)), problems: [] };
          plan = made.plan;
          replanned = true;
        } else {
          planReport = { reason, added: [], retired: [], problems: made.problems };
        }
      }
    }
    // A stored plan from before a core page existed gains it; its page is then written like any new one.
    if (map.large && mode === "update" && !replanned && plan.length) {
      const whole = withCorePages(plan);
      completed = whole.length !== plan.length;
      plan = whole;
    }
    const planned = map.large && plan.length > 0;

    const carried = new Map<string, WikiPage>();
    let drafts: DraftPage[] = [];
    if (mode === "full") {
      if (planned) {
        tally(0, plan.length);
        drafts = await inBatches(cwd, plan, (batch) => plannedPrompt(plan, batch, note));
      } else {
        // One run picks and writes a small repo's pages, so how many is known once it returns.
        drafts = await write(cwd, prompt("write-pages", { pages: prompt("pages"), guide: guide([PRODUCT], note) }));
      }
      // A run that left out pages every wiki has is asked for them on their own, as an update would.
      const left = planned ? [] : [...requiredPages().keys()].filter((slug) => !drafts.some((d) => d.slug === slug));
      if (!planned) tally(drafts.length, drafts.length + left.length);
      drafts.push(...(await inBatches(cwd, left.map((slug) => ({ slug })), (batch) => addPrompt(batch.map((b) => b.slug), note))));
    } else {
      const stale: WikiPage[] = [];
      const changesSince = new Map<string, ChangedFile[] | null>();
      for (const page of previous) {
        // A page the plan dropped isn't kept; a page already at this commit needs nothing.
        if (page.commit === state.commit || (planned && !plan.some((p) => p.slug === page.slug))) continue;
        if (!changesSince.has(page.commit)) changesSince.set(page.commit, await changedFiles(repo.path, page.commit, state.commit));
        const moved = await carriedPage(page.markdown, repo.path, page.commit, state.commit, changesSince.get(page.commit)!);
        const check = moved === null ? null : checkPage(moved, cwd);
        if (check?.publishable) carried.set(page.slug, { ...page, ...counts(check), markdown: check.markdown.trim(), commit: state.commit });
        else stale.push(page);
      }
      // A missing page that already failed at this commit waits for the code (or the plan) to change.
      const retry = replanned || state.pagesFailedAt !== state.commit;
      const has = (slug: string) => previous.some((p) => p.slug === slug);
      const newPlanned = retry && planned ? plan.filter((p) => !has(p.slug)) : [];
      const newRequired = retry && !planned ? [...requiredPages().keys()].filter((slug) => !has(slug)).map((slug) => ({ slug })) : [];
      tally(0, stale.length + newPlanned.length + newRequired.length);
      const written = await Promise.all([
        inBatches(cwd, stale, (batch) => updatePrompt(batch, unionOf(batch.map((p) => changesSince.get(p.commit)!)), note)),
        inBatches(cwd, newPlanned, (batch) => plannedPrompt(plan, batch, note)),
        inBatches(cwd, newRequired, (batch) => addPrompt(batch.map((b) => b.slug), note)),
      ]);
      drafts = written.flat();
    }

    const checked: Checked[] = drafts.map((draft) => ({ draft, check: checkPage(draft.markdown, cwd), attempts: 1 }));
    const failed = checked.filter((c) => !c.check.publishable).map((c) => ({ ...c, slug: c.draft.slug }));
    for (const draft of await inBatches(cwd, failed, (batch) => retryPrompt(batch, note), false)) {
      // A retry that failed leaves the first attempt's result standing.
      if (!draft.markdown) continue;
      const index = checked.findIndex((c) => c.draft.slug === draft.slug);
      checked[index] = { draft, check: checkPage(draft.markdown, cwd), attempts: 2 };
    }
    return { checked, carried, planned };
  });

  const generatedAt = new Date().toISOString();
  const costEach = checked.length ? costUsd / checked.length : 0;
  const kindOfPage = (slug: string) => (planned && plan.find((p) => p.slug === slug)?.kind) || kindOf(slug);
  const written = new Map<string, WikiPage>();
  for (const { draft, check } of checked) {
    if (!check.publishable) continue;
    written.set(draft.slug, {
      repo: name,
      slug: draft.slug,
      title: draft.title.trim(),
      kind: kindOfPage(draft.slug),
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
  // A plan sets the page list and its order. Without one, a full run sets it and an update keeps
  // it, adding any missing page that passed. Either way a failed page keeps its old version.
  const before = new Map(previous.map((page) => [page.slug, page]));
  const slugs = planned
    ? plan.map((p) => p.slug)
    : mode === "full"
      ? checked.map((c) => c.draft.slug)
      : [...new Set([...previous.map((p) => p.slug), ...written.keys()])];
  const pages = slugs.flatMap((slug) => {
    const page = written.get(slug) ?? carried.get(slug) ?? before.get(slug);
    return page ? [{ ...page, kind: kindOfPage(slug) }] : [];
  });
  store.replacePages(name, pages);
  if (replanned) store.replaceWikiPlan(name, plan, { commit: state.commit, note });
  else if (completed) store.replaceWikiPlan(name, plan, { commit: state.planCommit, note: state.planNote });
  else if (!map.large && plan.length) store.replaceWikiPlan(name, [], { commit: null, note: null });

  const wanted = planned ? plan.map((p) => p.slug) : [...requiredPages().keys()];
  const stillMissing = wanted.filter((slug) => !pages.some((p) => p.slug === slug));
  // Only a run that tried a missing page records whether it failed; a waiting page keeps waiting.
  const tried = mode === "full" || checked.some((c) => !before.has(c.draft.slug));
  if (tried) store.setPagesFailedAt(name, stillMissing.length ? state.commit : null);
  return {
    repo: name,
    commit: state.commit,
    mode,
    pages,
    reports,
    carried: [...carried.keys()],
    waiting: tried ? [] : stillMissing,
    plan: planReport,
    costUsd,
    durationMs: Date.now() - started,
  };
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
