import { csCalls } from "./cs-calls.js";
import { csRoutes } from "./cs-routes.js";
import { openapi } from "./openapi.js";
import type { ExtractorPlugin } from "./plugin.js";
import { tsCalls } from "./ts-calls.js";
import { tsRoutes } from "./ts-routes.js";

/**
 * Bump whenever a plugin changes what it extracts. A repo indexed with an older
 * version is fully re-extracted on its next sync, instead of mixing old and new rules.
 */
export const EXTRACTOR_VERSION = 4;

export const PLUGINS: readonly ExtractorPlugin[] = [openapi, tsRoutes, tsCalls, csRoutes, csCalls];

/** Code languages whose routes and calls are extracted (specs are read for any language). */
export const SEAM_LANGUAGES: ReadonlySet<string> = new Set(PLUGINS.flatMap((plugin) => plugin.languages));
