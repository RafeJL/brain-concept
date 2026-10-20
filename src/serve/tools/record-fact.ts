import type { Citation } from "../../core/citations.js";
import { FACT_KINDS, HUMAN_TIER, type FactKind, type FactRecord } from "../../core/facts.js";
import { checkAnchors } from "../../ingest/facts.js";
import type { SectionHit } from "../../store/store.js";
import type { Caller } from "../access.js";
import { factLine, readableChecks, visibleFacts } from "../facts.js";
import { findSystem } from "../systems.js";
import { readableRepos, requireSyncedRepo, type Failure, type ToolDeps, type ToolResult } from "./common.js";
import { matchExpression } from "./search.js";

export interface RecordInput {
  repo?: string;
  system?: string;
  kind: FactKind;
  text: string;
  /** What the person said, in their words. */
  quote: string;
  statedBy?: string;
  ticket?: string;
  /** `path:start-end` in the repo, where the fact is enforced. */
  anchors?: string[];
  /**
   * The person's words agreeing to this exact text ("yes, record that"), said in the conversation
   * after the agent showed it to them. Given, the fact is stored confirmed; omitted, proposed.
   */
  confirmedWith?: string;
  /** An earlier fact this one replaces, retired once this one is confirmed. */
  replaces?: number;
}

export interface Recorded {
  outcome: "confirmed" | "proposed";
  fact: FactRecord;
  /** What the brain already says near this fact, so the agent can raise a contradiction. */
  nearby: SectionHit[];
  related: FactRecord[];
}

const MAX_CHARS = 600;
const NEARBY = 3;

/**
 * Records a fact a person stated, on a repo or a system. Confirmed when the person agreed to this
 * text in the conversation (`confirmedWith`, their words) or ran the command themselves
 * (`terminal`); otherwise proposed, labelled unconfirmed until a person confirms it. Over MCP the
 * client also asks the person to allow every call, showing what is stored, so an agent can't
 * confirm on its own. The answer lists what the brain already says nearby. Backs
 * `brain_record_fact` and `brain facts add`.
 */
