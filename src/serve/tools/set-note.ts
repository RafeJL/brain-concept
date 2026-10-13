import type { RepoNote } from "../../core/types.js";
import type { Caller } from "../access.js";
import { requireSyncedRepo, type ToolDeps, type ToolResult } from "./common.js";

export interface NoteInput {
  repo: string;
  /** What the wiki should focus on, e.g. "Ordering and Basket matter most; ignore the e2e folder". */
  text?: string;
  /** The person's words agreeing to this note, said in the conversation. Given, it steers the wiki; omitted, it waits proposed. */
  confirmedWith?: string;
  /** Confirm the note already proposed on the repo instead of giving a new one. */
  confirmProposed?: boolean;
}

export interface NoteSet {
  outcome: "confirmed" | "proposed";
  note: RepoNote;
}

const MAX_CHARS = 500;

/**
 * Sets the note that steers a repo's wiki, as `brain note` does, from a conversation. With the
 * person's words agreeing (`confirmedWith`) it steers the wiki; without, it waits as proposed and
 * steers nothing until a person confirms it. Over MCP the client asks the person to allow every
 * call. Backs `brain_set_note`.
 */
export async function setNote(deps: ToolDeps, caller: Caller, input: NoteInput, options: { person: string; now?: () => string }): Promise<ToolResult<NoteSet>> {
  const found = await requireSyncedRepo(deps, caller, input.repo);
  if (!found.ok) return found;
  const { repo } = found;
  const words = input.confirmedWith?.trim() || undefined;
  const proposed = input.confirmProposed ? repo.proposedNote : null;
  if (input.confirmProposed && !proposed) return { ok: false, text: `${repo.name} has no proposed note to confirm.` };
  if (input.confirmProposed && !words) return { ok: false, text: "Give confirmed_with: the person's words agreeing to the proposed note, after you've shown it to them." };
  const text = proposed ? proposed.text : input.text?.trim() ?? "";
  if (!text) return { ok: false, text: "Give the note: what the repo's wiki should focus on." };
  if (text.length > MAX_CHARS || (words?.length ?? 0) > MAX_CHARS) return { ok: false, text: `Keep the note and confirmed_with under ${MAX_CHARS} characters.` };

  const at = (options.now ?? (() => new Date().toISOString()))();
  if (words) {
    const note: RepoNote = { text, by: options.person, at, with: words };
    deps.store.setRepoNote(repo.name, note);
    deps.store.setProposedNote(repo.name, null);
    const replaced = repo.note && !proposed ? ` It replaces "${repo.note.text}".` : "";
    return {
      ok: true,
      data: { outcome: "confirmed", note },
      text: `Set ${repo.name}'s note, from ${note.by}: "${note.text}".${replaced} The next sync plans its wiki with it, and each page follows it when next rewritten. It can't switch off the checks.`,
    };
  }
  const note: RepoNote = { text, by: options.person, at };
  deps.store.setProposedNote(repo.name, note);
  return {
    ok: true,
    data: { outcome: "proposed", note },
    text:
      `Stored as a proposed note on ${repo.name}, not confirmed: no confirmed_with was given, so it steers nothing yet.` +
      `${repo.note ? ` The current note stands: "${repo.note.text}".` : ""} When the person agrees to it, call brain_set_note with confirm_proposed and their words.`,
  };
}
