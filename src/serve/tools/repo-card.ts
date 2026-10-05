import { CODE_LANGUAGES } from "../../core/languages.js";
import type { SeamCoverage } from "../../core/seams.js";
import type { Freshness, LanguageShare, Tier } from "../../core/types.js";
import { SEAM_LANGUAGES } from "../../ingest/extractors/index.js";
import type { Caller } from "../access.js";
import { describeFreshness, freshnessOf } from "../freshness.js";
import { neighbours, type Neighbour, type Neighbours } from "../neighbours.js";
import { repoFacts, runCommand, type DotnetBuild, type Owners, type PackageScripts, type RepoFacts } from "../repo-facts.js";
import { count, requireSyncedRepo, type Format, type ToolDeps, type ToolResult } from "./common.js";

export interface RepoCard extends RepoFacts {
  repo: string;
  path: string;
  remote: string | null;
  ref: string;
  tier: Tier;
  freshness: Freshness;
  files: number;
  languages: LanguageShare[];
  seams: SeamCoverage;
  /** Code languages present in the repo that no extractor reads yet. */
  unsupportedLanguages: string[];
  neighbours: Neighbours;
}

const CONCISE_LANGUAGES = 5;
const CONCISE_PACKAGES = 3;

/**
 * What a repo is and what's around it, from facts the brain holds: how to build and test it, who
 * owns it, what it says it is, and which repos it talks to. Backs `brain_repo_card` and `brain card`.
 */
export async function repoCard(deps: ToolDeps, caller: Caller, name: string, format: Format): Promise<ToolResult<RepoCard>> {
  const found = await requireSyncedRepo(deps, caller, name);
  if (!found.ok) return found;
  const { repo, state, readable } = found;

  const languages = deps.store.languageShares(name);
  const card: RepoCard = {
    repo: repo.name,
    path: repo.path,
    remote: repo.remote,
    ref: repo.ref,
    tier: "parser-built",
    freshness: await freshnessOf(repo, state),
    files: state.fileCount,
    languages,
    seams: deps.store.seamCoverage(name),
    unsupportedLanguages: languages
      .map((l) => l.language)
      .filter((language) => CODE_LANGUAGES.has(language) && !SEAM_LANGUAGES.has(language)),
    ...repoFacts(deps.store.facts(name)),
    neighbours: neighbours(deps.store, name, readable),
  };
  return { ok: true, data: card, text: format === "detailed" ? detailedText(card) : conciseText(card) };
}

function conciseText(card: RepoCard): string {
  const shown = card.languages.slice(0, CONCISE_LANGUAGES).map((l) => `${l.language} ${l.files}`);
  const more = card.languages.length - shown.length;
  return [
    `${card.repo}  ${describeFreshness(card.freshness, card.ref)} · ${card.tier}`,
    `Remote: ${card.remote ?? "none"}`,
    ...(card.summary ? [`About: ${card.summary.value}`] : []),
    `Files: ${card.files} on ${card.ref}`,
    `Languages: ${shown.join(" · ")}${more > 0 ? ` (+${more} more)` : ""}`,
    ...buildLines(card, "concise"),
    ownersLine(card.owners),
    seamsLine(card),
    ...neighbourLines(card.neighbours),
    ...notes(card),
  ].join("\n");
}

function detailedText(card: RepoCard): string {
  const rows = card.languages.map((l) => `  ${l.language.padEnd(18)} ${String(l.files).padStart(6)} files ${formatBytes(l.bytes).padStart(10)}`);
  return [
    `${card.repo}  ${describeFreshness(card.freshness, card.ref)} · ${card.tier}`,
    `Path: ${card.path}`,
    `Remote: ${card.remote ?? "none"}`,
    `Tracked ref: ${card.ref}`,
    `Indexed commit: ${card.freshness.commit}`,
    `Synced at: ${card.freshness.syncedAt}`,
    ...(card.summary ? [`About (${cite(card.summary.path, card.summary.line)}): ${card.summary.value}`] : []),
    `Files: ${card.files}`,
    "Languages:",
    ...rows,
    ...buildLines(card, "detailed"),
    ownersLine(card.owners),
    seamsLine(card),
    ...neighbourLines(card.neighbours),
    ...notes(card),
  ].join("\n");
}

