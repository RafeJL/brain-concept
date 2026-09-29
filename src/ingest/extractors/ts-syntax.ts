import type { Node } from "@vscode/tree-sitter-wasm";
import { methodFromVerb } from "../../core/http.js";
import { grammarFor } from "../parse.js";
import { expressionPart, stringReader, type Part } from "./strings.js";

/** Syntax helpers for TypeScript and JavaScript trees, shared by ts-routes and ts-calls. */

export function wantsTsOrJs(path: string): boolean {
  const grammar = grammarFor(path);
  return grammar === "typescript" || grammar === "tsx" || grammar === "javascript";
}

export const { staticString, collectConsts, resolveUrl } = stringReader({
  literal(node, consts): Part[] | null {
    if (node.type === "string") return [{ text: node.text.slice(1, -1) }];
    if (node.type !== "template_string") return null;
    return node.namedChildren.flatMap((child): Part[] => {
      if (!child) return [];
      return child.type === "template_substitution" ? [expressionPart(child.namedChildren[0], consts)] : [{ text: child.text }];
    });
  },
  declaratorValue: (declarator) => declarator.childForFieldName("value"),
  allowRelative: false,
});

export function namedArgs(call: Node): Node[] {
  const args = call.childForFieldName("arguments");
  return args ? args.namedChildren.filter((n): n is Node => n !== null && n.type !== "comment") : [];
}

/** The name an HTTP helper is called on: `axios` in `axios.get`, `http` in `this.http.get`. */
export function receiverName(member: Node): string {
  const object = member.childForFieldName("object");
  if (!object) return "";
  if (object.type === "member_expression") return object.childForFieldName("property")?.text ?? "";
  return object.text;
}

/** Reads `{ key: value }` from an object literal; null when the key is absent. */
export function objectProperty(object: Node, key: string): Node | null {
  for (const pair of object.namedChildren) {
    if (pair?.type !== "pair") continue;
    const name = pair.childForFieldName("key");
    if (name && name.text.replace(/^["']|["']$/g, "") === key) return pair.childForFieldName("value");
  }
  return null;
}

const ROUTER_NAMES = /^(app|router|routes|server|fastify|r|\w+Router|\w+App|\w+Routes)$/i;
const CLIENT_NAMES = /^(axios|http|https|\$http|httpClient|client|\w+Client|request|requests|superagent|ky|got|agent|\w+Api|api)$/i;
const INLINE_HANDLERS = new Set(["arrow_function", "function_expression", "function"]);
const HANDLERS = new Set([...INLINE_HANDLERS, "identifier", "member_expression", "call_expression"]);

export function isClientName(name: string): boolean {
  return CLIENT_NAMES.test(name);
}

export function isHandler(node: Node): boolean {
  return HANDLERS.has(node.type);
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
  if (isClientName(name)) return false;
  const last = args[args.length - 1]!;
  return INLINE_HANDLERS.has(last.type) || (ROUTER_NAMES.test(name) && isHandler(last));
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
