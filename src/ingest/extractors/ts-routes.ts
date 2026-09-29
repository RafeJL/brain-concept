import type { Node } from "@vscode/tree-sitter-wasm";
import { joinPaths, methodFromVerb } from "../../core/http.js";
import type { SeamDraft } from "../../core/seams.js";
import { lines, routeSeam, type ExtractorPlugin } from "./plugin.js";
import { isHandler, isRouteRegistration, namedArgs, objectProperty, routeChainPath, staticString, wantsTsOrJs } from "./ts-syntax.js";

const PLUGIN = "ts-routes";

const NEST_METHODS: Record<string, string> = {
  Get: "GET", Post: "POST", Put: "PUT", Patch: "PATCH", Delete: "DELETE", Head: "HEAD", Options: "OPTIONS", All: "*",
};

/** Express/Fastify-style `x.get('/path', handler)`, `x.route('/path').get(...)`, `fastify.route({...})`. */
function callRoutes(root: Node): SeamDraft[] {
  const found: SeamDraft[] = [];
  for (const call of root.descendantsOfType("call_expression")) {
    const fn = call?.childForFieldName("function");
    if (!call || fn?.type !== "member_expression") continue;
    const verb = fn.childForFieldName("property")?.text ?? "";
    const args = namedArgs(call);

    if (verb === "route" && args[0]?.type === "object") {
      found.push(...fastifyRoutes(args[0], call));
      continue;
    }
    const method = methodFromVerb(verb);
    if (!method) continue;
    const object = fn.childForFieldName("object");
    const chained = object?.type === "call_expression" ? routeChainPath(object) : null;
    if (chained !== null) {
      if (args.length > 0 && isHandler(args[args.length - 1]!)) found.push(routeSeam(PLUGIN, method, chained, lines(call)));
    } else if (isRouteRegistration(fn, args)) {
      found.push(routeSeam(PLUGIN, method, staticString(args[0]!)!, lines(call)));
    }
  }
  return found;
}

/** `fastify.route({ method: ["GET", "HEAD"], url: "/health", handler })`. */
function fastifyRoutes(options: Node, call: Node): SeamDraft[] {
  const url = objectProperty(options, "url") ?? objectProperty(options, "path");
  const path = url ? staticString(url) : null;
  if (!path?.startsWith("/")) return [];
  const methodNode = objectProperty(options, "method");
  const methodNodes = methodNode?.type === "array" ? methodNode.namedChildren : [methodNode];
  return methodNodes.flatMap((node) => {
    const method = node ? methodFromVerb(staticString(node) ?? "") : null;
    return method ? [routeSeam(PLUGIN, method, path, lines(call))] : [];
  });
}

/** NestJS `@Controller('cats')` on the class plus `@Get(':id')` on the method. */
function nestRoutes(root: Node): SeamDraft[] {
  const found: SeamDraft[] = [];
  for (const decorator of root.descendantsOfType("decorator")) {
    const call = decorator?.namedChildren[0];
    if (!decorator || call?.type !== "call_expression") continue;
    const method = NEST_METHODS[call.childForFieldName("function")?.text ?? ""];
    const cls = decorator.parent?.type === "class_body" ? decorator.parent.parent : null;
    const first = namedArgs(call)[0];
    const sub = first ? staticString(first) : "";
    if (!method || !cls || sub === null) continue;
    const cited = nextMethod(decorator) ?? decorator;
    found.push(routeSeam(PLUGIN, method, joinPaths(controllerPrefix(cls), sub), lines(cited)));
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

/** The path in `@Controller('cats')` or `@Controller({ path: 'cats' })`; "" when there is none. */
function controllerPrefix(cls: Node): string {
  const decorators = [...cls.namedChildren, ...(cls.parent?.type === "export_statement" ? cls.parent.namedChildren : [])];
  for (const decorator of decorators) {
    const call = decorator?.type === "decorator" ? decorator.namedChildren[0] : null;
    if (call?.type !== "call_expression" || call.childForFieldName("function")?.text !== "Controller") continue;
    const arg = namedArgs(call)[0];
    const path = arg?.type === "object" ? objectProperty(arg, "path") : arg;
    return (path && staticString(path)) ?? "";
  }
  return "";
}

export const tsRoutes: ExtractorPlugin = {
  name: PLUGIN,
  languages: ["TypeScript", "JavaScript"],
  wants: wantsTsOrJs,
  needsTree: true,
  extract: ({ tree }) => (tree ? [...callRoutes(tree.rootNode), ...nestRoutes(tree.rootNode)] : []),
};
