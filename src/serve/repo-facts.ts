import type { DotnetProjectKind, Fact } from "../core/facts.js";
import { CODEOWNERS_PATHS } from "../ingest/facts/codeowners.js";
import { folderOf } from "../ingest/facts/reader.js";

/** A value and where the repo declares it. */
export interface Cited<T> {
  value: T;
  path: string;
  line: number | null;
}

export interface Script {
  name: string;
  command: string;
  line: number | null;
}

/** One package.json and how to run its scripts. */
export interface PackageScripts {
  path: string;
  /** "" for the repo root. */
  folder: string;
  /** From the nearest lockfile at or above the folder; npm when there is none. */
  manager: string;
  /** Scripts people usually want (build, test, ...), in that order. */
  common: Script[];
  others: Script[];
}

export interface DotnetBuild {
  /** The shallowest solution file, which `dotnet build` and `dotnet test` should be given. */
  solution: string | null;
  projects: Record<DotnetProjectKind, number>;
}

export interface Owners {
  path: string;
  /** Owners of `*`, from the last such rule (the one GitHub applies). Empty when not set. */
  fallback: Cited<string[]> | null;
  pathRules: number;
}

export interface RepoFacts {
  summary: Cited<string> | null;
  packages: PackageScripts[];
  dotnet: DotnetBuild | null;
  owners: Owners | null;
}

const COMMON_SCRIPTS = ["build", "test", "lint", "typecheck", "start", "dev"] as const;

/** What a repo says about itself: how to build and test it, who owns it, what it is. */
export function repoFacts(facts: readonly Fact[]): RepoFacts {
  const summary = facts.find((f) => f.kind === "summary");
  return {
    summary: summary ? { value: summary.value, path: summary.path, line: summary.line } : null,
    packages: packageScripts(facts),
    dotnet: dotnetBuild(facts),
    owners: owners(facts),
  };
}

/** Root first, then shallower folders, then by name. */
function byDepth(a: string, b: string): number {
  return depth(a) - depth(b) || a.localeCompare(b);
}

function depth(path: string): number {
  return path.split("/").length;
}

function packageScripts(facts: readonly Fact[]): PackageScripts[] {
  const managers = new Map(facts.filter((f) => f.kind === "package-manager").map((f) => [folderOf(f.path), f.value]));
  const managerFor = (folder: string): string => {
    for (let at = folder; ; at = folderOf(at)) {
      const found = managers.get(at);
      if (found) return found;
      if (at === "") return "npm";
    }
  };

  const manifests = [...new Set(facts.filter((f) => f.path.endsWith("package.json")).map((f) => f.path))].sort(byDepth);
  return manifests.map((path) => {
    const scripts = facts
      .filter((f) => f.path === path && f.kind === "script")
      .map((f): Script => ({ name: f.name, command: f.value, line: f.line }));
    const isCommon = (s: Script) => (COMMON_SCRIPTS as readonly string[]).includes(s.name);
    return {
      path,
      folder: folderOf(path),
      manager: managerFor(folderOf(path)),
      common: COMMON_SCRIPTS.flatMap((name) => scripts.filter((s) => s.name === name)),
      others: scripts.filter((s) => !isCommon(s)),
    };
  });
}

function dotnetBuild(facts: readonly Fact[]): DotnetBuild | null {
  const projects = facts.filter((f) => f.kind === "dotnet-project");
  const solutions = facts.filter((f) => f.kind === "dotnet-solution").map((f) => f.path).sort(byDepth);
  if (projects.length === 0 && solutions.length === 0) return null;
  const counts: Record<DotnetProjectKind, number> = { web: 0, app: 0, library: 0, test: 0 };
  for (const project of projects) counts[project.value as DotnetProjectKind]++;
  return { solution: solutions[0] ?? null, projects: counts };
}

const MATCH_ALL = new Set(["*", "**", "/**"]);

function owners(facts: readonly Fact[]): Owners | null {
  const rules = facts.filter((f) => f.kind === "owners");
  const path = CODEOWNERS_PATHS.find((candidate) => rules.some((rule) => rule.path === candidate));
  if (!path) return null;
  const used = rules.filter((rule) => rule.path === path);
  const fallback = used.filter((rule) => MATCH_ALL.has(rule.name)).at(-1);
  return {
    path,
    fallback: fallback ? { value: fallback.value.split(" ").filter(Boolean), path, line: fallback.line } : null,
    pathRules: used.filter((rule) => !MATCH_ALL.has(rule.name)).length,
  };
}

/** `npm run build`, `pnpm run test`, ... */
export function runCommand(pkg: PackageScripts, script: Script): string {
  return `${pkg.manager} run ${script.name}`;
}