export async function recordFact(
  deps: ToolDeps,
  caller: Caller,
  input: RecordInput,
  options: { person: string; terminal?: boolean; now?: () => string },
): Promise<ToolResult<Recorded>> {
  if (Boolean(input.repo) === Boolean(input.system)) return { ok: false, text: "Give either a repo or a system for the fact, not both." };
  if (!FACT_KINDS.includes(input.kind)) return { ok: false, text: `kind must be one of ${FACT_KINDS.join(", ")}.` };
  const text = input.text.trim();
  const quote = input.quote.trim();
  const words = input.confirmedWith?.trim() || null;
  if (!text || !quote) return { ok: false, text: "Give the fact (text) and what the person said (quote)." };
  if ([text, quote, words ?? ""].some((s) => s.length > MAX_CHARS)) return { ok: false, text: `Keep the fact, the quote and confirmed_with under ${MAX_CHARS} characters each: one fact per call.` };

  const target = await resolveTarget(deps, caller, input);
  if (!target.ok) return target;
  const { repo, system, members, anchors, anchorCommit, label } = target;
  const replaced = input.replaces === undefined ? null : deps.store.getFact(input.replaces);
  if (input.replaces !== undefined && !(replaced && replaced.status !== "retired" && canSee(deps, replaced, target.readable))) {
    return { ok: false, text: `No live fact #${input.replaces} to replace. Facts are numbered in brain_get, brain_search, the card and brain_facts.` };
  }

  const match = matchExpression(text);
  const nearby = match ? deps.store.searchSections({ repos: members, match, limit: NEARBY, snippetWords: 24 }).hits : [];
  const related = match
    ? readableChecks(deps.store.searchFacts({ ...visibleFacts(deps.store, target.readable), match, limit: NEARBY }), target.readable).filter((f) => f.id !== replaced?.id)
    : [];
  const now = (options.now ?? (() => new Date().toISOString()))();
  const confirmed = Boolean(options.terminal || words);
  const by = input.statedBy?.trim() || options.person;
  const id = deps.store.addFact({
    repo,
    system,
    kind: input.kind,
    text,
    quote,
    statedBy: by,
    ticket: input.ticket?.trim() || null,
    anchors,
    anchorCommit,
    status: confirmed ? "confirmed" : "proposed",
    recordedAt: now,
    confirmedBy: confirmed ? by : null,
    confirmedAt: confirmed ? now : null,
    confirmedWith: confirmed ? words : null,
    replaces: replaced?.id ?? null,
  });
  if (confirmed && replaced) deps.store.updateFact(replaced.id, { status: "retired" });
  const fact = deps.store.getFact(id)!;
  const summary = confirmed
    ? `Recorded fact #${id} on ${label}, confirmed by ${by} (${HUMAN_TIER}). Later answers about ${label} include it.` +
      `${replaced ? ` Fact #${replaced.id}, which it replaces, is retired.` : ""}\n- ${factLine(fact)}`
    : `Stored as proposed fact #${id} on ${label}, not confirmed: no confirmed_with was given. Agents see it labelled "proposed"` +
      `${replaced ? `, and fact #${replaced.id} stands until it is confirmed` : ""}. When the person agrees to it, confirm it with brain_facts (action confirm).\n- ${factLine(fact)}`;
  const near = [
    ...related.map((f) => `  - ${factLine(f)}`),
    ...nearby.map((hit) => `  - ${hit.repo} · ${hit.slug} › ${hit.heading || hit.pageTitle}: ${hit.snippet}`),
  ];
  const nearText = near.length
    ? `\n\nWhat the brain already says nearby. If any of it contradicts the new fact, tell the person, and offer to retire the fact that's wrong (brain_facts):\n${near.join("\n")}`
    : "";
  return { ok: true, data: { outcome: confirmed ? "confirmed" : "proposed", fact, nearby, related }, text: summary + nearText };
}

/** Whether the caller can see a fact: it is on a repo they can read, or a system with such a repo. */
export function canSee(deps: ToolDeps, fact: FactRecord, readable: readonly string[]): boolean {
  return fact.repo ? readable.includes(fact.repo) : findSystem(deps.store, fact.system!, readable) !== undefined;
}

type Target = {
  ok: true;
  repo: string | null;
  system: string | null;
  /** The repos whose wikis are searched for what the brain already says. */
  members: string[];
  anchors: Citation[];
  anchorCommit: string | null;
  label: string;
  readable: string[];
};

/** The repo or system a fact is on, with its anchors checked against the repo's indexed commit. */
async function resolveTarget(deps: ToolDeps, caller: Caller, input: RecordInput): Promise<Target | Failure> {
  const readable = await readableRepos(deps, caller);
  if (input.system) {
    const system = findSystem(deps.store, input.system, readable);
    if (!system) return { ok: false, text: `No system named "${input.system}". Use a name from the brain's instructions or brain_search.` };
    if (input.anchors?.length) return { ok: false, text: "Anchors point at lines in one repo: record the fact on that repo instead of the system." };
    return { ok: true, repo: null, system: system.name, members: system.repos, anchors: [], anchorCommit: null, label: `the ${system.name} system`, readable };
  }
  const found = await requireSyncedRepo(deps, caller, input.repo!);
  if (!found.ok) return found;
  const { commit } = found.state;
  const checked = await checkAnchors(found.repo.path, commit, input.anchors ?? []);
  if ("error" in checked) return { ok: false, text: `Nothing recorded. ${checked.error}` };
  const name = found.repo.name;
  const anchors = checked.cites;
  return { ok: true, repo: name, system: null, members: [name], anchors, anchorCommit: anchors.length ? commit : null, label: name, readable };
}
