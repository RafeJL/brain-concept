import { isMap, isScalar, isSeq, LineCounter, parseDocument, type Pair, type YAMLMap } from "yaml";
import { joinPaths, methodFromVerb, stripOrigin } from "../../core/http.js";
import type { SeamDraft } from "../../core/seams.js";
import { routeSeam, type ExtractorPlugin } from "./plugin.js";

const PLUGIN = "openapi";
const SPEC_FILE = /\.(ya?ml|json)$/i;
const NOT_A_SPEC = /(^|\/)(node_modules|package(-lock)?\.json$|tsconfig[^/]*\.json$|\.github\/)/;
const LOOKS_LIKE_SPEC = /["']?\b(openapi|swagger)\b["']?\s*:\s*["']?[23]\./;

/**
 * Routes declared in OpenAPI 3 / Swagger 2 specs, in any backend language. The most reliable
 * source we have: the spec states the contract directly.
 */
function extractSpec(source: string): SeamDraft[] {
  if (!LOOKS_LIKE_SPEC.test(source.slice(0, 4000))) return [];
  const lineCounter = new LineCounter();
  const doc = parseDocument(source, { lineCounter, uniqueKeys: false });
  if (doc.errors.length > 0 || !isMap(doc.contents)) return [];
  const paths = doc.contents.get("paths", true);
  if (!isMap(paths)) return [];

  const prefix = basePath(doc.contents);
  const line = (offset: number | undefined) => (offset === undefined ? 1 : lineCounter.linePos(offset).line);
  const found: SeamDraft[] = [];
  for (const item of paths.items as Pair[]) {
    if (!isScalar(item.key) || !isMap(item.value)) continue;
    const raw = joinPaths(prefix, String(item.key.value));
    for (const operation of item.value.items as Pair[]) {
      const method = isScalar(operation.key) ? methodFromVerb(String(operation.key.value)) : null;
      if (!method || method === "*") continue;
      const end = isMap(operation.value) ? operation.value.range?.[1] : undefined;
      const start = (operation.key as { range?: [number, number, number] }).range;
      found.push(routeSeam(PLUGIN, method, raw, { startLine: line(start?.[0]), endLine: line(end ?? start?.[1]) }));
    }
  }
  return found;
}

/** Swagger 2 `basePath`, or the path part of the first OpenAPI 3 server URL. */
function basePath(root: YAMLMap): string {
  const swaggerBase = root.get("basePath");
  if (typeof swaggerBase === "string") return swaggerBase;
  const servers = root.get("servers", true);
  const first = isSeq(servers) ? servers.items[0] : undefined;
  const url = isMap(first) ? first.get("url") : undefined;
  return typeof url === "string" ? stripOrigin(url).replace(/\{[^}]*\}/g, "") : "";
}

export const openapi: ExtractorPlugin = {
  name: PLUGIN,
  languages: [],
  wants: (path) => SPEC_FILE.test(path) && !NOT_A_SPEC.test(path),
  needsTree: false,
  extract: ({ source }) => extractSpec(source),
};
