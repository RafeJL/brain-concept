import { basename } from "node:path";
import { defaultRef, remoteUrl, repoRoot, resolveCommit } from "../core/git.js";
import { BrainError, type RepoRecord } from "../core/types.js";
import type { Store } from "../store/store.js";

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface EnrolOptions {
  path: string;
  name?: string;
  ref?: string;
}

/** Adds a repo to the registry. Enrolling is all it takes for a repo to join; no code changes. */
export async function enrolRepo(store: Store, options: EnrolOptions): Promise<RepoRecord> {
  const path = await repoRoot(options.path);
  const name = options.name ?? basename(path);
  if (!NAME.test(name)) {
    throw new BrainError(`"${name}" is not a valid repo name. Use letters, digits, ".", "_" or "-".`);
  }
  if (store.getRepo(name)) throw new BrainError(`A repo named "${name}" is already enrolled.`);

  const ref = options.ref ?? (await defaultRef(path));
  await resolveCommit(path, ref);

  const repo: RepoRecord = {
    name,
    path,
    ref,
    remote: await remoteUrl(path),
    enrolledAt: new Date().toISOString(),
  };
  store.addRepo(repo);
  return repo;
}

export function removeRepo(store: Store, name: string): void {
  if (!store.removeRepo(name)) throw new BrainError(`No repo named "${name}" is enrolled.`);
}
