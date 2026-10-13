import { basename } from "node:path";
import { defaultRef, remoteUrl, repoRoot, resolveCommit } from "../core/git.js";
import { BrainError, type RepoNote, type RepoRecord } from "../core/types.js";
import type { Store } from "../store/store.js";

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface EnrolOptions {
  path: string;
  name?: string;
  ref?: string;
  /** A steering note for the repo's wiki, from the person enrolling it. */
  note?: RepoNote;
}

/** Throws unless `name` can name a repo: it is also a folder name and goes into hook scripts. */
export function checkRepoName(name: string): string {
  if (!NAME.test(name)) throw new BrainError(`"${name}" is not a valid repo name. Use letters, digits, ".", "_" or "-".`);
  return name;
}

/** Adds a repo to the registry. Enrolling is all it takes for a repo to join; no code changes. */
export async function enrolRepo(store: Store, options: EnrolOptions): Promise<RepoRecord> {
  const path = await repoRoot(options.path);
  const name = checkRepoName(options.name ?? basename(path));
  if (store.getRepo(name)) throw new BrainError(`A repo named "${name}" is already enrolled.`);

  const ref = options.ref ?? (await defaultRef(path));
  await resolveCommit(path, ref);

  const repo: RepoRecord = {
    name,
    path,
    ref,
    remote: await remoteUrl(path),
    enrolledAt: new Date().toISOString(),
    note: options.note ?? null,
    proposedNote: null,
  };
  store.addRepo(repo);
  return repo;
}

export function removeRepo(store: Store, name: string): void {
  if (!store.removeRepo(name)) throw new BrainError(`No repo named "${name}" is enrolled.`);
}

export function requireRepo(store: Store, name: string): RepoRecord {
  const repo = store.getRepo(name);
  if (!repo) throw new BrainError(`No repo named "${name}" is enrolled.`);
  return repo;
}

/**
 * Points a repo at a different ref, e.g. from `main` to `origin/main`. Facts stay until the next
 * sync, which only re-reads what differs.
 */
export async function setRepoRef(store: Store, name: string, ref: string): Promise<void> {
  const repo = requireRepo(store, name);
  await resolveCommit(repo.path, ref);
  store.setRepoRef(name, ref);
}

/**
 * Sets the note that steers a repo's wiki ("Ordering and Basket matter most"), or clears it with
 * null. Any proposed note is settled by it. The next sync plans the wiki again with it.
 */
export function setRepoNote(store: Store, name: string, note: RepoNote | null): void {
  requireRepo(store, name);
  store.setRepoNote(name, note);
  store.setProposedNote(name, null);
}

/** Applies the note an agent proposed, as confirmed by `by`. */
export function confirmProposedNote(store: Store, name: string, by: string): RepoNote {
  const proposed = requireRepo(store, name).proposedNote;
  if (!proposed) throw new BrainError(`${name} has no proposed note to confirm.`);
  const note = { text: proposed.text, by, at: new Date().toISOString() };
  setRepoNote(store, name, note);
  return note;
}
