import { stripCredentials } from "../../core/git.js";
import { BrainError, type Enrolment, type EnrolmentEstimate } from "../../core/types.js";
import { enrolInBackground, estimateEnrolment, estimateText, fileCount, fullyEnrolled, liveStatus, resolveSource, type Source } from "../../ingest/enrol.js";
import type { HookCommand } from "../../ingest/hooks.js";
import type { Caller } from "../access.js";
import { enrolmentLines } from "../enrolment.js";
import type { ToolDeps, ToolResult } from "./common.js";

export interface AddRepoInput {
  /** A local path, a GitHub URL or owner/repo. */
  source: string;
  name?: string;
  /** What its wiki should focus on, in the person's words. */
  note?: string;
}

/**
 * `brain_add_repo`: starts enrolling a repo in the background and answers at once with what to
 * expect. Enrolling runs the same `brain add` a person would, in a process that outlives the MCP
 * session. A repo already enrolled is left alone; one whose enrolment failed or stopped, or that
 * was enrolled but never indexed, is tried again, which redoes only what's missing.
 */
export async function addRepo(deps: ToolDeps, _caller: Caller, input: AddRepoInput, command: HookCommand): Promise<ToolResult<Enrolment>> {
  let source: Source;
  try {
    source = await resolveSource(input.source.trim(), { name: input.name?.trim() || undefined, dbPath: command.dbPath });
  } catch (error) {
    if (error instanceof BrainError) return { ok: false, text: error.message };
    throw error;
  }
  const { name } = source;
  const earlier = deps.store.enrolment(name);
  if (earlier && liveStatus(earlier) === "running") {
    return { ok: true, data: earlier, text: [`${name} is already being enrolled.`, ...enrolmentLines(earlier)].join("\n") };
  }
  const repo = deps.store.getRepo(name);
  if (repo && fullyEnrolled(deps.store, name)) {
    return {
      ok: false,
      text:
        `A repo named "${name}" is already enrolled (from ${repo.remote ?? repo.path}), and it keeps itself up to date. ` +
        "Read it with brain_repo_card. To add a different repo under that name, pass another name.",
    };
  }

  // A local repo (or one already cloned) is sized now; a new clone only once it's cloned.
  let files: number | undefined;
  let estimate: EnrolmentEstimate | undefined;
  if (!source.url || repo) {
    try {
      files = await fileCount(repo?.path ?? source.path, repo?.ref);
    } catch (error) {
      if (error instanceof BrainError) return { ok: false, text: `Can't enrol ${name}: ${error.message}` };
      throw error;
    }
    estimate = estimateEnrolment(deps.store, files);
  }
  const note = input.note?.trim() || undefined;
  const enrolment = enrolInBackground(deps.store, source, { note, files, estimate, command });
  if (enrolment.status === "failed") return { ok: false, text: `Couldn't start enrolling ${name}: ${enrolment.error}.` };

  const from = source.url && !repo ? `cloning it first from ${stripCredentials(source.url)} with the person's own git credentials` : `from ${repo?.path ?? source.path}`;
  return {
    ok: true,
    data: enrolment,
    text: [
      `${repo ? "Trying again to enrol" : "Enrolling"} ${name} in the background, ${from}.`,
      estimate
        ? `It has ${files} files: expect ${estimateText(estimate)}.`
        : "How long it takes depends on its size, known once it's cloned: a few minutes for a small repo, up to about half an hour " +
          "for one with thousands of files. Its card gives an estimate then.",
      "It carries on if this session ends.",
      `It isn't ready to plan from until it's done: brain_repo_card (repo "${name}") says where it has got to, when it's ready, or what failed.`,
      "New sessions list it with the brain's other repos; in this one, brain_repo_card finds it.",
    ].join("\n"),
  };
}
