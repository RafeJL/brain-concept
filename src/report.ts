import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DROPPED_KINDS, type DroppedKind } from "./ai/dropped.js";
import type { FactChecksResult } from "./ai/fact-checks.js";
import type { PlanReport, WikiResult } from "./ai/generate.js";
import type { SeamsResult } from "./ai/seams.js";
import type { SuggestResult } from "./ai/systems.js";
import type { TracesResult } from "./ai/traces.js";
import { formatCitation } from "./core/citations.js";
import { familyOf } from "./core/seams.js";
import type { SyncResult } from "./ingest/sync.js";
import { count } from "./serve/tools/common.js";

// What the CLI prints after each step of a sync: what changed, what was dropped and what it cost;
// and the dropped-facts report, which is too long to print.

/** "$0.12 · 34s": what a run cost and how long it took. */
function spent(result: { costUsd: number; durationMs: number }): string {
  return `$${result.costUsd.toFixed(2)} · ${Math.round(result.durationMs / 1000)}s`;
}

/** Prints the first `shown` items, then "… and N more" for the rest. */
function printSome<T>(items: readonly T[], shown: number, line: (item: T) => string): void {
  for (const item of items.slice(0, shown)) console.log(line(item));
  if (items.length > shown) console.log(`    … and ${items.length - shown} more`);
}

export function printSeams(result: SeamsResult): void {
  const at = `@${result.commit.slice(0, 7)}`;
  if (result.mode === "update" && result.redone.length === 0) {
    console.log(`${result.repo}: routes and calls up to date at ${at}, no code changed (no AI run)`);
    return;
  }
  const routes = result.kept.filter((s) => s.kind === "http-route").length + result.derived;
  const calls = result.kept.filter((s) => s.kind === "http-call");
  const runtime = calls.filter((s) => s.key === null).length;
  // Events, gRPC and packages by kind, e.g. ", event-publish 3, event-subscribe 5".
  const byKind = new Map<string, number>();
  for (const seam of result.kept.filter((s) => familyOf(s.kind) !== "http")) byKind.set(seam.kind, (byKind.get(seam.kind) ?? 0) + 1);
  const links = [...byKind].map(([kind, n]) => `, ${kind} ${n}`).join("");
  const scope = result.mode === "full" ? "mapped" : `updated in ${count(result.redone.length, "file")}`;
  const retried = result.retried ? `, ${result.retried} dropped and asked for again` : "";
  const dropped = result.dropped.length ? `, ${result.dropped.length} ${result.retried ? "still " : ""}dropped` : result.retried ? ", all recovered" : "";
  const derived = result.derived ? ` (${result.derived} from base classes)` : "";
  const screened = result.screened.pieces
    ? ` · screened ${count(result.screened.pieces, "piece")} of its own code: ${result.screened.http} to map for HTTP, ${result.screened.links} for messages${result.unmapped.length ? `; ${result.unmapped.length} not mapped` : ""}`
    : "";
  console.log(
    `${result.repo}: routes and calls ${scope} at ${at} · ${count(routes, "route")}${derived}, ${count(calls.length - runtime, "call")}` +
      `${runtime ? ` (+${runtime} run-time)` : ""}${links}${retried}${dropped}${screened} · ${spent(result)}`,
  );
  printSome(result.dropped, 3, (drop) => `    dropped: ${drop.reason} · ${drop.seam}`);
  printSome(result.unmapped, 3, (piece) => `    not mapped (no run answered for it): ${formatCitation(piece)}`);
}

