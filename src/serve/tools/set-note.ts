import type { RepoNote } from "../../core/types.js";
import type { Caller } from "../access.js";
import { brainCommand, requireSyncedRepo, type ToolDeps, type ToolResult } from "./common.js";
import type { Confirm, ConfirmAnswer } from "./record-fact.js";

export interface NoteInput {
  repo: string;
  /** What the wiki should focus on, e.g. "Ordering and Basket matter most; ignore the e2e folder". */
  text: string;
  /** Store it as proposed without asking: for when the person asked for it but can't get the dialog. */
  propose?: boolean;
}

export interface NoteSet {
  outcome: "confirmed" | "proposed" | "declined";
  note: RepoNote | null;
}

const MAX_CHARS = 500;

/**
 * Sets the note that steers a repo's wiki, as `brain note` does, from a conversation. The person
 * confirms it in a dialog, as with facts; declined, nothing changes; where they can't be asked,
 * it waits as proposed until `brain note <repo> --confirm`. Only a confirmed note steers the
 * wiki. Backs `brain_set_note`.
 */
export async function setNote(
  deps: ToolDeps,
  caller: Caller,
  input: NoteInput,
  options: { confirm: Confirm; person: string; now?: () => string },
): Promise<ToolResult<NoteSet>> {
  const text = input.text.trim();
  if (!text) return { ok: false, text: "Give the note: what the repo's wiki should focus on." };
  if (text.length > MAX_CHARS) return { ok: false, text: `Keep the note under ${MAX_CHARS} characters.` };
  const found = await requireSyncedRepo(deps, caller, input.repo);
  if (!found.ok) return found;
  const { repo } = found;

  const message = [
    `Steer ${repo.name}'s wiki with this note?`,
    "",
    `"${text}"`,
    "",
    repo.note ? `It replaces the current note: "${repo.note.text}" (${repo.note.by}).` : "The repo has no note yet.",
    "The next sync plans the wiki again with it (which pages it has), and each page follows it when next rewritten. It can't switch off the checks.",
    "",
    "Accept to set it as yours (you can edit it). Decline to change nothing.",
  ].join("\n");
  const answer: ConfirmAnswer = input.propose ? { action: "unavailable" } : await options.confirm({ message, text, statedBy: options.person, label: "Note" });
  if (answer.action === "decline") {
    const why = answer.automatic ? "The dialog was declined within a second, so it was most likely never shown. " : "";
    return {
      ok: true,
      data: { outcome: "declined", note: null },
      text: `Not set: the dialog came back declined. ${why}If they want it, call brain_set_note again with propose set to true, and they confirm it in a terminal with ${brainCommand(`note ${repo.name} --confirm`)}.`,
    };
  }

  const at = (options.now ?? (() => new Date().toISOString()))();
  if (answer.action === "accept") {
    const note = { text: answer.text.trim() || text, by: answer.statedBy.trim() || options.person, at };
    deps.store.setRepoNote(repo.name, note);
    deps.store.setProposedNote(repo.name, null);
    return { ok: true, data: { outcome: "confirmed", note }, text: `Set ${repo.name}'s note, from ${note.by}: "${note.text}". The next sync plans its wiki with it, and each page follows it when next rewritten.` };
  }
  const note = { text, by: options.person, at };
  deps.store.setProposedNote(repo.name, note);
  return {
    ok: true,
    data: { outcome: "proposed", note },
    text: `Stored as a proposed note on ${repo.name}: the person couldn't be asked here, so it steers nothing yet. Confirm it with: ${brainCommand(`note ${repo.name} --confirm`)}`,
  };
}
