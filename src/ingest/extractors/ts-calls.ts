import type { Node } from "@vscode/tree-sitter-wasm";
import { methodFromVerb } from "../../core/http.js";
import type { SeamDraft } from "../../core/seams.js";
import { callSeams, lines, type ExtractorPlugin } from "./plugin.js";
import type { Consts } from "./strings.js";
import {
  collectConsts,
  isClientName,
  isRouteRegistration,
  namedArgs,
  objectProperty,
  receiverName,
  resolveUrl,
  routeChainPath,
  staticString,
  wantsTsOrJs,
} from "./ts-syntax.js";

const PLUGIN = "ts-calls";

/**
 * HTTP calls a TS/JS repo makes: `fetch`, `axios`, and `<client>.get|post|...(url)` where the
 * receiver is named like an HTTP client (`api`, `http`, `requests`, `ordersClient`, ...).
 * A call whose URL is only known at run time is recorded as unresolved, so coverage gaps are
 * visible but never guessed.
 */
function extractCalls(root: Node): SeamDraft[] {
  const consts = collectConsts(root);
  return root.descendantsOfType("call_expression").flatMap((call) => (call ? callAt(call, consts) : []));
}

function callAt(call: Node, consts: Consts): SeamDraft[] {
  const fn = call.childForFieldName("function");
  if (!fn) return [];
  const args = namedArgs(call);
  const record = (url: Node | null | undefined, method: string) =>
    url ? callSeams(PLUGIN, method, resolveUrl(url, consts), lines(call)) : [];

  if (fn.type === "identifier") {
    if (fn.text === "fetch") return record(args[0], optionMethod(args[1]) ?? "GET");
    if (fn.text !== "axios") return [];
    return args[0]?.type === "object"
      ? record(objectProperty(args[0], "url"), optionMethod(args[0]) ?? "GET")
      : record(args[0], optionMethod(args[1]) ?? "GET");
  }
  if (fn.type !== "member_expression") return [];

  const callee = fn.childForFieldName("property")?.text ?? "";
  const receiver = receiverName(fn);
  if (callee === "fetch" && /^(window|globalThis|self)$/.test(receiver)) return record(args[0], optionMethod(args[1]) ?? "GET");

  const method = methodFromVerb(callee);
  if (!method || method === "*" || args.length === 0) return [];
  const object = fn.childForFieldName("object");
  if (object?.type === "call_expression" && routeChainPath(object) !== null) return [];
  // `cache.get("/key")` is not HTTP: only receivers named like a client count.
  if (!isClientName(receiver) || isRouteRegistration(fn, args)) return [];
  return record(args[0], method);
}

/** `{ method: 'POST' }` in fetch/axios options. */
function optionMethod(options: Node | undefined): string | null {
  if (options?.type !== "object") return null;
  const value = objectProperty(options, "method");
  const text = value ? staticString(value) : null;
  return text ? methodFromVerb(text) : null;
}

export const tsCalls: ExtractorPlugin = {
  name: PLUGIN,
  languages: ["TypeScript", "JavaScript"],
  wants: wantsTsOrJs,
  needsTree: true,
  extract: ({ tree }) => (tree ? extractCalls(tree.rootNode) : []),
};
