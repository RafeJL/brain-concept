import { posix } from "node:path";
import type { FileRecord } from "../core/types.js";

/** Languages that are markup, data or configuration rather than code. */
const NOT_CODE = new Set(["JSON", "YAML", "TOML", "XML", "Markdown", "HTML", "CSS", "SCSS", "Less", "MSBuild", "Shell", "PowerShell", "Dockerfile", "Makefile", "SQL", "Terraform", "Bicep"]);
/** Files that make a folder a project of its own. */
const MANIFEST = /(^|\/)(package\.json|[^/]+\.csproj|[^/]+\.fsproj|composer\.json|pyproject\.toml|setup\.py|go\.mod|Cargo\.toml|pom\.xml|build\.gradle(\.kts)?|Gemfile)$/;
const TEST = /(^|\/)(tests?|spec|specs|__tests__|e2e|testing|fixtures)(\/|$)|[.-]tests?\b|(Functional|Unit|Integration)Tests/i;
const VENDORED = /(^|\/)(node_modules|vendor|dist|build|bin|obj|\.git)\//;
const ENTRY = /(^|\/)(Program\.cs|Startup\.cs|main\.[a-z]+|index\.[jt]sx?|app\.[a-z]+|server\.[jt]s|manage\.py|artisan|routes\/(api|web)\.php)$/i;

/**
 * Past either of these a repo is large: it gets a page plan and a page per area. Measured on the
 * samples (2026-10-13): eShop has 573 source files outside tests in 20 projects; the next largest,
 * laravel-api, 96 in one.
 */
const LARGE_SOURCE_FILES = 200;
const LARGE_PROJECTS = 4;
/** Folders listed in the map, at most. */
const MAX_FOLDERS = 150;

export interface Inventory {
  /** Code files outside tests and vendored folders. */
  sourceFiles: number;
  /** Folders holding a project manifest, outside tests. */
  projects: string[];
  large: boolean;
  /** The map given to the planning run. */
  text: string;
}

export function isSource(file: Pick<FileRecord, "path" | "language">): boolean {
  return file.language !== null && !NOT_CODE.has(file.language) && !TEST.test(file.path) && !VENDORED.test(file.path);
}

export function isProjectManifest(path: string): boolean {
  return MANIFEST.test(path) && !TEST.test(path) && !VENDORED.test(path);
}

/**
 * What a repo holds, from the files the brain indexed (no AI, no file reads): how much code,
 * which projects, which folders hold it, and the likely entry points. Decides whether the repo is
 * large, and is the map its planning run starts from, so that run doesn't list folders itself.
 */
export function inventory(files: readonly FileRecord[]): Inventory {
  const source = files.filter(isSource);
  const projects = [...new Set(files.filter((f) => isProjectManifest(f.path)).map((f) => posix.dirname(f.path)))].sort();
  const languages = new Map<string, number>();
  const folders = new Map<string, number>();
  for (const file of source) {
    languages.set(file.language!, (languages.get(file.language!) ?? 0) + 1);
    const parts = file.path.split("/").slice(0, -1);
    for (let depth = 1; depth <= Math.min(3, parts.length); depth++) {
      const folder = parts.slice(0, depth).join("/");
      folders.set(folder, (folders.get(folder) ?? 0) + 1);
    }
  }
  // Every project's folder, however small, and any other folder with a few files.
  const listed = [...folders].filter(([folder, n]) => n >= 3 || projects.includes(folder)).sort(([a], [b]) => a.localeCompare(b)).slice(0, MAX_FOLDERS);
  const entries = source.filter((f) => ENTRY.test(f.path)).map((f) => f.path).slice(0, 40);
  const text = [
    `Source files outside tests: ${source.length} (${[...languages].sort((a, b) => b[1] - a[1]).map(([l, n]) => `${l} ${n}`).join(", ")})`,
    `Projects (folders with a manifest): ${projects.join(", ") || "none"}`,
    "Folders and how many source files each holds:",
    ...listed.map(([folder, n]) => `- ${folder}: ${n}`),
    `Likely entry points: ${entries.join(", ") || "none found"}`,
  ].join("\n");
  return { sourceFiles: source.length, projects, large: source.length >= LARGE_SOURCE_FILES || projects.length >= LARGE_PROJECTS, text };
}
