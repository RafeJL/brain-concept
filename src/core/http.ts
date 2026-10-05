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

const ID_SEGMENT = /^(\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/**
 * Parameters in any syntax, plus literal ids: `/items/1` is served by `/items/{id}`, so a
 * numeric or GUID segment is treated as a parameter. Word segments stay literal, so
 * `/articles/feed` never matches `/articles/{slug}`.
 */
function isParamSegment(segment: string): boolean {
  return segment.startsWith(":") || segment.includes("{") || segment.startsWith("*") || ID_SEGMENT.test(segment);
}

/** `https://host:8080/api/x` → `/api/x`. */
export function stripOrigin(url: string): string {
  return url.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, "");
}

/**
 * Turns any spelling of a route or URL into a key two repos can agree on:
 * `https://host/api/articles/:slug?x=1` and `/API/articles/{slug:int}/` both become
 * `/api/articles/{}`.
 */
export function normalisePath(raw: string): string {
  const path = stripOrigin(raw.trim()).split(/[?#]/, 1)[0] ?? "";
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

/** Whether a key names something (`/orders/{}`) rather than only parameters or the root (`/{}`, `/`). */
export function hasLiteralSegment(key: string): boolean {
  return key.split("/").some((segment) => segment && segment !== PARAM);
}

/**
 * Compares two keys. "suffix" means one ends with the other at a segment boundary, which is how a
 * client calling `/api/articles/{}` finds a server that declares `/articles/{}` under an unknown
 * mount point. The shorter key must contain a literal segment, so `/{}` never matches everything.
 */
export function matchKeys(a: string, b: string): MatchQuality | null {
  if (a === b) return "exact";
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (!hasLiteralSegment(short)) return null;
  // Both keys start with "/", so endsWith can only succeed at a segment boundary.
  return long.endsWith(short) ? "suffix" : null;
}

/** An HTTP endpoint as matched across repos. A null method means any method. */
export interface Endpoint {
  method: string | null;
  key: string;
}

/** Accepts "GET /api/articles/:slug", "/articles/{slug}" or a full URL; null if there's no path. */
export function parseEndpoint(text: string, method?: string): Endpoint | null {
  const match = text.trim().match(/^([A-Za-z]+)\s+(\S+)$/);
  const verb = match ? methodFromVerb(match[1]!) : null;
  const key = normalisePath(verb ? match![2]! : text.trim());
  if (key === "/") return null;
  return { method: (method ? methodFromVerb(method) : null) ?? verb, key };
}

/** How two endpoints match, if they do: methods compatible ("*" or null means any) and keys match. */
export function matchEndpoints(a: Endpoint, b: Endpoint): MatchQuality | null {
  const methodsCompatible = !a.method || !b.method || a.method === "*" || b.method === "*" || a.method === b.method;
  return methodsCompatible ? matchKeys(a.key, b.key) : null;
}
