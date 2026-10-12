import type { Seam } from "../../core/seams.js";
import type { SystemRecord } from "../../core/systems.js";
import type { SectionHit } from "../../store/store.js";
import type { Caller } from "../access.js";
import { visibleSystems } from "../systems.js";
import { count, groupRoutes, indexedAt, linkCalls, readableRepos, TIER, type Format, type ToolDeps, type ToolResult } from "./common.js";
import { impact, type ImpactInput } from "./impact.js";
import { matchExpression } from "./search.js";

export interface WorkImpactInput {
  /** A description of the work, e.g. "let users save articles to read later". */
  work: string;
  format: Format;
}

export interface LikelyRepo {
  repo: string;
  score: number;
  /** Matching wiki sections, best first. */
  sections: SectionHit[];
  /** Matching routes it serves, best first. */
  routes: Seam[];
  /** Other repos calling those routes, with how many of them each calls. */
  callers: { repo: string; routes: number }[];
}

export interface SystemGroup {
  /** Null for repos in no system. */
  system: SystemRecord | null;
  repos: LikelyRepo[];
}

export interface WorkImpact {
  work: string;
  groups: SystemGroup[];
  /** Repos that matched less well, best first: named so nothing is hidden. */
  weaker: string[];
}

/** Sections and routes looked at: enough to find every repo the work could touch. */
const SECTION_POOL = 100;
const ROUTE_POOL = 200;
/** A repo's score counts its best few sections, so a long wiki doesn't win on length alone. */
const SECTIONS_SCORED = 5;
/** Product pages describe what the work is about in the words a PO uses, so they count double. */
const PRODUCT_WEIGHT = 2;
/** Each matching route adds this much, up to ROUTES_SCORED routes: a tiebreaker beside sections. */
const ROUTE_WEIGHT = 0.5;
const ROUTES_SCORED = 10;
/**
 * Repos scoring under this share of the best are only named as weaker matches (down to WEAKER),
 * and at most MAX_REPOS are listed. Set on the B2a gate's five descriptions.
 */
const CUTOFF = 0.5;
const WEAKER = 0.1;
const MAX_REPOS = 8;
/**
 * Words almost every description of work uses ("let users…", "people should be able to…"). They
 * match every product page, so they'd rank repos on noise; they're left out unless nothing else is.
 */
const FILLER = new Set("able allow allows customer customers enable let lets need needs people person should someone user users want wants".split(" "));

function withoutFiller(work: string): string {
  const kept = work.split(/\s+/).filter((word) => !FILLER.has(word.toLowerCase().replace(/[^a-z]/g, "")));
  return kept.length ? kept.join(" ") : work;
}

/** Reasons shown per repo. */
const SHOWN = { concise: { sections: 3, routes: 3 }, detailed: { sections: 6, routes: 10 } };

/**
 * `brain_impact` and `brain impact`: a repo, file or endpoint goes to `impact`; a description of
 * work to `workImpact`. Exactly one of `repo` and `work` is needed.
 */
export async function impactRequest(deps: ToolDeps, caller: Caller, input: Omit<ImpactInput, "repo"> & { repo?: string; work?: string }): Promise<ToolResult<unknown>> {
  const work = input.work?.trim();
  if (work && (input.repo || input.path || input.route)) {
    return { ok: false, text: "Give either a description of work, or a repo (with an optional path or route), not both." };
  }
  if (work) return workImpact(deps, caller, { work, format: input.format });
  if (!input.repo) return { ok: false, text: 'Give a repo (with an optional path or route), or a description of work such as "let users save articles to read later".' };
  return impact(deps, caller, { ...input, repo: input.repo });
}

/**
 * Which systems, repos and endpoints a piece of work would most likely touch, from the wiki
 * sections (product pages weighted up) and routes that match its description, plus the repos
 * calling those routes. No AI runs: it is a search, so the calling agent does the reasoning and
 * the brain hands it the places to look.
 */
