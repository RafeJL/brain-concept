import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withoutCitations } from "../core/citations.js";
import type { SystemRecord } from "../core/systems.js";
import { BrainError } from "../core/types.js";
import { neighbours } from "../serve/neighbours.js";
import { count } from "../serve/tools/common.js";
import type { Store } from "../store/store.js";
import { DEFAULT_MODEL, PRODUCT } from "./generate.js";
import { prompt } from "./prompts.js";
import type { Runner } from "./runner.js";

const SCHEMA = {
  type: "object",
  properties: {
    systems: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          summary: { type: "string" },
          repos: { type: "array", minItems: 1, items: { type: "string" } },
          reason: { type: "string" },
        },
        required: ["name", "summary", "repos", "reason"],
      },
    },
  },
  required: ["systems"],
};

/** One system as the AI proposed it, before verification. */
export interface FoundSystem {
  name: string;
  summary: string;
  repos: string[];
  reason: string;
}

/** A suggestion the check dropped, or a repo it left out of one it kept. */
export interface SystemNote {
  system: string;
  reason: string;
}

export type SuggestedSystem = Pick<SystemRecord, "name" | "summary" | "reason" | "repos">;

export interface SuggestResult {
  kept: SuggestedSystem[];
  dropped: SystemNote[];
  /** Repos left out of kept systems because nothing links them to the other members. */
  leftOut: SystemNote[];
  /** Repos already in a confirmed system, so left out of the run. */
  confirmed: string[];
  /** Repos in no suggested or confirmed system. */
  ungrouped: string[];
  costUsd: number;
  durationMs: number;
}

/** How much of each product page the run sees: its opening says what the repo is for. */
const OPENING_CHARS = 600;

/**
 * Has Claude Code group the enrolled repos into systems from a small context file (each repo's
 * card, the opening of its product page and its links), checks each suggestion and stores what
 * passes as `suggested`, replacing earlier suggestions. Repos a person has already put in a
 * confirmed system are left out. No code is read, so it costs cents.
 */
