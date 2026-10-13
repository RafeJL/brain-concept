import { anchorProblems, parseAnchor } from "../../ingest/facts.js";
import type { FactChange } from "../../store/store.js";
import type { Caller } from "../access.js";
import { confirmFact, factLine, readableChecks } from "../facts.js";
import { readableRepos, type ToolDeps, type ToolResult } from "./common.js";
import { canSee } from "./record-fact.js";

export type FactAction = "confirm" | "edit" | "retire";
export const FACT_ACTIONS: readonly FactAction[] = ["confirm", "edit", "retire"];

export interface FactsInput {
  action: FactAction;
  /** The fact's number ("fact #3"). */
  id: number;
  /** edit: the new wording. */
  text?: string;
  /** edit: where the repo enforces it now, as file:lines. */
  anchors?: string[];
  /** The person's words agreeing to this change, said in the conversation. */
  confirmedWith?: string;
}

const MAX_CHARS = 600;

/**
 * A fact's life after it is recorded, from a conversation: confirm a proposed or stale one, reword
 * or re-anchor it, retire it (brain_review lists what's waiting). Every change but an anchor move needs the person's words agreeing to it, so a
 * confirmed fact never says something nobody agreed to. Backs `brain_facts`.
 */
export async function manageFacts(deps: ToolDeps, caller: Caller, input: FactsInput, options: { person: string; now?: () => string }): Promise<ToolResult<unknown>> {
  const readable = await readableRepos(deps, caller);
  const now = (options.now ?? (() => new Date().toISOString()))();
  const words = input.confirmedWith?.trim() || null;
  if ((words?.length ?? 0) > MAX_CHARS) return { ok: false, text: `Keep confirmed_with under ${MAX_CHARS} characters.` };

  const fact = deps.store.getFact(input.id);
  if (!fact || fact.status === "retired" || !canSee(deps, fact, readable)) {
    return { ok: false, text: `No live fact #${input.id}. Facts are numbered in brain_review, brain_get, brain_search and the card.` };
  }
  const needWords = (what: string): ToolResult<never> => ({
    ok: false,
    text: `Nothing changed. Give confirmed_with: the person's words agreeing to ${what}, after you've shown it to them. Never confirm for them.`,
  });
  const shown = () => `- ${factLine(readableChecks([deps.store.getFact(fact.id)!], readable)[0]!)}`;

  switch (input.action) {
    case "confirm": {
      if (fact.status === "confirmed" && !fact.staleSince) return { ok: true, data: fact, text: `Fact #${fact.id} is already confirmed.\n${shown()}` };
      if (!words) return needWords(`fact #${fact.id} as it stands`);
      const commit = fact.repo ? deps.store.getState(fact.repo)?.commit ?? null : null;
      confirmFact(deps.store, fact, options.person, now, commit, words);
      const notes = [
        ...(fact.replaces ? [`Fact #${fact.replaces}, which it replaces, is retired.`] : []),
        ...(fact.staleSince && fact.anchors.length ? ["Its code changed since it was anchored: if the anchors no longer point at it, re-anchor it with action edit."] : []),
      ];
      return { ok: true, data: deps.store.getFact(fact.id), text: [`Confirmed fact #${fact.id}, by ${options.person}.`, shown(), ...notes].join("\n") };
    }
    case "edit": {
      const text = input.text?.trim();
      if (!text && !input.anchors?.length) return { ok: false, text: "Give the new text, new anchors, or both." };
      if (text && text.length > MAX_CHARS) return { ok: false, text: `Keep the fact under ${MAX_CHARS} characters.` };
      const change: FactChange = {};
      if (input.anchors?.length) {
        const repo = fact.repo ? deps.store.getRepo(fact.repo) : undefined;
        const state = fact.repo ? deps.store.getState(fact.repo) : undefined;
        if (!repo || !state) return { ok: false, text: "Anchors point at lines in a repo: this fact is on a system." };
        const unreadable = input.anchors.filter((a) => !parseAnchor(a));
        if (unreadable.length) return { ok: false, text: `Anchors are file:lines, e.g. src/follow.ts:12-20. Can't read: ${unreadable.join(", ")}.` };
        const cites = input.anchors.map((a) => parseAnchor(a)!);
        const problems = await anchorProblems(repo.path, state.commit, cites);
        if (problems.length) return { ok: false, text: `Nothing changed. The anchors don't hold at @${state.commit.slice(0, 7)}: ${problems.join("; ")}.` };
        Object.assign(change, { anchors: cites, anchorCommit: state.commit, staleSince: null, anchorsFound: false });
      }
      let after = "";
      if (text && text !== fact.text) {
        change.text = text;
        if (words) {
          // The person agreed to the new wording: it is theirs, confirmed now.
          Object.assign(change, { status: "confirmed", confirmedBy: options.person, confirmedAt: now, confirmedWith: words });
        } else if (fact.status === "confirmed") {
          // Nobody agreed to the new wording, so it can't stand as confirmed.
          Object.assign(change, { status: "proposed", confirmedBy: null, confirmedAt: null, confirmedWith: null });
          after = " It is proposed again until the person confirms the new wording (action confirm, with their words).";
        }
      }
      deps.store.updateFact(fact.id, change);
      return { ok: true, data: deps.store.getFact(fact.id), text: `Edited fact #${fact.id}.${after}\n${shown()}` };
    }
    case "retire": {
      if (!words) return needWords(`retiring fact #${fact.id}`);
      deps.store.updateFact(fact.id, { status: "retired" });
      return { ok: true, data: fact, text: `Retired fact #${fact.id}: agents no longer see it. It is kept for history.\n- ${fact.text}` };
    }
  }
}
