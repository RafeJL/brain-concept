import { existsSync, statSync } from "node:fs";
import { join, posix } from "node:path";
import { cleanPath } from "../core/citations.js";
import type { ChangedFile } from "../core/git.js";
import { detectLanguage } from "../core/languages.js";
import { PAGE_KINDS, type PageKind, type PlannedPage, type WikiPage } from "../core/types.js";
import { isProjectManifest, isSource } from "./inventory.js";
import { prompt } from "./prompts.js";
import type { Runner } from "./runner.js";

/** The most pages a repo's wiki may have (DeepWiki's is 30; eShop needs about 20). */
export const MAX_PAGES = 20;
const MAX_FLOWS = 3;
const MAX_KEY_FILES = 6;
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
/** The pages every wiki has, whatever its size. */
export const CORE_PAGES = ["overview", "build-run-test", "conventions", "api", "product"];

const SCHEMA = {
  type: "object",
  properties: {
    pages: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        properties: {
          slug: { type: "string", pattern: SLUG.source },
          title: { type: "string" },
          kind: { type: "string", enum: PAGE_KINDS },
          brief: { type: "string" },
          covers: { type: "array", items: { type: "string" } },
          key_files: { type: "array", items: { type: "string" } },
        },
        required: ["slug", "title", "kind", "brief", "covers", "key_files"],
      },
    },
  },
  required: ["pages"],
};

export interface PlanResult {
  /** Null when no plan passed the check, twice. */
  plan: PlannedPage[] | null;
  problems: string[];
  costUsd: number;
  durationMs: number;
}

/**
 * Has Claude Code plan a large repo's wiki from the inventory: the core pages, a page per area,
 * a few flow pages, and data-model and integrations pages where they apply. With `current`, the
 * plan is kept and only changed where the code has. Checked without AI (folders and files exist,
 * slugs unique, core pages present, within the caps); a plan that fails is asked for once more
 * with the reasons.
 */
export async function planPages(
  runner: Runner,
  cwd: string,
  input: { inventory: string; note: string | null; current: readonly PlannedPage[]; model: string },
): Promise<PlanResult> {
  const current = input.current.length
    ? `The wiki already has the pages below. Keep them, with the same slugs, unless the part they cover is gone; add pages only for parts that none of them covers.\n${input.current.map(planLine).join("\n")}`
    : "";
  const note = input.note ? prompt("steering-note", { note: input.note }) : "";
  let ask = prompt("plan-pages", { inventory: input.inventory, current, note });
  let costUsd = 0;
  let durationMs = 0;
  let problems: string[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const run = await runner.run<{ pages?: unknown }>({ cwd, prompt: ask, schema: SCHEMA, model: input.model });
    costUsd += run.costUsd;
    durationMs += run.durationMs;
    const checked = checkPlan(run.output?.pages, cwd);
    if (checked.plan) return { plan: checked.plan, problems: [], costUsd, durationMs };
    problems = checked.problems;
    ask = `${ask}\n\nA plan you returned failed the automatic check, for these reasons. Return a corrected plan:\n${problems.map((p) => `- ${p}`).join("\n")}`;
  }
  return { plan: null, problems, costUsd, durationMs };
}

/** The plan as checked, or the reasons it can't be used. */
export function checkPlan(pages: unknown, root: string): { plan: PlannedPage[] | null; problems: string[] } {
  if (!Array.isArray(pages)) return { plan: null, problems: ["no pages"] };
  const problems: string[] = [];
  const plan: PlannedPage[] = [];
  for (const page of pages as Record<string, unknown>[]) {
    const slug = String(page?.slug ?? "");
    if (!SLUG.test(slug)) problems.push(`"${slug}" isn't a kebab-case slug`);
    if (plan.some((p) => p.slug === slug)) problems.push(`"${slug}" is planned twice`);
    const kind = PAGE_KINDS.includes(page?.kind as PageKind) ? (page.kind as PageKind) : null;
    if (!kind) problems.push(`"${slug}" has an unknown kind`);
    const paths = (key: string) => (Array.isArray(page?.[key]) ? (page[key] as unknown[]).map((p) => cleanPath(String(p)).replace(/\/$/, "")) : []);
    const covers = paths("covers").filter((p) => p !== "" && p !== ".");
    const keyFiles = paths("key_files").slice(0, MAX_KEY_FILES);
    for (const folder of covers) if (!isDir(root, folder)) problems.push(`"${slug}" covers ${folder}, which isn't a folder`);
    for (const file of keyFiles) if (!isFile(root, file)) problems.push(`"${slug}" starts from ${file}, which isn't a file`);
    plan.push({ slug, title: String(page?.title ?? "").trim() || slug, kind: kind ?? "area", brief: String(page?.brief ?? "").trim(), covers, keyFiles });
  }
  for (const slug of CORE_PAGES) {
    const page = plan.find((p) => p.slug === slug);
    if (!page) problems.push(`the core page "${slug}" is missing`);
    else page.kind = "core";
  }
  for (const page of plan) if (page.kind === "core" && !CORE_PAGES.includes(page.slug)) problems.push(`"${page.slug}" isn't a core page`);
  if (plan.length > MAX_PAGES) problems.push(`${plan.length} pages planned; at most ${MAX_PAGES}`);
  const flows = plan.filter((p) => p.kind === "flow").length;
  if (flows > MAX_FLOWS) problems.push(`${flows} flow pages; at most ${MAX_FLOWS}`);
  return problems.length ? { plan: null, problems } : { plan, problems: [] };
}