export async function suggestSystems(store: Store, runner: Runner, options: { model?: string } = {}): Promise<SuggestResult> {
  const all = store.listRepos().map((r) => r.name);
  if (all.length === 0) throw new BrainError("No repos enrolled. Add one with: brain add <path>");
  const confirmedSystems = store.systems().filter((s) => s.status === "confirmed");
  const confirmed = confirmedSystems.flatMap((s) => s.repos);
  const free = all.filter((name) => !confirmed.includes(name));
  const empty = { kept: [], dropped: [], leftOut: [], confirmed, ungrouped: [], costUsd: 0, durationMs: 0 };
  if (free.length === 0) {
    store.replaceSuggestedSystems([]);
    return empty;
  }

  const dir = mkdtempSync(join(tmpdir(), "brain-systems-"));
  try {
    writeFileSync(join(dir, "repos.md"), contextFile(store, free, all));
    const run = await runner.run<{ systems?: unknown }>({
      cwd: dir,
      prompt: prompt("suggest-systems", { confirmed: confirmedNote(confirmedSystems) }),
      schema: SCHEMA,
      model: options.model ?? DEFAULT_MODEL,
    });
    if (!Array.isArray(run.output?.systems)) throw new BrainError("The AI's systems were malformed. Nothing was stored.");
    const checked = verifySystems(store, run.output.systems, free, confirmedSystems.map((s) => s.name));
    store.replaceSuggestedSystems(checked.kept);
    const grouped = new Set([...confirmed, ...checked.kept.flatMap((s) => s.repos)]);
    return { ...empty, ...checked, ungrouped: all.filter((name) => !grouped.has(name)), costUsd: run.costUsd, durationMs: run.durationMs };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** repos.md: what the run knows about each repo. Facts only: links, pages, the product page's opening. */
export function contextFile(store: Store, repos: readonly string[], all: readonly string[]): string {
  const blocks = repos.map((name) => {
    const repo = store.getRepo(name)!;
    const { calls, calledBy } = neighbours(store, name, all);
    const coverage = store.seamCoverage(name);
    const languages = store.languageShares(name).slice(0, 4).map((l) => l.language).join(", ");
    const pages = store.pages(name);
    const product = pages.find((p) => p.slug === PRODUCT) ?? pages.find((p) => p.slug === "overview");
    // The page's own title says nothing; heading marks are left out so it reads as text.
    const text = product ? withoutCitations(product.markdown.replace(/^#\s.*$/m, "")).replace(/^#+\s*/gm, "") : "";
    const opening = text.replace(/\s+/g, " ").replace(/ ([.,;:)])(?=\s|$)/g, "$1").trim().slice(0, OPENING_CHARS);
    return [
      `## ${name}`,
      `Remote: ${repo.remote ?? "none"}`,
      `Languages: ${languages || "unknown"}`,
      `Routes served: ${coverage.routes} · calls made: ${coverage.calls}`,
      `Calls: ${calls.map((n) => `${n.repo} (${count(n.count, "endpoint")})`).join(", ") || "none found"}`,
      `Called by: ${calledBy.map((n) => `${n.repo} (${count(n.count, "call")})`).join(", ") || "none found"}`,
      `Wiki pages: ${pages.map((p) => p.slug).join(", ") || "none yet"}`,
      product ? `Opening of its ${product.slug} page: ${opening}` : "No product page yet.",
    ].join("\n");
  });
  return `# Repositories\n\n${blocks.join("\n\n")}\n`;
}

function confirmedNote(systems: readonly SystemRecord[]): string {
  if (systems.length === 0) return "";
  const list = systems.map((s) => `${s.name} (${s.repos.join(", ") || "no repos"})`).join("; ");
  return `- A person has already confirmed these systems, whose repositories aren't in repos.md: ${list}. Don't reuse their names.`;
}

/**
 * Keeps the suggestions the facts support: every repo is enrolled and not already confirmed
 * elsewhere, no repo is in two systems, and names don't clash. In a system of several repos, each
 * must call or be called by another member in the route map; one that isn't is left out (looking
 * alike proves nothing), and a system left with fewer than two is dropped. A system of one needs
 * no link: the repo is a product on its own.
 */
export function verifySystems(
  store: Store,
  found: readonly unknown[],
  free: readonly string[],
  confirmedNames: readonly string[],
): { kept: SuggestedSystem[]; dropped: SystemNote[]; leftOut: SystemNote[] } {
  const all = store.listRepos().map((r) => r.name);
  const kept: SuggestedSystem[] = [];
  const dropped: SystemNote[] = [];
  const leftOut: SystemNote[] = [];
  const taken = new Map<string, string>();
  const names = new Set(confirmedNames.map((n) => n.toLowerCase()));
  for (const item of found) {
    const entry = item as Partial<FoundSystem>;
    const label = typeof entry?.name === "string" && entry.name.trim() ? entry.name.trim() : "(unnamed)";
    const drop = (reason: string) => dropped.push({ system: label, reason });
    const shaped =
      typeof entry?.name === "string" &&
      entry.name.trim() !== "" &&
      typeof entry.summary === "string" &&
      typeof entry.reason === "string" &&
      Array.isArray(entry.repos) &&
      entry.repos.length > 0 &&
      entry.repos.every((r) => typeof r === "string");
    if (!shaped) {
      drop("malformed entry");
      continue;
    }
    let repos = [...new Set(entry.repos!.map((r) => r.trim()))].sort();
    if (names.has(label.toLowerCase())) {
      drop(`the name "${label}" is already used`);
      continue;
    }
    const unknown = repos.find((r) => !free.includes(r));
    if (unknown) {
      drop(all.includes(unknown) ? `${unknown} is already in a confirmed system` : `${unknown} isn't an enrolled repo`);
      continue;
    }
    const twice = repos.find((r) => taken.has(r));
    if (twice) {
      drop(`${twice} is already in ${taken.get(twice)}`);
      continue;
    }

    if (repos.length > 1) {
      const linked = repos.filter((repo) => linksTo(store, repo, repos, all));
      if (linked.length < 2) {
        drop("none of its repos call each other in the route map");
        continue;
      }
      for (const repo of repos.filter((r) => !linked.includes(r))) {
        leftOut.push({ system: label, reason: `${repo} doesn't call or get called by any other repo in it, in the route map` });
      }
      repos = linked;
    }
    names.add(label.toLowerCase());
    for (const repo of repos) taken.set(repo, label);
    kept.push({ name: label, summary: entry.summary!.trim(), reason: entry.reason!.trim(), repos });
  }
  return { kept, dropped, leftOut };
}

/** Whether `repo` calls, or is called by, another of `members` in the route map. */
function linksTo(store: Store, repo: string, members: readonly string[], all: readonly string[]): boolean {
  const { calls, calledBy } = neighbours(store, repo, all);
  return [...calls, ...calledBy].some((n) => n.repo !== repo && members.includes(n.repo));
}
