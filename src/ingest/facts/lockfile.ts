import { fileName, isRepoOwn, type FactReader } from "./reader.js";

const MANAGERS: Record<string, string> = {
  "package-lock.json": "npm",
  "npm-shrinkwrap.json": "npm",
  "pnpm-lock.yaml": "pnpm",
  "yarn.lock": "yarn",
  "bun.lock": "bun",
  "bun.lockb": "bun",
};

/** Which package manager a folder uses. Lockfiles can be many megabytes, so they're never read. */
export const lockfile: FactReader = {
  name: "lockfile",
  wants: (path) => Object.hasOwn(MANAGERS, fileName(path)) && isRepoOwn(path),
  needsContent: false,
  read: (path) => [{ kind: "package-manager", name: fileName(path), value: MANAGERS[fileName(path)]!, line: null }],
};
