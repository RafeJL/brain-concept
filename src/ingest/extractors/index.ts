import { openapi } from "./openapi.js";
import type { ExtractorPlugin } from "./plugin.js";
import { tsCalls } from "./ts-calls.js";
import { tsRoutes } from "./ts-routes.js";

/**
 * Bump whenever a plugin changes what it extracts. A repo indexed with an older version is fully
 * re-extracted on its next sync, instead of mixing old and new rules.
 */
export const EXTRACTOR_VERSION = 1;

export const PLUGINS: readonly ExtractorPlugin[] = [openapi, tsRoutes, tsCalls];

/** Languages whose routes and calls are extracted from code (specs are read for any language). */
export const SEAM_LANGUAGES: ReadonlySet<string> = new Set(["TypeScript", "JavaScript"]);

/** Languages we can recognise as application code, to report which ones have no extractor yet. */
export const CODE_LANGUAGES: ReadonlySet<string> = new Set([
  "TypeScript", "JavaScript", "C#", "F#", "Visual Basic", "Java", "Kotlin", "Scala", "Groovy",
  "Python", "Ruby", "PHP", "Go", "Rust", "Swift", "Dart", "C", "C++",
]);