function buildLines(card: RepoCard, format: Format): string[] {
  const lines: string[] = [];
  if (card.dotnet) lines.push(`.NET: ${dotnetText(card.dotnet)}`);
  const withScripts = card.packages.filter((p) => p.common.length + p.others.length > 0);
  if (format === "detailed") {
    for (const pkg of withScripts) {
      lines.push(`Scripts in ${pkg.path} (${pkg.manager}):`);
      for (const script of [...pkg.common, ...pkg.others]) {
        lines.push(`  ${runCommand(pkg, script).padEnd(28)} ${script.command}  (line ${script.line ?? "?"})`);
      }
    }
    return lines;
  }
  // Packages with the usual scripts first; others still show a few so the card isn't just a count.
  const shown = [...withScripts].sort((a, b) => Number(!a.common.length) - Number(!b.common.length)).slice(0, CONCISE_PACKAGES);
  shown.forEach((pkg, i) => lines.push(`${i === 0 ? "Scripts: " : "         "}${scriptsText(pkg)}`));
  const hidden = withScripts.length - shown.length;
  if (hidden > 0) lines.push(`${shown.length ? "         " : "Scripts: "}+${count(hidden, "more package.json")} (--detailed lists them)`);
  return lines;
}

function scriptsText(pkg: PackageScripts): string {
  const where = pkg.folder ? `in ${pkg.folder}/: ` : "";
  const shown = pkg.common.length ? pkg.common : pkg.others.slice(0, CONCISE_PACKAGES);
  const hidden = pkg.common.length + pkg.others.length - shown.length;
  return `${where}${shown.map((s) => runCommand(pkg, s)).join(" · ")}${hidden ? ` (+${hidden} more)` : ""}`;
}

function dotnetText({ solution, projects }: DotnetBuild): string {
  const total = projects.web + projects.app + projects.library + projects.test;
  const kinds = (["web", "app", "library", "test"] as const).filter((k) => projects[k] > 0).map((k) => `${projects[k]} ${k}`);
  const summary = `${count(total, "project")}${kinds.length ? ` (${kinds.join(", ")})` : ""}`;
  if (!solution) return `${summary}, no solution file`;
  const test = projects.test > 0 ? ` · dotnet test ${solution}` : "";
  return `dotnet build ${solution}${test} · ${summary}`;
}

function ownersLine(owners: Owners | null): string {
  if (!owners) return "Owners: not declared (no CODEOWNERS)";
  const rules = owners.pathRules ? `, +${count(owners.pathRules, "path rule")}` : "";
  const fallback = owners.fallback;
  if (!fallback) return `Owners: no default owner in ${owners.path}${rules}`;
  const who = fallback.value.length ? fallback.value.join(" ") : "none (explicitly unowned)";
  return `Owners: ${who} (${cite(fallback.path, fallback.line)})${rules}`;
}

function seamsLine(card: RepoCard): string {
  const { routes, calls, unresolvedCalls, plugins } = card.seams;
  const found =
    routes + calls + unresolvedCalls === 0
      ? "none found"
      : `${count(routes, "route")}, ${count(calls, "call")}${unresolvedCalls ? ` (+${unresolvedCalls} with run-time URLs)` : ""} via ${plugins.join(", ")}`;
  const gaps = card.unsupportedLanguages.length ? ` · not extracted: ${card.unsupportedLanguages.join(", ")}` : "";
  return `Seams: ${found}${gaps}`;
}

function neighbourLines({ calls, calledBy }: Neighbours): string[] {
  if (calls.length + calledBy.length === 0) return ["Neighbours: none found among enrolled repos"];
  const list = (items: Neighbour[], noun: string) =>
    items.map((n) => `${n.repo} (${count(n.count, noun)}${n.suffix ? ", suffix" : ""})`).join(" · ");
  return [
    ...(calls.length ? [`Calls: ${list(calls, "endpoint")}`] : []),
    ...(calledBy.length ? [`Called by: ${list(calledBy, "call")}`] : []),
  ];
}

function notes(card: RepoCard): string[] {
  const lines: string[] = [];
  const { calls, calledBy } = card.neighbours;
  if ([...calls, ...calledBy].some((n) => n.suffix)) lines.push("suffix = matched ignoring a base path such as /api.");
  if (calls.length + calledBy.length > 0) lines.push("brain_impact and brain_find_consumers give the endpoints and file:line pointers.");
  if (card.dotnet || card.packages.length) lines.push("Commands are as the repo declares them; the brain never runs them.");
  return lines.length ? ["", ...lines] : [];
}

function cite(path: string, line: number | null): string {
  return line === null ? path : `${path}:${line}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