/** `droppedReport` is where the full list of dropped facts was written, if it was. */
export function printWiki(wiki: WikiResult, droppedReport: string | null = null): void {
  const at = `@${wiki.commit.slice(0, 7)}`;
  if (wiki.plan) console.log(`${wiki.repo}: ${planText(wiki.plan)}`);
  if (wiki.reports.length === 0) {
    const carried = wiki.carried.length ? `; ${wiki.carried.length} pages re-checked and moved to ${at}` : "";
    const ran = wiki.costUsd ? `only the planning run, $${wiki.costUsd.toFixed(2)}` : "no AI run";
    console.log(`${wiki.repo}: wiki up to date at ${at}, no page needed rewriting (${ran}${carried})`);
    if (wiki.waiting.length) console.log(`  ${wiki.waiting.join(", ")} failed the check at ${at}; it's tried again after the next change, or with --full`);
    return;
  }
  const action = wiki.mode === "full" ? "written" : "updated";
  console.log(`${wiki.repo}: wiki ${action} at ${at} · ${spent(wiki)}`);
  for (const report of wiki.reports) {
    const kept = report.claims - report.removed.length;
    const state = report.published ? "published" : "NOT published (too few claims supported; previous version kept if any)";
    const twice = report.attempts > 1 ? " · second attempt" : "";
    console.log(`  ${report.slug.padEnd(24)} ${kept}/${report.claims} claims kept · ${state}${twice}`);
    printSome(report.removed, 3, (claim) => `    removed: ${claim.reason} · "${claim.text.slice(0, 90)}…"`);
  }
  if (wiki.carried.length) console.log(`  unchanged, moved to ${at}: ${wiki.carried.join(", ")}`);
  if (wiki.dropped.length) {
    const tally = DROPPED_KINDS.map((kind) => [wiki.dropped.filter((f) => f.kind === kind).length, DROPPED_WORDS[kind]] as const)
      .filter(([n]) => n > 0)
      .map(([n, words]) => `${n} ${words}`);
    console.log(`  facts the previous wiki cited and this one doesn't: ${tally.join(", ")}`);
    if (droppedReport) console.log(`    full list: ${droppedReport}`);
  }
  console.log(`Read them with: brain page ${wiki.repo}`);
}

const DROPPED_WORDS: Record<DroppedKind, string> = {
  lost: "lost",
  "page-renamed": "on renamed pages",
  "page-removed": "on removed pages",
  restated: "restated elsewhere",
  "code-changed": "code changed",
};

/** What each kind means, as the report's headings say it. */
const DROPPED_MEANING: Record<DroppedKind, string> = {
  lost: "Lost: the page is still there, and no new claim says it",
  "page-renamed": "On renamed pages: the page is gone, and a page new to the wiki citing half or more of its files doesn't say it",
  "page-removed": "On removed pages: the page is gone, and no page new to the wiki cites half of its files",
  restated: "Restated elsewhere: a new claim names the same code (or most of its words), citing other lines",
  "code-changed": "Code changed: its cited lines changed since, so the code moved on, not the wiki",
};

/**
 * Writes every fact a full rewrite dropped to a Markdown file for a person to read, real losses
 * first, with a JSON copy beside it for counting across runs. Returns the Markdown file's path.
 */
export function writeDroppedReport(wiki: WikiResult, dir: string): string {
  const written = new Date().toISOString();
  const base = join(dir, wiki.repo, `dropped-${wiki.commit.slice(0, 7)}-${written.slice(0, 19).replace(/:/g, "")}`);
  const counts = Object.fromEntries(DROPPED_KINDS.map((kind) => [kind, wiki.dropped.filter((f) => f.kind === kind).length]));
  const out = [
    `# Facts a full rewrite dropped: ${wiki.repo} @${wiki.commit.slice(0, 7)}`,
    "",
    `Written ${written}. Claims of the previous wiki that no page of the new one cites, by why. ` +
      "Sorted without AI, by citations and names: read them to judge which losses matter.",
    "",
    "| Kind | Facts |",
    "|---|---|",
    ...DROPPED_KINDS.map((kind) => `| ${DROPPED_WORDS[kind]} | ${counts[kind]} |`),
  ];
  for (const kind of DROPPED_KINDS) {
    const facts = wiki.dropped.filter((f) => f.kind === kind);
    if (facts.length === 0) continue;
    out.push("", `## ${DROPPED_MEANING[kind]} (${facts.length})`);
    for (const slug of [...new Set(facts.map((f) => f.slug))]) {
      out.push("", `### ${slug}`, "");
      for (const fact of facts.filter((f) => f.slug === slug)) {
        const moved = fact.moved.length && fact.moved.join("; ") !== fact.cites.join("; ") ? `, now ${fact.moved.join("; ")}` : "";
        out.push(`- cited ${fact.cites.join("; ")}${moved}`, `  > ${fact.claim}`);
        if (fact.match?.claim) out.push(`  - said on ${fact.match.slug}:`, `    > ${fact.match.claim}`);
        else if (fact.match) out.push(`  - its page carried on as ${fact.match.slug}`);
      }
    }
  }
  out.push("", "## Claims the check removed from the new pages", "", "| Page | Claims | Removed | Published |", "|---|---|---|---|");
  for (const report of wiki.reports) out.push(`| ${report.slug} | ${report.claims} | ${report.removed.length} | ${report.published ? "yes" : "no"} |`);

  mkdirSync(dirname(base), { recursive: true });
  writeFileSync(`${base}.md`, `${out.join("\n")}\n`);
  const pages = wiki.reports.map((r) => ({ slug: r.slug, claims: r.claims, removed: r.removed.length, published: r.published }));
  writeFileSync(`${base}.json`, `${JSON.stringify({ repo: wiki.repo, commit: wiki.commit, written, counts, dropped: wiki.dropped, pages }, null, 2)}\n`);
  return `${base}.md`;
}

