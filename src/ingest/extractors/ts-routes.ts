import type { Node } from "@vscode/tree-sitter-wasm";
import { joinPaths, methodFromVerb, normalisePath } from "../../core/http.js";
import type { SeamDraft } from "../../core/seams.js";
import type { ExtractorPlugin } from "./plugin.js";
import {
  isHandler,
  isRouteRegistration,
  lines,
  namedArgs,
  objectProperty,
  routeChainPath,
  staticString,
  wantsTsOrJs,
} from "./ts-shared.js";

const NEST_METHODS: Record<string, string> = {
  Get: "GET", Post: "POST", Put: "PUT", Patch: "PATCH", Delete: "DELETE", Head: "HEAD", Options: "OPTIONS", All: "*",
};

function route(method: string, raw: string, node: Node): SeamDraft | null {
  const key = normalisePath(raw);
  return key === null ? null : { kind: "http-route", method, rawPath: raw, key, ...lines(node), plugin: "ts-routes" };
}

/** Express/Fastify-style `x.get('/path', handler)`, `x.route('/path').get(...)`, `fastify.route({...})`. */
function callRoutes(root: Node): SeamDraft[] {
  const found: SeamDraft[] = [];
  for (const call of root.descendantsOfType("call_expression")) {
    const fn = call?.childForFieldName("function");
    if (!call || fn?.type !== "member_expression") continue;
    const verb = fn.childForFieldName("property")?.text ?? "";
    const args = namedArgs(call);

    if (verb === "route" && args[0]?.type === "object") {
      const url = objectProperty(args[0], "url") ?? objectProperty(args[0], "path");
      const methodNode = objectProperty(args[0], "method");
      const path = url ? staticString(url) : null;
      const methods = methodNode?.type === "array" ? methodNode.namedChildren : [methodNode];
      for (const m of methods) {
        const method = m ? methodFromVerb(staticString(m) ?? "") : null;
        const seam = path?.startsWith("/") && method ? route(method, path, call) : null;
        if (seam) found.push(seam);
      }
      continue;
    }

    const method = methodFromVerb(verb);
    if (!method) continue;
    const object = fn.childForFieldName("object");
    const chained = object?.type === "call_expression" ? routeChainPath(object) : null;
    if (chained !== null) {
      if (args.length > 0 && isHandler(args[args.length - 1]!)) push(found, route(method, chained, call));
    } else if (isRouteRegistration(fn, args)) {
      push(found, route(method, staticString(args[0]!)!, call));
    }
  }
  return found;
}

/** NestJS `@Controller('cats')` on the class plus `@Get(':id')` on the method. */
function nestRoutes(root: Node): SeamDraft[] {
  const found: SeamDraft[] = [];
  for (const decorator of root.descendantsOfType("decorator")) {
    const call = decorator?.namedChildren[0];
    if (!decorator || call?.type !== "call_expression") continue;
    const method = NEST_METHODS[call.childForFieldName("function")?.text ?? ""];
    if (!method || decorator.parent?.type !== "class_body") continue;
    const cls = decorator.parent.parent;
    const first = namedArgs(call)[0];
    const sub = first ? staticString(first) : "";
    if (sub === null || !cls) continue;
    const target = nextMethod(decorator) ?? decorator;
    push(found, route(method, joinPaths(controllerPrefix(cls), sub), target));
  }
  return found;
}

function nextMethod(decorator: Node): Node | null {
  for (let node = decorator.nextNamedSibling; node; node = node.nextNamedSibling) {
    if (node.type === "method_definition") return node;
    if (node.type !== "decorator") return null;
  }
  return null;
}

function controllerPrefix(cls: Node): string {
  const decorators = [...cls.namedChildren, ...(cls.parent?.type === "export_statement" ? cls.parent.namedChildren : [])];
  for (const decorator of decorators) {
    const call = decorator?.type === "decorator" ? decorator.namedChildren[0] : null;
    if (call?.type !== "call_expression" || call.childForFieldName("function")?.text !== "Controller") continue;
    const arg = namedArgs(call)[0];
    if (!arg) return "";
    if (arg.type === "object") {
      const path = objectProperty(arg, "path");
      return (path && staticString(path)) ?? "";
    }
    return staticString(arg) ?? "";
  }
  return "";
}

function push(list: SeamDraft[], seam: SeamDraft | null): void {
  if (seam) list.push(seam);
}

export const tsRoutes: ExtractorPlugin = {
  name: "ts-routes",
  wants: wantsTsOrJs,
  needsTree: true,
  extract: ({ tree }) => (tree ? [...callRoutes(tree.rootNode), ...nestRoutes(tree.rootNode)] : []),
};
