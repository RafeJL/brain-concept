import type { NamedFamily } from "../../core/links.js";
import { FAMILIES, type SeamCoverage } from "../../core/seams.js";
import type { Enrolment, Freshness, LanguageShare, PageKind } from "../../core/types.js";
import { liveStatus } from "../../ingest/enrol.js";
import type { Caller } from "../access.js";
import { enrolmentCard, enrolmentLines, readableEnrolment, readyLine, unfinished } from "../enrolment.js";
import { describeFreshness, freshnessOf } from "../freshness.js";
import { factCountText, factsAbout } from "../facts.js";
import { linkSummary, neighbours, type Neighbour, type Neighbours } from "../neighbours.js";
import { findSystem, systemOf } from "../systems.js";
import { firstSentence } from "../../core/sections.js";
import type { SystemStatus } from "../../core/systems.js";
import { count, readableRepos, requireSyncedRepo, TIER, wikiCommit, type Format, type ToolDeps, type ToolResult } from "./common.js";
import { systemOverview } from "./system-overview.js";

export interface RepoCard {
  repo: string;
  path: string;
  remote: string | null;
  ref: string;
  freshness: Freshness;
  files: number;
  languages: LanguageShare[];
  /** The routes and calls Claude Code found, and the commit they describe (null: not mapped yet). */
  seams: SeamCoverage & { commit: string | null };
  neighbours: Neighbours;
  /** The AI-written wiki, if one has been generated. */
  wiki: { pages: string[]; kinds: PageKind[]; commit: string } | null;
  /** The product page's opening sentence: what the repo is for. Null without a product page. */
  product: string | null;
  /** The system the repo belongs to, with its other readable members. */
  system: { name: string; status: SystemStatus; others: string[] } | null;
  /** What people have stated about the repo and its system, counted ("2 confirmed by people"); null when nothing. */
  facts: string | null;
  /** How it was enrolled, when by `brain add` or `brain_add_repo`: still going, failed, or done. */
  enrolment: Enrolment | null;
}

const CONCISE_LANGUAGES = 5;

/**
 * What a repo is and what's around it: freshness, languages, the repos it talks to, and where
 * its wiki is (which says what it is and how to build and test it). Backs `brain_repo_card` and
 * `brain card`.
 */
/**
 * `brain_repo_card` and `brain card`: a repo's card, or, when the name is a system's rather than a
 * repo's ("RealWorld"), that system's overview. Agents are told to call the card with any name
 * they're asked about, and people name products as often as repos.
 */
export async function cardRequest(deps: ToolDeps, caller: Caller, name: string, format: Format): Promise<ToolResult<unknown>> {
  const readable = await readableRepos(deps, caller);
  if (!readable.includes(name) && findSystem(deps.store, name, readable)) {
    const overview = await systemOverview(deps, caller, name);
    if (overview.ok) {
      const note = `"${name}" is a system (a product made of several repos), not one repo. Its overview:`;
      return { ...overview, text: `${note}\n\n${overview.text}\n\nRead a repo's card with brain_repo_card, or its product page with brain_get (page "product").` };
    }
  }
  // Not indexed yet: being cloned or indexed, or failed before it was. Its progress is the card,
  // which is how a person finds out whether it's ready.
  const enrolment = await readableEnrolment(deps, caller, name);
  if (unfinished(enrolment) && !deps.store.getState(name)) return { ok: true, data: enrolment, text: enrolmentCard(enrolment) };
  return repoCard(deps, caller, name, format);
}

export async function repoCard(deps: ToolDeps, caller: Caller, name: string, format: Format): Promise<ToolResult<RepoCard>> {
  const found = await requireSyncedRepo(deps, caller, name);
  if (!found.ok) return found;
  const { repo, state, readable } = found;

  const languages = deps.store.languageShares(name);
  const card: RepoCard = {
    enrolment: (await readableEnrolment(deps, caller, name)) ?? null,
    repo: repo.name,
    path: repo.path,
    remote: repo.remote,
    ref: repo.ref,
    freshness: await freshnessOf(repo, state),
    files: state.fileCount,
    languages,
    seams: { ...deps.store.seamCoverage(name), commit: state.seamsCommit },
    neighbours: neighbours(deps.store, name, readable),
    wiki: wikiOf(deps, name, state.commit),
    ...productAndSystem(deps, name, readable),
  };
  return { ok: true, data: card, text: format === "detailed" ? detailedText(card) : conciseText(card) };
}

