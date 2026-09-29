import type { Freshness, LanguageShare, Tier } from "../../core/types.js";
import type { Store } from "../../store/store.js";
import type { AccessPolicy, Caller } from "../access.js";
import { describeFreshness, freshnessOf } from "../freshness.js";

export type Format = "concise" | "detailed";

export interface ToolDeps {
  store: Store;
  access: AccessPolicy;
}

export interface RepoCard {
  repo: string;
  path: string;
  remote: string | null;
  ref: string;
  tier: Tier;
  freshness: Freshness;
  files: number;
  languages: LanguageShare[];
}

export type ToolResult<T> = { ok: true; data: T; text: string } | { ok: false; text: string };

const CONCISE_LANGUAGES = 5;

/** What a repo is, from facts the brain holds about it. Backs `brain_repo_card` and `brain card`. */
export async function repoCard(deps: ToolDeps, caller: Caller, name: string, format: Format): Promise<ToolResult<RepoCard>> {
  const enrolled = deps.store.listRepos().map((repo) => repo.name);
  const readable = await deps.access.readableRepos(caller, enrolled);
  const repo = readable.has(name) ? deps.store.getRepo(name) : undefined;
  if (!repo) {
    // Same answer for "doesn't exist" and "not allowed", so existence never leaks.
    const names = [...readable].sort();
    const list = names.length ? `Repos you can read: ${names.join(", ")}.` : "No repos are enrolled yet.";
    return { ok: false, text: `No readable repo named "${name}". ${list}` };
  }

  const state = deps.store.getState(name);
  if (!state) {
    return { ok: false, text: `"${name}" is enrolled but has not been synced yet. Run: brain sync ${name}` };
  }

  const card: RepoCard = {
    repo: repo.name,
    path: repo.path,
    remote: repo.remote,
    ref: repo.ref,
    tier: "parser-built",
    freshness: await freshnessOf(repo, state),
    files: state.fileCount,
    languages: deps.store.languageShares(name),
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
    "Seams: not extracted yet",
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
    "Seams: not extracted yet",
    "Owner, purpose: not set",
  ].join("\n");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
