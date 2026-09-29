import type { Node } from "@vscode/tree-sitter-wasm";
import { methodFromVerb } from "../../core/http.js";
import type { SeamDraft } from "../../core/seams.js";
import type { ExtractorPlugin } from "./plugin.js";
import {
  collectStringConsts,
  isClientName,
  isRouteRegistration,
  lines,
  namedArgs,
  objectProperty,
  receiverName,
  resolveUrl,
  routeChainPath,
  staticString,
  wantsTsOrJs,
} from "./ts-shared.js";

/**
 * HTTP calls a TS/JS repo makes: `fetch`, `axios`, and `<client>.get|post|...(url)`.
 * A call whose URL is only known at run time is recorded as unresolved when the receiver is
 * clearly an HTTP client, and skipped otherwise, so coverage gaps are visible but never guessed.
 */
function extractCalls(root: Node): SeamDraft[] {
  const consts = collectStringConsts(root);
  const found: SeamDraft[] = [];

  const record = (call: Node, urlNode: Node | undefined, method: string, sureItIsHttp: boolean) => {
    if (!urlNode) return;
    const url = resolveUrl(urlNode, consts);
    if (url.status === "path") {
      found.push({ kind: "http-call", method, rawPath: url.raw, key: url.key, ...lines(call), plugin: "ts-calls" });
    } else if (url.status === "dynamic" && sureItIsHttp) {
      found.push({ kind: "http-call", method, rawPath: url.raw, key: null, ...lines(call), plugin: "ts-calls" });
    }
  };

  for (const call of root.descendantsOfType("call_expression")) {
    const fn = call?.childForFieldName("function");
    if (!call || !fn) continue;
    const args = namedArgs(call);
    const callee = fn.type === "member_expression" ? fn.childForFieldName("property")?.text ?? "" : fn.text;
    const receiver = fn.type === "member_expression" ? receiverName(fn) : "";

    if (callee === "fetch" && (fn.type === "identifier" || /^(window|globalThis|self)$/.test(receiver))) {
      record(call, args[0], optionMethod(args[1]) ?? "GET", true);
      continue;
    }
    if (fn.type === "identifier" && callee === "axios") {
      if (args[0]?.type === "object") {
        record(call, objectProperty(args[0], "url") ?? undefined, optionMethod(args[0]) ?? "GET", true);
      } else {
        record(call, args[0], optionMethod(args[1]) ?? "GET", true);
      }
      continue;
    }
    if (fn.type !== "member_expression") continue;

    const method = methodFromVerb(callee);
    if (!method || method === "*" || args.length === 0) continue;
    const object = fn.childForFieldName("object");
    if (object?.type === "call_expression" && routeChainPath(object) !== null) continue;
    if (isRouteRegistration(fn, args)) continue;
    record(call, args[0], method, isClientName(receiver));
  }
  return found;
}

/** `{ method: 'POST' }` in fetch/axios options. */
function optionMethod(options: Node | undefined): string | null {
  if (options?.type !== "object") return null;
  const value = objectProperty(options, "method");
  const text = value ? staticString(value) : null;
  return text ? methodFromVerb(text) : null;
}

export const tsCalls: ExtractorPlugin = {
  name: "ts-calls",
  wants: wantsTsOrJs,
  needsTree: true,
  extract: ({ tree }) => (tree ? extractCalls(tree.rootNode) : []),
};