function conciseText(card: RepoCard): string {
  const shown = card.languages.slice(0, CONCISE_LANGUAGES).map((l) => `${l.language} ${l.files}`);
  const more = card.languages.length - shown.length;
  return [
    `${card.repo}  ${describeFreshness(card.freshness, card.ref)}`,
    ...enrolmentStatus(card, false),
    ...productLines(card),
    `Remote: ${card.remote ?? "none"}`,
    wikiLine(card),
    `Files: ${card.files} on ${card.ref}`,
    `Languages: ${shown.join(" · ")}${more > 0 ? ` (+${more} more)` : ""}`,
    seamsLine(card),
    ...neighbourLines(card.neighbours),
    ...notes(card),
  ].join("\n");
}

function detailedText(card: RepoCard): string {
  const rows = card.languages.map((l) => `  ${l.language.padEnd(18)} ${String(l.files).padStart(6)} files ${formatBytes(l.bytes).padStart(10)}`);
  return [
    `${card.repo}  ${describeFreshness(card.freshness, card.ref)}`,
    ...enrolmentStatus(card, true),
    ...productLines(card),
    `Path: ${card.path}`,
    `Remote: ${card.remote ?? "none"}`,
    `Tracked ref: ${card.ref}`,
    `Indexed commit: ${card.freshness.commit}`,
    `Synced at: ${card.freshness.syncedAt}`,
    wikiLine(card),
    `Files: ${card.files}`,
    "Languages:",
    ...rows,
    seamsLine(card),
    ...neighbourLines(card.neighbours),
    ...notes(card),
  ].join("\n");
}

function productAndSystem(deps: ToolDeps, name: string, readable: readonly string[]): Pick<RepoCard, "product" | "system" | "facts"> {
  const page = deps.store.pages(name).find((p) => p.slug === "product");
  const system = systemOf(deps.store, name, readable);
  return {
    product: page ? firstSentence(page.markdown) : null,
    system: system ? { name: system.name, status: system.status, others: system.repos.filter((repo) => repo !== name) } : null,
    facts: factCountText(factsAbout(deps.store, name, readable)),
  };
}

/** What the repo is for and which product it is part of, for a PO's first question. */
function productLines({ product, system, facts }: RepoCard): string[] {
  const lines = product ? [`Product: ${product} · read with brain_get (page "product")`] : [];
  if (system) {
    const shown = system.others.slice(0, 5).join(", ") + (system.others.length > 5 ? ", …" : "");
    const label = system.status === "suggested" ? "suggested, not yet confirmed" : "";
    const detail = [label, shown && `with ${shown}`].filter(Boolean).join("; ");
    lines.push(`System: ${system.name}${detail ? ` (${detail})` : ""} · overview with brain_get (system "${system.name}")`);
  }
  if (facts) lines.push(`Facts from people: ${facts} · at the top of its product page (brain_get page "product")`);
  return lines;
}

/**
 * Where its enrolment has got to while its wiki and links are written, or what failed; once done,
 * a line saying it's ready (on the concise card for a day, on the detailed one always).
 */
function enrolmentStatus({ enrolment }: RepoCard, detailed: boolean): string[] {
  if (!enrolment) return [];
  if (unfinished(enrolment)) return enrolmentLines(enrolment);
  const ready = readyLine(enrolment, Date.now(), detailed ? Infinity : undefined);
  return ready ? [ready] : [];
}

/** Being written by an enrolment that is still running, rather than waiting for a sync. */
function enrolling({ enrolment }: RepoCard): boolean {
  return enrolment !== null && liveStatus(enrolment) === "running";
}

/** Past this many pages, the card counts them by kind instead of naming them. */
const LISTED_PAGES = 8;

function wikiOf(deps: ToolDeps, name: string, indexed: string): RepoCard["wiki"] {
  const pages = deps.store.pages(name);
  return pages.length ? { pages: pages.map((p) => p.slug), kinds: pages.map((p) => p.kind), commit: wikiCommit(pages, indexed) } : null;
}

