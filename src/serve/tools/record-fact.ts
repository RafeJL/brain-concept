import type { Citation } from "../../core/citations.js";
import { FACT_KINDS, HUMAN_TIER, type FactKind, type FactRecord } from "../../core/facts.js";
import { anchorProblems, parseAnchor } from "../../ingest/facts.js";
import type { SectionHit } from "../../store/store.js";
import type { Caller } from "../access.js";
import { factLine, visibleFacts } from "../facts.js";
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
  /** Store it as proposed without asking: for when the person asked to save it but can't get the dialog. */
  propose?: boolean;
  /** An earlier fact this one replaces, retired once this one is confirmed. */
  replaces?: number;
}

/**
 * The person's answer to the dialog: accepted (perhaps edited), declined, or no dialog possible.
 * `automatic` marks a decline that came back too fast for a person to have read the dialog: some
 * clients decline without showing one.
 */
export type ConfirmAnswer =
  | { action: "accept"; text: string; statedBy: string }
  | { action: "decline"; automatic?: boolean }
  | { action: "unavailable" };

/** Asks the person, not the agent, whether to record the fact. Over MCP this is elicitation. */
export type Confirm = (request: { message: string; text: string; statedBy: string }) => Promise<ConfirmAnswer>;

export interface Recorded {
  outcome: "confirmed" | "proposed" | "declined";
  fact: FactRecord | null;
  /** What the brain already said near this fact, shown to the person before they answered. */
  nearby: SectionHit[];
  related: FactRecord[];
}

const MAX_CHARS = 600;
const NEARBY = 3;

/**
 * Records a fact a person stated, on a repo or a system. The person is asked to confirm it, with
 * what the brain already says nearby so a contradiction shows; the agent can't answer for them.
 * Accepted: stored as confirmed (human-reviewed). Declined: nothing stored. No way to ask:
 * stored as proposed until a person confirms it with `brain facts confirm`. Backs
 * `brain_record_fact`.
 */
