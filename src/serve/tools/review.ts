import type { FactRecord } from "../../core/facts.js";
import type { Caller } from "../access.js";
import { factLine, readableChecks, visibleFacts } from "../facts.js";
import { findSystem, visibleSystems } from "../systems.js";
import { count, PAGE_SIZE, readableRepos, type ToolDeps, type ToolResult } from "./common.js";

export interface ReviewInput {
  /** Only what's on this repo, or this system. */
  repo?: string;
  system?: string;
  /** Every live fact, not only those waiting for a person. */
  all?: boolean;
  offset?: number;
}

const GAPS_SHOWN = 15;

/**
 * What's waiting for a person: facts proposed or gone stale, systems Claude Code suggested, notes
 * an agent proposed, and the questions the brain couldn't answer. Read-only, so it needs no
 * permission prompt and works in headless runs; the changes are brain_facts, brain_systems and
 * brain_set_note. Backs `brain_review`.
 */
export async function review(deps: ToolDeps, caller: Caller, input: ReviewInput): Promise<ToolResult<unknown>> {
  if (input.repo && input.system) return { ok: false, text: "Give a repo or a system, not both." };
  const readable = await readableRepos(deps, caller);
  let filter = visibleFacts(deps.store, readable);
  let repos = readable;
  let label = "in the repos you can read";
  if (input.repo) {
    if (!readable.includes(input.repo)) return { ok: false, text: `No readable repo named "${input.repo}". Repos you can read: ${readable.join(", ") || "none"}.` };
    filter = { repos: [input.repo], systems: [] };
    repos = [input.repo];
    label = `on ${input.repo}`;
  } else if (input.system) {
    const system = findSystem(deps.store, input.system, readable);
    if (!system) return { ok: false, text: `No system named "${input.system}". Use a name from the brain's instructions.` };
    filter = { repos: [], systems: [system.name] };
    repos = system.repos;
    label = `on the ${system.name} system`;
  }
  const scoped = Boolean(input.repo || input.system);

  const waiting = (f: FactRecord) => f.status === "proposed" || Boolean(f.staleSince);
  const facts = readableChecks(deps.store.facts(filter), readable)
    .filter((f) => input.all || waiting(f))
    .sort((a, b) => Number(waiting(b)) - Number(waiting(a)));
  const offset = input.offset ?? 0;
  const page = facts.slice(offset, offset + PAGE_SIZE);
  const notes = repos.flatMap((name) => {
    const note = deps.store.getRepo(name)?.proposedNote;
    return note ? [`- ${name}: "${note.text}" (proposed by ${note.by}, ${note.at.slice(0, 10)})`] : [];
  });
  const suggested = scoped ? [] : visibleSystems(deps.store, readable).filter((s) => s.status === "suggested");
  const gaps = scoped ? [] : deps.store.gaps(GAPS_SHOWN, readable);

  const out = [
    facts.length
      ? `${input.all ? count(facts.length, "fact") : `${count(facts.length, "fact")} waiting for a person to confirm (proposed, or stale because their code changed)`} ${label}:`
      : `No facts ${input.all ? "" : "waiting "}${label}.`,
    ...page.map((f) => `- ${f.repo ?? `system ${f.system}`}: ${factLine(f)}`),
    ...(offset + page.length < facts.length ? [`+${facts.length - offset - page.length} more (offset ${offset + page.length})`] : []),
    ...(notes.length ? ["", "Proposed notes, steering nothing until confirmed (brain_set_note with confirm_proposed):", ...notes] : []),
    ...(suggested.length
      ? ["", "Systems Claude Code suggested, not yet confirmed (brain_systems):", ...suggested.map((s) => `- ${s.name}: ${s.repos.join(", ")}${s.reason ? `. Why: ${s.reason}` : ""}`)]
      : []),
    ...(gaps.length
      ? [
          "",
          "Questions the brain couldn't answer, most asked first (worth recording with brain_record_fact, kind answer, when the person knows):",
          ...gaps.map((g) => `- "${g.query.trim()}" · asked ${g.times === 1 ? "once" : `${g.times} times`}, last ${g.lastAsked.slice(0, 10)} (${g.tools.join(", ")})`),
        ]
      : []),
    ...(facts.some(waiting) || notes.length || suggested.length ? ["", "Show each to the person; change one only when they agree, passing their words in confirmed_with."] : []),
  ];
  return { ok: true, data: { facts: page, notes, suggested, gaps }, text: out.join("\n") };
}
