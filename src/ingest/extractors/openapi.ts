import { isMap, isScalar, isSeq, LineCounter, parseDocument, type Pair, type YAMLMap } from "yaml";
import { joinPaths, methodFromVerb, normalisePath } from "../../core/http.js";
import type { SeamDraft } from "../../core/seams.js";
import type { ExtractorPlugin } from "./plugin.js";

const SPEC_FILE = /\.(ya?ml|json)$/i;
const NOT_A_SPEC = /(^|\/)(node_modules|package(-lock)?\.json$|tsconfig[^/]*\.json$|\.github\/)/;
const LOOKS_LIKE_SPEC = /["']?\b(openapi|swagger)\b["']?\s*:\s*["']?[23]\./;

/**
 * Routes declared in OpenAPI 3 / Swagger 2 specs, in any backend language. The most reliable
 * source we have: the spec states the contract directly, so it is read in preference to code.
 */
function extractSpec(source: string): SeamDraft[] {
  if (!LOOKS_LIKE_SPEC.test(source.slice(0, 4000))) return [];
  const lineCounter = new LineCounter();
  const doc = parseDocument(source, { lineCounter, uniqueKeys: false });
  if (doc.errors.length > 0 || !isMap(doc.contents)) return [];
  const root = doc.contents;
  const paths = root.get("paths", true);
  if (!isMap(paths)) return [];

  const prefix = basePath(root);
  const line = (offset: number | undefined) => (offset === undefined ? 1 : lineCounter.linePos(offset).line);
  const found: SeamDraft[] = [];
  for (const item of paths.items as Pair[]) {
    if (!isScalar(item.key) || !isMap(item.value)) continue;
    const raw = joinPaths(prefix, String(item.key.value));
    const key = normalisePath(raw);
    if (key === null) continue;
    for (const operation of item.value.items as Pair[]) {
      if (!isScalar(operation.key)) continue;
      const method = methodFromVerb(String(operation.key.value));
      if (!method || method === "*") continue;
      const valueRange = isMap(operation.value) ? operation.value.range : undefined;
      found.push({
        kind: "http-route",
        method,
        rawPath: raw,
        key,
        startLine: line(operation.key.range?.[0]),
        endLine: line(valueRange?.[1] ?? operation.key.range?.[1]),
        plugin: "openapi",
      });
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
  if (typeof url !== "string") return "";
  return url.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, "").replace(/\{[^}]*\}/g, "");
}

export const openapi: ExtractorPlugin = {
  name: "openapi",
  wants: (path) => SPEC_FILE.test(path) && !NOT_A_SPEC.test(path),
  needsTree: false,
  extract: ({ source }) => extractSpec(source),
};
