import type { Citation } from "./citations.js";

/** What a person stated: a business rule, a term, what something is for, a decision, or the answer to a question. */
export type FactKind = "rule" | "term" | "purpose" | "decision" | "answer";
export const FACT_KINDS: readonly FactKind[] = ["rule", "term", "purpose", "decision", "answer"];

/**
 * "proposed": recorded without the person confirming it. "confirmed": a person agreed to it. "retired": no longer true, kept for history. Either of the first two can
 * also be stale (`staleSince`): code it is anchored to has changed since.
 */
export type FactStatus = "proposed" | "confirmed" | "retired";

/** How a confirmed fact was made: by a person, not by Claude Code. */
export const HUMAN_TIER = "human-reviewed";

/** A fact a person stated, about one repo or one system. */
export interface FactRecord {
  id: number;
  /** Exactly one of repo and system is set. */
  repo: string | null;
  system: string | null;
  kind: FactKind;
  /** The fact, in product language. */
  text: string;
  /** What the person said, in their words. */
  quote: string;
  statedBy: string;
  ticket: string | null;
  /** Lines in the repo where it is enforced, checked to exist at `anchorCommit`. Repo facts only. */
  anchors: Citation[];
  anchorCommit: string | null;
  status: FactStatus;
  recordedAt: string;
  confirmedBy: string | null;
  confirmedAt: string | null;
  /**
   * The person's words agreeing to it, when they confirmed it in a conversation with an agent
   * ("yes, record that"). Null when confirmed in a terminal, or in the dialog before B5.
   */
  confirmedWith: string | null;
  /** The commit at which an anchored line changed, making the fact stale. */
  staleSince: string | null;
  /** The earlier fact this one replaces, retired once this one is confirmed. */
  replaces: number | null;
  /** True when the anchors came from a check that found the code agreeing, not from a person. */
  anchorsFound: boolean;
  /** What Claude Code found the code does about it, per repo checked. */
  checks: FactCheck[];
}

export type NewFact = Omit<FactRecord, "id" | "staleSince" | "anchorsFound" | "checks">;

/**
 * What the code does about a fact, in one repo: enforces it ("agrees"), does something else
 * ("contradicts"), or has nothing for it ("absent": not built, or not a code matter). "unclear"
 * when the run's answer didn't hold up against the code.
 */
export type Verdict = "agrees" | "contradicts" | "absent" | "unclear";

export interface FactCheck {
  fact: number;
  repo: string;
  /** The commit the check read. */
  commit: string;
  verdict: Verdict;
  /** One sentence on what the code does about it, or why the check is unclear. */
  summary: string;
  /** The lines that show it (agrees, contradicts). */
  cites: Citation[];
  /** The files the run read to decide. */
  lookedAt: string[];
  /** The fact's text when it was checked, so an edit is checked again. */
  factText: string;
  checkedAt: string;
  costUsd: number;
}

/** A search the brain couldn't answer, logged so owners know what is worth writing down. */
export interface Gap {
  tool: string;
  query: string;
  /** The repos the search was limited to, if any. */
  repos: string[];
  askedAt: string;
}

/** Gaps grouped by question, most asked first. */
export interface GapSummary {
  query: string;
  tools: string[];
  times: number;
  lastAsked: string;
}