function wikiLine(card: RepoCard): string {
  const { repo, wiki, freshness } = card;
  if (!wiki && enrolling(card)) return "Wiki: being written";
  if (!wiki) return `Wiki: not written yet (brain sync ${repo} writes it; a sync already running will)`;
  const older = wiki.commit === freshness.commit ? "" : ` · written at @${wiki.commit.slice(0, 7)}, older than the index`;
  if (wiki.pages.length <= LISTED_PAGES) return `Wiki: ${count(wiki.pages.length, "page")} (${wiki.pages.join(", ")}) · read with brain_get${older}`;
  // A large wiki by kind: "4 core, 8 areas, 3 flows, data model, integrations".
  const kinds = (["core", "area", "flow", "data-model", "integrations"] as const).flatMap((kind) => {
    const n = wiki.kinds.filter((k) => k === kind).length;
    if (n === 0) return [];
    if (kind === "data-model" || kind === "integrations") return [kind === "data-model" ? "data model" : "integrations"];
    return [kind === "core" ? `${n} core` : count(n, kind)];
  });
  return `Wiki: ${count(wiki.pages.length, "page")}: ${kinds.join(", ")} · brain_get lists them; start with overview${older}`;
}

function seamsLine(card: RepoCard): string {
  const { repo, seams, freshness } = card;
  if (!seams.commit && enrolling(card)) return "Seams: being mapped";
  if (!seams.commit) return `Seams: not mapped yet (brain sync ${repo})`;
  const { routes, calls, unresolvedCalls, links } = seams;
  const found =
    routes + calls + unresolvedCalls + links.length === 0
      ? "none found"
      : [
          ...(routes + calls + unresolvedCalls || !links.length
            ? [`${count(routes, "route")}, ${count(calls, "call")}${unresolvedCalls ? ` (+${unresolvedCalls} with run-time URLs)` : ""}`]
            : []),
          ...linkCounts(links),
        ].join("; ");
  const older = seams.commit === freshness.commit ? "" : ` · mapped at @${seams.commit.slice(0, 7)}, older than the index`;
  return `Seams: ${found} · ${TIER}${older}`;
}

const LINK_WORDS: Record<NamedFamily, { label: string; provides: string; uses: string }> = {
  event: { label: "events", provides: "published", uses: "handled" },
  grpc: { label: "gRPC", provides: "served", uses: "called" },
  package: { label: "packages", provides: "published", uses: "used" },
};

/** "events: 3 published, 5 handled (+1 run-time)", one per family found. */
function linkCounts(links: SeamCoverage["links"]): string[] {
  return (Object.keys(LINK_WORDS) as NamedFamily[]).flatMap((family) => {
    const sides = (["provides", "uses"] as const).flatMap((side) => {
      const found = links.find((l) => l.kind === FAMILIES[family][side]);
      if (!found) return [];
      return [`${found.count - found.runtime} ${LINK_WORDS[family][side]}${found.runtime ? ` (+${found.runtime} run-time)` : ""}`];
    });
    return sides.length ? [`${LINK_WORDS[family].label}: ${sides.join(", ")}`] : [];
  });
}

function neighbourLines({ calls, calledBy }: Neighbours): string[] {
  if (calls.length + calledBy.length === 0) return ["Neighbours: none found among enrolled repos"];
  const list = (items: Neighbour[], side: "calls" | "calledBy") =>
    items
      .map((n) => `${n.repo} (${linkSummary(n, side)}${n.suffix ? ", suffix" : ""})`)
      .join(" · ");
  return [
    ...(calls.length ? [`Calls: ${list(calls, "calls")}`] : []),
    ...(calledBy.length ? [`Called by: ${list(calledBy, "calledBy")}`] : []),
  ];
}

function notes(card: RepoCard): string[] {
  const lines: string[] = [];
  const { calls, calledBy } = card.neighbours;
  if ([...calls, ...calledBy].some((n) => n.suffix)) lines.push("suffix = matched ignoring a base path such as /api.");
  if (calls.length + calledBy.length > 0) lines.push("brain_impact and brain_find_consumers give the endpoints, events and packages, with file:line pointers.");
  return lines.length ? ["", ...lines] : [];
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