/** What a core page missing from a stored plan is planned as. */
const CORE_PLANNED: Record<string, { title: string; brief: string }> = {
  overview: { title: "Overview", brief: "what it is, its main parts and how they connect" },
  "build-run-test": { title: "Build, run and test", brief: "how to install, build, run and test it, and where each part's tests live" },
  conventions: { title: "Conventions", brief: "how code here is written: logging, errors and messages, validation, configuration" },
  api: { title: "API", brief: "the APIs it serves, grouped by area" },
  product: { title: "Product", brief: "what it does for the people who use it, in product language" },
};

/**
 * A stored plan with any core page it lacks added, each after the core page before it. A plan made
 * before a core page existed gains it this way, without planning again.
 */
export function withCorePages(plan: readonly PlannedPage[]): PlannedPage[] {
  const whole = [...plan];
  CORE_PAGES.forEach((slug, i) => {
    if (whole.some((p) => p.slug === slug)) return;
    const after = whole.findLastIndex((p) => CORE_PAGES.slice(0, i).includes(p.slug));
    whole.splice(after + 1, 0, { slug, ...CORE_PLANNED[slug]!, kind: "core", covers: [], keyFiles: [] });
  });
  return whole;
}

/** A wiki written before plans existed, as a plan to keep: each page, what it is and nothing more. */
export function planOfPages(pages: readonly WikiPage[]): PlannedPage[] {
  return pages.map((p) => ({ slug: p.slug, title: p.title, kind: p.kind, brief: "", covers: [], keyFiles: [] }));
}

/** One line of a plan, as runs are shown it. */
export function planLine(page: PlannedPage): string {
  return `- ${page.slug} (${page.kind}): ${page.title}${page.brief ? `: ${page.brief}` : ""}`;
}

function isDir(root: string, path: string): boolean {
  const full = join(root, path);
  return existsSync(full) && statSync(full).isDirectory();
}

function isFile(root: string, path: string): boolean {
  const full = join(root, path);
  return existsSync(full) && statSync(full).isFile();
}

/** New source files outside every page that make a new area worth planning for. */
const NEW_AREA_FILES = 10;

/**
 * Why a large repo's wiki should be planned again, or null. Only when there is no plan, the
 * steering note changed, or code arrived that no page covers: a new project, or enough new
 * source files outside every page's folders. A stray script or test doesn't count.
 */
export function replanReason(plan: readonly PlannedPage[], added: readonly ChangedFile[] | null, noteChanged: boolean): string | null {
  if (plan.length === 0) return "no plan yet";
  if (noteChanged) return "the steering note changed";
  if (added === null) return "the history since the plan can't be compared";
  const covered = (path: string) => plan.some((p) => p.covers.some((folder) => path.startsWith(`${folder}/`)));
  const fresh = added.filter((c) => c.status === "A" && !covered(c.path));
  const project = fresh.find((c) => isProjectManifest(c.path));
  if (project) return `a new project at ${posix.dirname(project.path) || "the root"}`;
  const source = fresh.filter((c) => isSource({ path: c.path, language: detectLanguage(c.path) })).length;
  return source >= NEW_AREA_FILES ? `${source} new source files outside every page` : null;
}