export async function recordFact(
  deps: ToolDeps,
  caller: Caller,
  input: RecordInput,
  options: { confirm: Confirm; person: string; now?: () => string },
): Promise<ToolResult<Recorded>> {
  if (Boolean(input.repo) === Boolean(input.system)) return { ok: false, text: "Give either a repo or a system for the fact, not both." };
  if (!FACT_KINDS.includes(input.kind)) return { ok: false, text: `kind must be one of ${FACT_KINDS.join(", ")}.` };
  const text = input.text.trim();
  const quote = input.quote.trim();
  if (!text || !quote) return { ok: false, text: "Give the fact (text) and what the person said (quote)." };
  if (text.length > MAX_CHARS || quote.length > MAX_CHARS) return { ok: false, text: `Keep the fact and the quote under ${MAX_CHARS} characters each: one fact per call.` };

  const target = await resolveTarget(deps, caller, input);
  if (!target.ok) return target;
  const { repo, system, members, anchors, anchorCommit, label } = target;
  const replaced = input.replaces === undefined ? null : deps.store.getFact(input.replaces);
  if (input.replaces !== undefined && !(replaced && replaced.status !== "retired" && canSee(deps, replaced, target.readable))) {
    return { ok: false, text: `No live fact #${input.replaces} to replace. Facts are numbered in brain_get, brain_search and the card.` };
  }

  const match = matchExpression(text);
  const nearby = match ? deps.store.searchSections({ repos: members, match, limit: NEARBY, snippetWords: 24 }).hits : [];
  const related = match ? deps.store.searchFacts({ ...visibleFacts(deps.store, target.readable), match, limit: NEARBY }) : [];
  const statedBy = input.statedBy?.trim() || options.person;
  const message = [
    `Record this as a fact about ${label}?`,
    "",
    `"${text}"`,
    "",
    `${input.kind} · from ${statedBy}${input.ticket ? ` · ticket ${input.ticket}` : ""}`,
    `Their words: "${quote}"`,
    ...(anchors.length ? [`Enforced at: ${input.anchors!.join(", ")}`] : []),
    ...(replaced ? ["", `It replaces fact #${replaced.id}, which is retired once you accept: "${replaced.text}"`] : []),
    ...(nearby.length || related.length ? ["", "What the brain already says nearby (check it doesn't contradict this):"] : []),
    ...related.map((f) => `  - ${factLine(f)}`),
    ...nearby.map((hit) => `  - ${hit.repo} · ${hit.slug} › ${hit.heading || hit.pageTitle}: ${hit.snippet}`),
    "",
    "Accept to record it as confirmed by you (you can edit the wording and your name). Decline to record nothing.",
  ].join("\n");

  // Proposing skips the dialog: a proposed fact is labelled unconfirmed until a person confirms it.
  const answer: ConfirmAnswer = input.propose ? { action: "unavailable" } : await options.confirm({ message, text, statedBy });
  if (answer.action === "decline") {
    const why = answer.automatic
      ? "The dialog was declined within a second, so it was most likely never shown: some apps, such as Claude Code's desktop app, decline it without asking. "
      : "If the person says they never saw a dialog, the app declined it for them. ";
    const text = `Not recorded: the dialog came back declined. ${why}If they want it saved, call brain_record_fact again with propose set to true: it is stored as proposed, and they confirm it with brain facts confirm <id> in a terminal.`;
    return { ok: true, data: { outcome: "declined", fact: null, nearby, related }, text };
  }

  const now = (options.now ?? (() => new Date().toISOString()))();
  const confirmed = answer.action === "accept";
  const by = confirmed ? answer.statedBy.trim() || statedBy : statedBy;
  const id = deps.store.addFact({
    repo,
    system,
    kind: input.kind,
    text: confirmed ? answer.text.trim() || text : text,
    quote,
    statedBy: by,
    ticket: input.ticket?.trim() || null,
    anchors,
    anchorCommit,
    status: confirmed ? "confirmed" : "proposed",
    recordedAt: now,
    confirmedBy: confirmed ? by : null,
    confirmedAt: confirmed ? now : null,
    replaces: replaced?.id ?? null,
  });
  if (confirmed && replaced) deps.store.updateFact(replaced.id, { status: "retired" });
  const fact = deps.store.getFact(id)!;
  const summary = confirmed
    ? `Recorded fact #${id} on ${label}, confirmed by ${by} (${HUMAN_TIER}). Later answers about ${label} include it.` +
      `${replaced ? ` Fact #${replaced.id}, which it replaces, is retired.` : ""}\n- ${factLine(fact)}`
    : `Stored as proposed fact #${id} on ${label}: the person couldn't be asked here, so it isn't confirmed. ` +
      `Agents see it labelled "proposed"${replaced ? `, and fact #${replaced.id} stands until it is` : ""}. Confirm it with: brain facts confirm ${id}\n- ${factLine(fact)}`;
  return { ok: true, data: { outcome: confirmed ? "confirmed" : "proposed", fact, nearby, related }, text: summary };
}

/** Whether the caller can see a fact: it is on a repo they can read, or a system with such a repo. */
function canSee(deps: ToolDeps, fact: FactRecord, readable: readonly string[]): boolean {
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
  const unreadable = (input.anchors ?? []).filter((a) => !parseAnchor(a));
  if (unreadable.length) return { ok: false, text: `Anchors are file:lines, e.g. src/follow.ts:12-20. Can't read: ${unreadable.join(", ")}.` };
  const anchors = (input.anchors ?? []).map((a) => parseAnchor(a)!);
  const { commit } = found.state;
  const problems = await anchorProblems(found.repo.path, commit, anchors);
  if (problems.length) return { ok: false, text: `Nothing recorded. The anchors don't hold at @${commit.slice(0, 7)}: ${problems.join("; ")}.` };
  const name = found.repo.name;
  return { ok: true, repo: name, system: null, members: [name], anchors, anchorCommit: anchors.length ? commit : null, label: name, readable };
}