export async function workImpact(deps: ToolDeps, caller: Caller, input: WorkImpactInput): Promise<ToolResult<WorkImpact>> {
  const match = matchExpression(withoutFiller(input.work));
  if (!match) return { ok: false, text: `"${input.work}" has no words to search for.` };
  const readable = await readableRepos(deps, caller);
  if (readable.length === 0) return { ok: false, text: "No repos are enrolled yet. Add one with: brain add <path>" };

  const byRepo = new Map<string, LikelyRepo>();
  const entry = (repo: string) => byRepo.get(repo) ?? byRepo.set(repo, { repo, score: 0, sections: [], routes: [], callers: [] }).get(repo)!;
  for (const hit of deps.store.searchSections({ repos: readable, match, limit: SECTION_POOL, snippetWords: 16 }).hits) entry(hit.repo).sections.push(hit);
  const routes = deps.store.searchSeams({ repos: readable, match, limit: ROUTE_POOL }).hits.filter((s) => s.kind === "http-route");
  for (const group of groupRoutes(routes)) entry(group.primary.repo).routes.push(group.primary);

  // How many of the description's words each repo's wiki or routes contain. A repo matching one
  // common word in many sections ("code" in a developer tool) shouldn't outrank one matching
  // most of them, so a repo's score is scaled by the square of the share it covers.
  const terms = match.split(" OR ");
  const covered = new Map<string, number>();
  for (const term of terms) {
    const found = new Set([
      ...deps.store.searchSections({ repos: readable, match: term, limit: 1 }).repos,
      ...deps.store.searchSeams({ repos: readable, match: term, limit: 1 }).repos,
    ]);
    for (const repo of found) covered.set(repo, (covered.get(repo) ?? 0) + 1);
  }

  for (const likely of byRepo.values()) {
    const share = (covered.get(likely.repo) ?? 0) / terms.length;
    const weighted = likely.sections.map((s) => s.score * (s.slug === "product" ? PRODUCT_WEIGHT : 1)).sort((a, b) => b - a);
    likely.score = share * share * (weighted.slice(0, SECTIONS_SCORED).reduce((sum, n) => sum + n, 0) + ROUTE_WEIGHT * Math.min(likely.routes.length, ROUTES_SCORED));
    // Product sections first among the reasons, since they say what the repo does in these words.
    likely.sections.sort((a, b) => Number(b.slug === "product") - Number(a.slug === "product") || b.score - a.score);
  }
  const ranked = [...byRepo.values()].sort((a, b) => b.score - a.score || a.repo.localeCompare(b.repo));
  const best = ranked[0]?.score ?? 0;
  const likely = ranked.filter((r) => r.score >= best * CUTOFF).slice(0, MAX_REPOS);
  const weaker = ranked.filter((r) => !likely.includes(r) && r.score >= best * WEAKER).map((r) => r.repo);

  // Repos calling the matching routes change if those routes do.
  const calls = deps.store.seams({ repos: readable, kind: "http-call" });
  const allRoutes = deps.store.seams({ repos: readable, kind: "http-route" });
  for (const repo of likely) {
    const perCaller = new Map<string, Set<Seam>>();
    for (const link of linkCalls(calls, repo.routes, allRoutes)) {
      if (link.call.repo === repo.repo) continue;
      perCaller.set(link.call.repo, (perCaller.get(link.call.repo) ?? new Set()).add(link.route));
    }
    repo.callers = [...perCaller].map(([name, set]) => ({ repo: name, routes: set.size })).sort((a, b) => b.routes - a.routes || a.repo.localeCompare(b.repo));
  }

  const data: WorkImpact = { work: input.work, groups: groupBySystem(likely, visibleSystems(deps.store, readable)), weaker };
  return { ok: true, data, text: await render(deps, data, readable, input.format) };
}

/** Repos grouped by the system they belong to, systems ordered by their best repo; repos in none last. */
function groupBySystem(likely: readonly LikelyRepo[], systems: readonly SystemRecord[]): SystemGroup[] {
  const groups = new Map<SystemRecord | null, LikelyRepo[]>();
  for (const repo of likely) {
    const system = systems.find((s) => s.repos.includes(repo.repo)) ?? null;
    groups.set(system, [...(groups.get(system) ?? []), repo]);
  }
  return [...groups]
    .map(([system, repos]) => ({ system, repos }))
    .sort((a, b) => Number(a.system === null) - Number(b.system === null) || b.repos[0]!.score - a.repos[0]!.score);
}

async function render(deps: ToolDeps, { work, groups, weaker }: WorkImpact, readable: string[], format: Format): Promise<string> {
  const noWiki = readable.filter((name) => deps.store.pages(name).length === 0);
  const noWikiNote = noWiki.length ? `No wiki yet, so only their routes were searched: ${noWiki.join(", ")} (brain sync <repo> writes one).` : "";
  if (groups.length === 0) {
    return [`Nothing in the wikis or route map of ${count(readable.length, "repo")} matches "${work}". Try the words the product uses.`, noWikiNote].filter(Boolean).join("\n");
  }

  const shown = SHOWN[format];
  const repos = groups.flatMap((g) => g.repos);
  const width = Math.max(...repos.map((r) => r.repo.length)) + 2;
  const out = [`"${work}" would most likely touch:`];
  for (const { system, repos: members } of groups) {
    out.push("", system ? `${system.name}${system.status === "suggested" ? " (suggested system)" : ""}` : "Not in a system");
    for (const repo of members) {
      const sections = repo.sections.slice(0, shown.sections).map((s) => `${s.slug} › ${s.heading || s.pageTitle}`);
      const routes = repo.routes.slice(0, shown.routes).map((r) => `${r.method} ${r.rawPath}`);
      const more = repo.routes.length > routes.length ? ` +${repo.routes.length - routes.length} more` : "";
      const reasons = [...sections, ...(routes.length ? [`routes: ${routes.join(", ")}${more}`] : [])];
      out.push(`  ${repo.repo.padEnd(width)}${reasons.join("; ")}`);
      if (format === "detailed") for (const s of repo.sections.slice(0, shown.sections)) out.push(`  ${" ".repeat(width)}  ${s.slug} › ${s.heading || s.pageTitle}: ${s.snippet}`);
      for (const c of repo.callers) {
        out.push(`  ${" ".repeat(width)}+ ${c.repo} calls ${c.routes === 1 ? "one of these routes" : `${c.routes} of these routes`}, so it may need updating if the API changes`);
      }
    }
  }
  if (weaker.length) out.push("", `Weaker matches: ${weaker.join(", ")}`);
  out.push(
    "",
    "Suggested from the wiki and route map; confirm with the owning team.",
    'Read a section with brain_get (repo and page, e.g. page "product"); see every caller of an endpoint with brain_find_consumers.',
  );
  if (noWikiNote) out.push(noWikiNote);
  out.push(`Indexed: ${(await indexedAt(deps, [...new Set(repos.map((r) => r.repo))].sort())).join("; ")}`);
  out.push(`${TIER}: wiki sections and routes written by Claude Code from the code, each checked against the lines it cites.`);
  return out.join("\n");
}
