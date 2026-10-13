import { cleanPath } from "../core/citations.js";
import type { FactCheck, FactRecord, Verdict } from "../core/facts.js";
import { changedFiles, withWorktree } from "../core/git.js";
import { BrainError } from "../core/types.js";
import { requireRepo } from "../ingest/registry.js";
import type { Store } from "../store/store.js";
import { claimProblem, fileReader } from "./check.js";
import { DEFAULT_MODEL } from "./generate.js";
import { prompt } from "./prompts.js";
import type { Runner } from "./runner.js";

/** Lines that agree become a fact's anchors, at most this many. */
const MAX_FOUND_ANCHORS = 3;

const CITE = {
  type: "object",
  properties: { file: { type: "string" }, start: { type: "integer" }, end: { type: "integer" } },
  required: ["file", "start", "end"],
};

const SCHEMA = {
  type: "object",
  properties: {
    checks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          fact: { type: "integer" },
          verdict: { type: "string", enum: ["agrees", "contradicts", "absent"] },
          summary: { type: "string" },
          cites: { type: "array", items: CITE },
          looked_at: { type: "array", items: { type: "string" } },
        },
        required: ["fact", "verdict", "summary", "cites", "looked_at"],
      },
    },
  },
  required: ["checks"],
};

/** One entry of the AI's answer, before verification. */
interface FoundCheck {
  fact: number;
  verdict: Exclude<Verdict, "unclear">;
  summary: string;
  cites: { file: string; start: number; end: number }[];
  looked_at: string[];
}

export interface FactChecksResult {
  repo: string;
  commit: string;
  /** The checks made in this run; empty when no fact needed one (no AI run). */
  checked: FactCheck[];
  costUsd: number;
  durationMs: number;
}

/**
 * Has Claude Code check the facts people stated about a repo, and about the system it is part of,
 * against the repo's code at the indexed commit: does the code enforce each one, contradict it,
 * or have nothing for it? Each answer is verified against the lines it cites, like wiki claims;
 * one that fails is stored as unclear rather than tried again on every sync. A fact is checked
 * when it never has been here, when its text changed, or when a file the last check read changed.
 * Lines that agree become the anchors of a repo fact nobody anchored by hand. Never changes what a
 * fact says or whether it is confirmed.
 */
export async function checkFacts(store: Store, runner: Runner, name: string, options: { model?: string; full?: boolean } = {}): Promise<FactChecksResult> {
  const repo = requireRepo(store, name);
  const state = store.getState(name);
  if (!state) throw new BrainError(`"${name}" has not been synced yet. Run: brain sync ${name}`);
  const system = store.systems().find((s) => s.repos.includes(name));
  const facts = store.facts({ repos: [name], systems: system ? [system.name] : [] });

  const changed = new Map<string, Set<string> | null>();
  const filesChangedSince = async (commit: string) => {
    if (!changed.has(commit)) {
      const files = await changedFiles(repo.path, commit, state.commit);
      changed.set(commit, files && new Set(files.map((f) => f.path)));
    }
    return changed.get(commit)!;
  };
  const due: FactRecord[] = [];
  for (const fact of facts) {
    const last = fact.checks.find((c) => c.repo === name);
    if (options.full || !last || last.factText !== fact.text) {
      due.push(fact);
      continue;
    }
    if (last.commit === state.commit) continue;
    const since = await filesChangedSince(last.commit);
    if (!since || [...last.cites.map((c) => c.path), ...last.lookedAt].some((path) => since.has(path))) due.push(fact);
  }
  if (due.length === 0) return { repo: name, commit: state.commit, checked: [], costUsd: 0, durationMs: 0 };

  const listed = due
    .map((f) => `- Fact ${f.id} (${f.kind}, on ${f.repo ? "this repository" : `the ${f.system} system, of which this repository is one part`}): ${f.text}`)
    .join("\n");
  const { checked, costUsd, durationMs } = await withWorktree(repo.path, state.commit, async (cwd) => {
    const run = await runner.run<{ checks?: unknown }>({ cwd, prompt: prompt("check-facts", { facts: listed }), schema: SCHEMA, model: options.model ?? DEFAULT_MODEL });
    if (!Array.isArray(run.output?.checks)) throw new BrainError("The AI's fact checks were malformed. Nothing was stored.");
    const answers = new Map((run.output.checks as FoundCheck[]).filter((c) => typeof c?.fact === "number").map((c) => [c.fact, c]));
    const now = new Date().toISOString();
    const each = run.costUsd / due.length;
    const linesOf = fileReader(cwd);
    const checked = due.map((fact): FactCheck => {
      const base = { fact: fact.id, repo: name, commit: state.commit, factText: fact.text, checkedAt: now, costUsd: each };
      const answer = answers.get(fact.id);
      if (!answer) return { ...base, verdict: "unclear", summary: "the check gave no answer for it", cites: [], lookedAt: [] };
      return { ...base, ...verified(answer, cwd, linesOf) };
    });
    return { checked, costUsd: run.costUsd, durationMs: run.durationMs };
  });

  store.saveFactChecks(checked);
  for (const check of checked) foundAnchors(store, facts.find((f) => f.id === check.fact)!, check);
  return { repo: name, commit: state.commit, checked, costUsd, durationMs };
}

/** The answer as a check, or as unclear with the reason when the code doesn't bear it out. */
function verified(answer: FoundCheck, root: string, linesOf: (path: string) => string[] | null): Pick<FactCheck, "verdict" | "summary" | "cites" | "lookedAt"> {
  const cites = (Array.isArray(answer.cites) ? answer.cites : []).map((c) => ({ path: cleanPath(String(c.file)), start: c.start, end: c.end }));
  const lookedAt = (Array.isArray(answer.looked_at) ? answer.looked_at : []).map((p) => cleanPath(String(p)));
  const summary = typeof answer.summary === "string" ? answer.summary.trim() : "";
  const unclear = (reason: string) => ({ verdict: "unclear" as const, summary: `the check's answer didn't hold up: ${reason}`, cites: [], lookedAt });
  if (!["agrees", "contradicts", "absent"].includes(answer.verdict) || !summary) return unclear("malformed answer");
  if (answer.verdict === "absent") {
    if (lookedAt.length === 0) return unclear("it named no files it looked at");
    const missing = lookedAt.find((path) => !linesOf(path));
    if (missing) return unclear(`it looked at ${missing}, which doesn't exist`);
    return { verdict: "absent", summary, cites: [], lookedAt };
  }
  if (cites.length === 0) return unclear(`it says the code ${answer.verdict === "agrees" ? "agrees" : "disagrees"} but cites no lines`);
  const problem = claimProblem(summary, cites, root, linesOf);
  return problem ? unclear(problem) : { verdict: answer.verdict, summary, cites, lookedAt };
}

/**
 * A repo fact a person didn't anchor takes the lines that agree with it as anchors, so a later
 * change to them shows. A re-check that still agrees clears the stale mark that change set and
 * moves the anchors to the lines now cited. Anchors a person set are left alone.
 */
function foundAnchors(store: Store, fact: FactRecord, check: FactCheck): void {
  if (fact.repo !== check.repo || (fact.anchors.length > 0 && !fact.anchorsFound) || check.verdict !== "agrees") return;
  store.updateFact(fact.id, { anchors: check.cites.slice(0, MAX_FOUND_ANCHORS), anchorCommit: check.commit, anchorsFound: true, staleSince: null });
}
