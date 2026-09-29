import { CODE_LANGUAGES } from "../../core/languages.js";
import type { SeamCoverage } from "../../core/seams.js";
import type { Freshness, LanguageShare, Tier } from "../../core/types.js";
import { SEAM_LANGUAGES } from "../../ingest/extractors/index.js";
import type { Caller } from "../access.js";
import { describeFreshness, freshnessOf } from "../freshness.js";
import { count, requireSyncedRepo, type Format, type ToolDeps, type ToolResult } from "./common.js";

export interface RepoCard {
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
}

const CONCISE_LANGUAGES = 5;

/** What a repo is, from facts the brain holds about it. Backs `brain_repo_card` and `brain card`. */
export async function repoCard(deps: ToolDeps, caller: Caller, name: string, format: Format): Promise<ToolResult<RepoCard>> {
  const found = await requireSyncedRepo(deps, caller, name);
  if (!found.ok) return found;
  const { repo, state } = found;

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
  };
  return { ok: true, data: card, text: format === "detailed" ? detailedText(card) : conciseText(card) };
}

function conciseText(card: RepoCard): string {
  const shown = card.languages.slice(0, CONCISE_LANGUAGES).map((l) => `${l.language} ${l.files}`);
  const more = card.languages.length - shown.length;
  return [
    `${card.repo}  ${describeFreshness(card.freshness, card.ref)} · ${card.tier}`,
    `Remote: ${card.remote ?? "none"}`,
    `Files: ${card.files} on ${card.ref}`,
    `Languages: ${shown.join(" · ")}${more > 0 ? ` (+${more} more)` : ""}`,
    seamsLine(card),
    "Owner, purpose: not set",
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
    `Files: ${card.files}`,
    "Languages:",
    ...rows,
    seamsLine(card),
    "Owner, purpose: not set",
  ].join("\n");
}

function seamsLine(card: RepoCard): string {
  const { routes, calls, unresolvedCalls, plugins } = card.seams;
  const found =
    routes + calls + unresolvedCalls === 0
      ? "none found"
      : `${count(routes, "route")}, ${count(calls, "call")}${unresolvedCalls ?` (+${unresolvedCalls} with run-time URLs)` : ""} via ${plugins.join(", ")}`;
  const gaps = card.unsupportedLanguages.length ? ` · not extracted: ${card.unsupportedLanguages.join(", ")}` : "";
  return `Seams: ${found}${gaps}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
