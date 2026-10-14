import { hooksLogPath } from "../config.js";
import type { Enrolment } from "../core/types.js";
import { estimateText, liveStatus } from "../ingest/enrol.js";
import type { Caller } from "./access.js";
import type { ToolDeps } from "./tools/common.js";

/**
 * What agents are told about a repo being enrolled: where it has got to, or what failed and how to
 * try again. A tool call can't run for the hour a large repo takes, and MCP shows no progress
 * between calls, so people find out by asking: the card, or any read tool that reaches the repo.
 */

/** The enrolment of a name the caller may read. Unreadable ones get the same answer as unknown ones. */
export async function readableEnrolment(deps: ToolDeps, caller: Caller, name: string): Promise<Enrolment | undefined> {
  const enrolment = deps.store.enrolment(name);
  if (!enrolment) return undefined;
  return (await deps.access.readableRepos(caller, [name])).has(name) ? enrolment : undefined;
}

/** Still going, failed or stopped: anything but finished. */
export function unfinished(enrolment: Enrolment | undefined): enrolment is Enrolment {
  return enrolment !== undefined && liveStatus(enrolment) !== "done";
}

/** "just now", "6 min ago", "2 h 5 min ago". */
function ago(at: string, now: number): string {
  const minutes = Math.floor((now - Date.parse(at)) / 60_000);
  return minutes < 1 ? "just now" : `${took(minutes)} ago`;
}

function took(minutes: number): string {
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h${minutes % 60 ? ` ${minutes % 60} min` : ""}`;
}

/** A source as a terminal command takes it. */
function quoted(source: string): string {
  return `"${source.replace(/"/g, "")}"`;
}

/**
 * Where an unfinished enrolment has got to and how long it should take; or, when it failed or its
 * process ended, what went wrong and how to try again. Empty for one that finished.
 */
export function enrolmentLines(e: Enrolment, now = Date.now()): string[] {
  const status = liveStatus(e, now);
  if (status === "done") return [];
  if (status === "running") {
    return [
      `Being enrolled: ${e.step} · started ${ago(e.startedAt, now)}`,
      e.estimate ? `Expect ${estimateText(e.estimate)} in all.` : "How long it takes depends on its size, known once it's cloned.",
      "Not ready to plan from yet: its wiki and links are still being written. Check its card again for progress.",
    ];
  }
  const what =
    status === "stopped"
      ? `Enrolment stopped before it finished, while ${e.step} (${ago(e.updatedAt, now)}): the process doing it ended.`
      : `Enrolment failed while ${e.step} (${ago(e.finishedAt ?? e.updatedAt, now)})${e.error ? `: ${e.error}` : "."}`;
  return [
    what,
    `Not ready to plan from. To try again, call brain_add_repo with source ${quoted(e.source)} (in a terminal: brain add ${quoted(e.source)}); ` +
      `it redoes only what's missing. Details are in ${hooksLogPath()}.`,
  ];
}

/**
 * "Enrolled 5 min ago, in 4 min for $0.62: ready." for one that finished within `within`; null
 * otherwise. One that ran no AI (`brain add --no-ai`) has no wiki or links, so isn't called ready.
 */
export function readyLine(e: Enrolment, now = Date.now(), within = 24 * 60 * 60_000): string | null {
  if (e.status !== "done" || !e.finishedAt || now - Date.parse(e.finishedAt) > within) return null;
  const minutes = Math.max(1, Math.round((Date.parse(e.finishedAt) - Date.parse(e.startedAt)) / 60_000));
  const ended = e.costUsd > 0 ? ` for $${e.costUsd.toFixed(2)}: ready.` : ", indexed only.";
  return `Enrolled ${ago(e.finishedAt, now)}, in ${took(minutes)}${ended}`;
}

/** The card of a repo not indexed yet: being cloned or indexed, or failed before it was. */
export function enrolmentCard(e: Enrolment, now = Date.now()): string {
  const status = liveStatus(e, now);
  const headline = status === "running" ? "being enrolled · not ready yet" : `enrolment ${status} · not ready`;
  return [`${e.repo}  ${headline}`, `Source: ${e.source}`, ...enrolmentLines(e, now)].join("\n");
}