/** "planned again (a new project at src/Payments.API): +1 page (payments)", or why no plan passed. */
function planText(plan: PlanReport): string {
  if (plan.problems.length) return `wiki not planned again (${plan.reason}): the plan failed the check (${plan.problems.slice(0, 3).join("; ")}), so it kept its pages`;
  const changes = [
    plan.added.length ? `+${count(plan.added.length, "page")} (${plan.added.join(", ")})` : "",
    plan.retired.length ? `−${count(plan.retired.length, "page")} (${plan.retired.join(", ")})` : "",
  ].filter(Boolean);
  return `wiki planned (${plan.reason}): ${changes.join(", ") || "no pages added or dropped"}`;
}

export function printTraces(result: TracesResult): void {
  if (result.mode === "none") return;
  const scope = result.mode === "full" ? "traced" : `traced again for ${count(result.followed, "entry point")}`;
  const missing = result.untriggered.length ? ` · ${count(result.untriggered.length, "exit point")} no entry point was found to reach` : "";
  console.log(`${result.repo}: what each entry point leads to ${scope} · ${count(result.kept, "checked chain")}${result.dropped.length ? `, ${result.dropped.length} dropped` : ""}${missing} · ${spent(result)}`);
  printSome(result.dropped, 3, (drop) => `    dropped: ${drop.entry}: ${drop.reason}`);
}

export function printSuggestion(result: SuggestResult): void {
  if (result.costUsd === 0 && result.kept.length === 0 && result.dropped.length === 0) {
    console.log("Every repo is already in a confirmed system, so there is nothing to suggest.");
    return;
  }
  console.log(`Suggested ${count(result.kept.length, "system")} · ${spent(result)}`);
  for (const system of result.kept) {
    console.log(`  ${system.name}: ${system.repos.join(", ")}`);
    if (system.summary) console.log(`    ${system.summary}`);
    console.log(`    why: ${system.reason}`);
  }
  for (const drop of result.dropped) console.log(`  dropped ${drop.system}: ${drop.reason}`);
  for (const note of result.leftOut) console.log(`  left out of ${note.system}: ${note.reason}`);
  if (result.confirmed.length) console.log(`Already in confirmed systems, so left as they are: ${result.confirmed.join(", ")}`);
  if (result.ungrouped.length) console.log(`In no system: ${result.ungrouped.join(", ")}`);
  if (result.kept.length) console.log("Agents see these labelled suggested. Confirm with: brain systems confirm <system> (or --all)");
}

/**
 * One line per repo whose facts were checked: how many, and what the code does about them, then
 * the facts it contradicts or couldn't settle. Nothing when no fact needed a check, unless asked.
 */
export function printChecks(result: FactChecksResult, asked = false): void {
  const at = `@${result.commit.slice(0, 7)}`;
  if (result.checked.length === 0) {
    if (asked) console.log(`${result.repo}: facts already checked at ${at}, and nothing they rest on changed (no AI run; --full checks again)`);
    return;
  }
  const words: Record<string, string> = { agrees: "agrees", contradicts: "contradicts", absent: "not in the code", unclear: "unclear" };
  const tally = Object.entries(words)
    .map(([verdict, word]) => [result.checked.filter((c) => c.verdict === verdict).length, word] as const)
    .filter(([n]) => n > 0)
    .map(([n, word]) => `${n} ${word}`)
    .join(", ");
  console.log(`${result.repo}: ${count(result.checked.length, "fact")} checked against the code at ${at} · ${tally} · ${spent(result)}`);
  for (const check of result.checked.filter((c) => c.verdict === "contradicts" || c.verdict === "unclear")) {
    console.log(`    fact #${check.fact} ${check.verdict}: ${check.summary}`);
  }
}

export function printSync(result: SyncResult): void {
  const from = result.previousCommit ? `${result.previousCommit.slice(0, 7)} -> ` : "";
  console.log(`${result.repo}: ${from}${result.commit.slice(0, 7)} (+${result.added} ~${result.changed} -${result.removed}, ${result.unchanged} unchanged)`);
  if (result.staleFacts) console.log(`${result.repo}: code under ${count(result.staleFacts, "fact")} from people changed; re-confirm with: brain facts ${result.repo}`);
}
