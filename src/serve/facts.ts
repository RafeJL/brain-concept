import { HUMAN_TIER, type FactRecord } from "../core/facts.js";
import type { FactFilter, Store } from "../store/store.js";
import { systemOf, visibleSystems } from "./systems.js";

/** The facts a caller can see: on repos they can read, and on systems with a member they can read. */
export function visibleFacts(store: Store, readable: readonly string[]): FactFilter {
  return { repos: readable, systems: visibleSystems(store, readable).map((s) => s.name) };
}

/** Live facts on a repo and on the system it belongs to, newest first. */
export function factsAbout(store: Store, repo: string, readable: readonly string[]): FactRecord[] {
  const system = systemOf(store, repo, readable);
  return store.facts({ repos: [repo], systems: system ? [system.name] : [] });
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
    ...(fact.anchors.length ? [`enforced at ${fact.anchors.map((a) => `${a.path}:${a.start === a.end ? a.start : `${a.start}-${a.end}`}`).join(", ")}`] : []),
    ...(fact.staleSince ? [`stale: that code changed at @${fact.staleSince.slice(0, 7)}, so re-confirm before relying on it`] : []),
    `fact #${fact.id}`,
  ];
  return `${fact.text} (${parts.join(" · ")})`;
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
