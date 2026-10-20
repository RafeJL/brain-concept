import { formatCitation } from "../core/citations.js";
import { HUMAN_TIER, type FactCheck, type FactRecord, type Verdict } from "../core/facts.js";
import type { FactFilter, Store } from "../store/store.js";
import { systemOf, visibleSystems } from "./systems.js";

/** The facts a caller can see: on repos they can read, and on systems with a member they can read. */
export function visibleFacts(store: Store, readable: readonly string[]): FactFilter {
  return { repos: readable, systems: visibleSystems(store, readable).map((s) => s.name) };
}

/** Live facts on a repo and on the system it belongs to, newest first. */
export function factsAbout(store: Store, repo: string, readable: readonly string[]): FactRecord[] {
  const system = systemOf(store, repo, readable);
  return readableChecks(store.facts({ repos: [repo], systems: system ? [system.name] : [] }), readable);
}

/** The facts with only the checks made in repos the caller can read: a system's other repos stay hidden. */
export function readableChecks(facts: readonly FactRecord[], readable: readonly string[]): FactRecord[] {
  return facts.map((fact) => ({ ...fact, checks: fact.checks.filter((c) => readable.includes(c.repo)) }));
}

/**
 * One fact: the text, then how far to trust it and where it came from. A confirmed fact is
 * human-reviewed; a proposed one says nobody has confirmed it; a stale one says its code moved.
 */
export function factLine(fact: FactRecord): string {
  const who =
    fact.status === "proposed"
      ? `proposed, not confirmed by a person: said by ${fact.statedBy} on ${fact.recordedAt.slice(0, 10)}`
      : `${fact.status === "retired" ? "retired; was " : ""}${HUMAN_TIER} · ${fact.confirmedBy ?? fact.statedBy}, ${(fact.confirmedAt ?? fact.recordedAt).slice(0, 10)}`;
  const parts = [
    fact.kind,
    who,
    ...(fact.ticket ? [`ticket ${fact.ticket}`] : []),
    ...(fact.anchors.length ? [`enforced at ${fact.anchors.map(formatCitation).join(", ")}${fact.anchorsFound ? " (found by Claude Code)" : ""}`] : []),
    ...(fact.staleSince ? [`stale: that code changed at @${fact.staleSince.slice(0, 7)}, so re-confirm before relying on it`] : []),
    ...codeCheck(fact),
    ...(fact.replaces ? [`${fact.status === "proposed" ? "would replace" : "replaces"} fact #${fact.replaces}`] : []),
    `fact #${fact.id}`,
  ];
  return `${fact.text} (${parts.join(" · ")})`;
}

/**
 * What Claude Code found the code does about the fact. A repo fact has one check: "code agrees at
 * …", "code contradicts it: …", "not in the code: …". A system fact has one per member repo,
 * summed up by verdict.
 */
function codeCheck(fact: FactRecord): string[] {
  const { checks } = fact;
  if (checks.length === 0) return [];
  if (fact.repo && checks.length === 1) {
    const [check] = checks as [FactCheck];
    const cite = check.cites[0] && (fact.anchorsFound ? "" : ` at ${formatCitation(check.cites[0])}`);
    const said: Record<Verdict, string> = {
      agrees: `code agrees${cite}`,
      contradicts: `code contradicts it${cite}: ${check.summary}`,
      absent: `not in the code: ${check.summary}`,
      unclear: "the code check was unclear",
    };
    return [`${said[check.verdict]} (checked @${check.commit.slice(0, 7)})`];
  }
  const by = (verdict: Verdict) => checks.filter((c) => c.verdict === verdict);
  const where = (c: FactCheck) => `${c.repo}${c.cites[0] ? ` (${formatCitation(c.cites[0])})` : ""}`;
  return [
    [
      ...(by("agrees").length ? [`code agrees in ${by("agrees").map(where).join(", ")}`] : []),
      ...by("contradicts").map((c) => `contradicts it in ${where(c)}: ${c.summary.replace(/\.$/, "")}`),
      ...(by("absent").length ? [`not in the code of ${by("absent").map((c) => c.repo).join(", ")}`] : []),
      ...(by("unclear").length ? [`unclear in ${by("unclear").map((c) => c.repo).join(", ")}`] : []),
    ].join("; "),
  ];
}

/**
 * Marks a fact confirmed by `by` (a proposed one, or a stale one re-confirmed), with its anchors
 * now checked at `commit`, and retires the fact it replaces, if any. `words` are the person's
 * agreeing, when they confirmed it in a conversation.
 */
export function confirmFact(store: Store, fact: FactRecord, by: string, at: string, commit: string | null, words: string | null = null): void {
  store.updateFact(fact.id, {
    status: "confirmed",
    confirmedBy: by,
    confirmedAt: at,
    confirmedWith: words,
    staleSince: null,
    ...(fact.anchors.length && commit ? { anchorCommit: commit } : {}),
  });
  if (fact.replaces) store.updateFact(fact.replaces, { status: "retired" });
}

/** "2 confirmed by people, 1 proposed, 1 stale", or null when there are none. */
export function factCountText(facts: readonly FactRecord[]): string | null {
  const live = facts.filter((f) => f.status !== "retired");
  if (live.length === 0) return null;
  const confirmed = live.filter((f) => f.status === "confirmed").length;
  const proposed = live.length - confirmed;
  const stale = live.filter((f) => f.staleSince).length;
  return [
    ...(confirmed ? [`${confirmed} confirmed by people`] : []),
    ...(proposed ? [`${proposed} proposed`] : []),
    ...(stale ? [`${stale} stale`] : []),
  ].join(", ");
}

/** The "From people" section that opens a product page. */
export function factBlock(facts: readonly FactRecord[]): string[] {
  if (facts.length === 0) return [];
  return [
    "## From people",
    "",
    "Stated by people, not written by Claude Code; each says whether a person confirmed it. Where a confirmed one disagrees with the AI-written text, the person is more likely right; check the code if it matters.",
    "",
    ...facts.map((fact) => `- ${factLine(fact)}`),
    "",
  ];
}
