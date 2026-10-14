import { posix } from "node:path";
import type { FileRecord } from "../core/types.js";

/** Languages that are markup, data or configuration rather than code. */
const NOT_CODE = new Set(["JSON", "YAML", "TOML", "XML", "Markdown", "HTML", "CSS", "SCSS", "Less", "MSBuild", "Shell", "PowerShell", "Dockerfile", "Makefile", "SQL", "Terraform", "Bicep"]);
/** Files that make a folder a project of its own. */
const MANIFEST = /(^|\/)(package\.json|[^/]+\.csproj|[^/]+\.fsproj|composer\.json|pyproject\.toml|setup\.py|go\.mod|Cargo\.toml|pom\.xml|build\.gradle(\.kts)?|Gemfile)$/;
const TEST = /(^|\/)(tests?|spec|specs|__tests__|e2e|testing|fixtures)(\/|$)|[.-]tests?\b|(Functional|Unit|Integration)Tests/i;
const VENDORED = /(^|\/)(node_modules|vendor|vendors|bower_components|dist|build|bin|obj|\.git)\//;
/**
 * Code a tool wrote or a library shipped, not the repo's own: minified and bundled files,
 * resource and service-reference classes, protobuf output, and copies of a library at a version
 * (`jquery-ui-1.10.3.js`, `Scripts/kendo/2014.1.318/`). On atlas-webapp-webapi these were a third
 * of what counted as source (2026-10-13 trial).
 */
const GENERATED = /(\.min\.js|\.bundle\.js|\.designer\.cs|\.g\.cs|\.g\.i\.cs|\.generated\.\w+|_pb2(_grpc)?\.py|\.pb\.go)$|(^|\/)Reference\.cs$/i;
// A folder named for a three-part version, not an API version (`v1/`, `v1.2/` are the repo's own).
const VERSIONED = /(^|\/)\d+\.\d+\.\d+(\.\d+)?\/|[-.]v?\d+\.\d+(\.\d+)*(\.min)?\.js$/;
/** Folders a front end serves static files from; a package copied into one is a library, not a project. */
const ASSET_FOLDER = /(^|\/)(Scripts|scripts|lib|libs|plugins|static|assets|wwwroot|public|Content)\//;
/** What a copied library carries at its root: its own manifest, licence or change log. */
const LIBRARY_MARKER = /(^|\/)(package\.json|bower\.json|composer\.json|(LICEN[CS]E|COPYING|CHANGES|CHANGELOG)(\.\w+)?)$/i;
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

/** Whether a path is a test, spec or fixture. */
export function isTestPath(path: string): boolean {
  return TEST.test(path);
}

/**
 * Folders holding a copy of a third-party library: one inside a folder of static files with its
 * own manifest, licence or change log at its root (`WebApp/Scripts/ckeditor/LICENSE.md`,
 * `WebApp/Scripts/ckeditor-customized/package.json`). The static folder itself never counts.
 */
export function vendoredFolders(paths: readonly string[]): Set<string> {
  const folders = paths.filter((p) => LIBRARY_MARKER.test(p)).map((p) => posix.dirname(p));
  return new Set(folders.filter((dir) => ASSET_FOLDER.test(`${posix.dirname(dir)}/`)));
}

/** Whether a path is vendored or generated code; `folders` from `vendoredFolders`. */
export function isVendored(path: string, folders: ReadonlySet<string> = new Set()): boolean {
  if (VENDORED.test(path) || GENERATED.test(path) || VERSIONED.test(path)) return true;
  for (let dir = posix.dirname(path); dir !== "." && dir !== "/"; dir = posix.dirname(dir)) if (folders.has(dir)) return true;
  return false;
}

/** The repo's own code: a language that is code, outside tests, vendored and generated code. */
export function isSource(file: Pick<FileRecord, "path" | "language">, vendored?: ReadonlySet<string>): boolean {
  return file.language !== null && !NOT_CODE.has(file.language) && !TEST.test(file.path) && !isVendored(file.path, vendored);
}

export function isProjectManifest(path: string, vendored?: ReadonlySet<string>): boolean {
  return MANIFEST.test(path) && !TEST.test(path) && !isVendored(path, vendored) && !vendored?.has(posix.dirname(path));
}

/**
 * What a repo holds, from the files the brain indexed (no AI, no file reads): how much code,
 * which projects, which folders hold it, and the likely entry points. Decides whether the repo is
 * large, and is the map its planning run starts from, so that run doesn't list folders itself.
 */
export function inventory(files: readonly FileRecord[]): Inventory {
  const vendored = vendoredFolders(files.map((f) => f.path));
  const source = files.filter((f) => isSource(f, vendored));
  const projects = [...new Set(files.filter((f) => isProjectManifest(f.path, vendored)).map((f) => posix.dirname(f.path)))].sort();
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
