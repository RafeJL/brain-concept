import type { Node } from "@vscode/tree-sitter-wasm";
import { methodFromVerb, normalisePath, PARAM } from "../../core/http.js";
import { grammarFor } from "../parse.js";

/** A piece of a string expression: known text, or something only known at run time. */
type Part = { text: string } | { dynamic: true };

export type UrlResolution =
  | { status: "path"; raw: string; key: string }
  | { status: "dynamic"; raw: string }
  | { status: "not-url" };

export function wantsTsOrJs(path: string): boolean {
  const grammar = grammarFor(path);
  return grammar === "typescript" || grammar === "tsx" || grammar === "javascript";
}

export function namedArgs(call: Node): Node[] {
  const args = call.childForFieldName("arguments");
  return args ? args.namedChildren.filter((n): n is Node => n !== null && n.type !== "comment") : [];
}

export function lines(node: Node): { startLine: number; endLine: number } {
  return { startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1 };
}

/** File-level `const X = "..."` values, so `fetch(API + "/x")` style calls can be resolved. */
export function collectStringConsts(root: Node): Map<string, string> {
  const consts = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const declarator of root.descendantsOfType("variable_declarator")) {
    const name = declarator?.childForFieldName("name");
    const value = declarator?.childForFieldName("value");
    if (name?.type !== "identifier" || !value) continue;
    const text = staticString(value);
    if (text === null) continue;
    if (consts.has(name.text) && consts.get(name.text) !== text) ambiguous.add(name.text);
    consts.set(name.text, text);
  }
  for (const name of ambiguous) consts.delete(name);
  return consts;
}

function stringParts(node: Node, consts: ReadonlyMap<string, string>): Part[] | null {
  switch (node.type) {
    case "string":
      return [{ text: node.text.slice(1, -1) }];
    case "template_string":
      return node.namedChildren.flatMap((child): Part[] => {
        if (!child) return [];
        return child.type === "template_substitution" ? [{ dynamic: true }] : [{ text: child.text }];
      });
    case "binary_expression": {
      if (node.childForFieldName("operator")?.text !== "+") return null;
      const left = node.childForFieldName("left");
      const right = node.childForFieldName("right");
      const leftParts = left ? stringParts(left, consts) ?? [{ dynamic: true }] : [];
      const rightParts = right ? stringParts(right, consts) ?? [{ dynamic: true }] : [];
      return [...leftParts, ...rightParts];
    }
    case "parenthesized_expression": {
      const inner = node.namedChildren[0];
      return inner ? stringParts(inner, consts) : null;
    }
    case "identifier": {
      const value = consts.get(node.text);
      return value === undefined ? [{ dynamic: true }] : [{ text: value }];
    }
    default:
      return null;
  }
}

/** The text of a string with no run-time parts, or null. */
export function staticString(node: Node): string | null {
  const parts = stringParts(node, new Map());
  if (!parts || parts.some((p) => "dynamic" in p) || node.type === "identifier") return null;
  return parts.map((p) => ("text" in p ? p.text : "")).join("");
}

/**
 * Works out the path a URL expression points at. A leading run-time value followed by a "/" is a
 * base URL and is dropped (`${API_ROOT}/articles` → `/articles`); later run-time values become
 * parameters. Returns "dynamic" when the path itself is only known at run time.
 */
export function resolveUrl(node: Node, consts: ReadonlyMap<string, string>): UrlResolution {
  const parts = stringParts(node, consts);
  if (!parts || parts.length === 0) return { status: "not-url" };
  const raw = node.text.length > 160 ? `${node.text.slice(0, 157)}...` : node.text;

  let start = 0;
  while (start < parts.length && "dynamic" in parts[start]!) start++;
  if (start === parts.length) return { status: "dynamic", raw };
  const first = (parts[start] as { text: string }).text;
  if (start > 0 && !first.startsWith("/")) return { status: "dynamic", raw };
  if (start === 0 && !first.startsWith("/") && !/^https?:\/\//i.test(first)) return { status: "not-url" };

  const joined = parts
    .slice(start)
    .map((p) => ("text" in p ? p.text : PARAM))
    .join("");
  const key = normalisePath(joined);
  return key === null ? { status: "dynamic", raw } : { status: "path", raw, key };
}

/** The name an HTTP helper is called on: `axios` in `axios.get`, `http` in `this.http.get`. */
export function receiverName(member: Node): string {
  const object = member.childForFieldName("object");
  if (!object) return "";
  if (object.type === "member_expression") return object.childForFieldName("property")?.text ?? "";
  return object.text;
}

const ROUTER_NAMES = /^(app|router|routes|server|fastify|r|\w+Router|\w+App|\w+Routes)$/i;
const CLIENT_NAMES = /^(axios|http|https|\$http|httpClient|client|\w+Client|request|requests|superagent|ky|got|agent|\w+Api|api)$/i;
const INLINE_HANDLERS = new Set(["arrow_function", "function_expression", "function"]);
const HANDLERS = new Set([...INLINE_HANDLERS, "identifier", "member_expression", "call_expression"]);

export function isClientName(name: string): boolean {
  return CLIENT_NAMES.test(name);
}

/**
 * `router.get('/x', auth, handler)` registers a route; `api.get('/x', config)` makes a call.
 * A route needs a static path starting with "/" and a handler as its last argument. When the
 * receiver's name doesn't say "router", only an inline function counts as proof.
 */
export function isRouteRegistration(member: Node, args: readonly Node[]): boolean {
  if (args.length < 2) return false;
  const path = staticString(args[0]!);
  if (path === null || !path.startsWith("/")) return false;
  const name = receiverName(member);
  if (CLIENT_NAMES.test(name)) return false;
  const last = args[args.length - 1]!;
  if (INLINE_HANDLERS.has(last.type)) return true;
  return ROUTER_NAMES.test(name) && HANDLERS.has(last.type);
}

export function isHandler(node: Node): boolean {
  return HANDLERS.has(node.type);
}

/** Reads `{ key: "value" }` from an object literal; null when absent or not a plain string. */
export function objectProperty(object: Node, key: string): Node | null {
  for (const pair of object.namedChildren) {
    if (pair?.type !== "pair") continue;
    const name = pair.childForFieldName("key");
    const text = name ? name.text.replace(/^["']|["']$/g, "") : "";
    if (text === key) return pair.childForFieldName("value");
  }
  return null;
}

/**
 * The path at the root of an Express chain like `router.route("/p").get(a).put(b)`, given any
 * call in it. Null when the call is not part of such a chain.
 */
export function routeChainPath(call: Node): string | null {
  const fn = call.childForFieldName("function");
  if (fn?.type !== "member_expression") return null;
  const property = fn.childForFieldName("property")?.text ?? "";
  if (property === "route") {
    const first = namedArgs(call)[0];
    const path = first ? staticString(first) : null;
    return path?.startsWith("/") ? path : null;
  }
  const object = fn.childForFieldName("object");
  return methodFromVerb(property) && object?.type === "call_expression" ? routeChainPath(object) : null;
}
