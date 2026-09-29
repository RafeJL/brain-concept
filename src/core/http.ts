/** Stands in for any path parameter or dynamic segment in a normalised key. */
export const PARAM = "{}";

const VERBS: Record<string, string> = {
  get: "GET", post: "POST", put: "PUT", patch: "PATCH", delete: "DELETE", del: "DELETE",
  head: "HEAD", options: "OPTIONS", all: "*", any: "*",
};

/** "get" → "GET", "del" → "DELETE", "all" → "*"; null for anything that isn't an HTTP verb. */
export function methodFromVerb(verb: string): string | null {
  return VERBS[verb.toLowerCase()] ?? null;
}

function isParamSegment(segment: string): boolean {
  return segment.startsWith(":") || segment.includes("{") || segment === "*" || segment.startsWith("*");
}

/**
 * Turns any spelling of a route or URL into a key two repos can agree on:
 * `https://host/api/articles/:slug?x=1` and `/API/articles/{slug:int}/` both become
 * `/api/articles/{}`. Returns null when nothing path-like is left.
 */
export function normalisePath(raw: string): string | null {
  let path = raw.trim().replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, "");
  path = path.split(/[?#]/, 1)[0] ?? "";
  const segments = path
    .split("/")
    .filter((segment) => segment.length > 0 && segment !== ".")
    .map((segment) => (isParamSegment(segment) ? PARAM : segment.toLowerCase()));
  return "/" + segments.join("/");
}

/** Joins a prefix and a route the way frameworks do, without doubling or dropping slashes. */
export function joinPaths(prefix: string, path: string): string {
  const left = prefix.replace(/\/+$/, "");
  const right = path.replace(/^\/+/, "");
  if (!left) return "/" + right;
  if (!right) return left.startsWith("/") ? left : "/" + left;
  return `${left.startsWith("/") ? "" : "/"}${left}/${right}`;
}

export type MatchQuality = "exact" | "suffix";

/**
 * Compares two keys. "suffix" means one ends with the other at a segment boundary, which is how a
 * client calling `/api/articles/{}` finds a server that declares `/articles/{}` under an unknown
 * mount point. The shorter key must contain a literal segment, so `/{}` never matches everything.
 */
export function matchKeys(a: string, b: string): MatchQuality | null {
  if (a === b) return "exact";
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (!short.split("/").some((segment) => segment && segment !== PARAM)) return null;
  // Both keys start with "/", so endsWith can only succeed at a segment boundary.
  return long.endsWith(short) ? "suffix" : null;
}
