import type { Node } from "@vscode/tree-sitter-wasm";
import { joinPaths } from "../../core/http.js";
import type { SeamDraft } from "../../core/seams.js";
import { args, attributesOf, collectConsts, declaratorValue, memberName, staticString, wantsCSharp, type Attribute } from "./cs-syntax.js";
import { lines, routeSeam, type ExtractorPlugin } from "./plugin.js";
import type { Consts } from "./strings.js";

const PLUGIN = "cs-routes";

const VERB_ATTRIBUTES: Record<string, string> = {
  HttpGet: "GET", HttpPost: "POST", HttpPut: "PUT", HttpDelete: "DELETE",
  HttpPatch: "PATCH", HttpHead: "HEAD", HttpOptions: "OPTIONS",
};
const MAP_METHODS: Record<string, string> = {
  MapGet: "GET", MapPost: "POST", MapPut: "PUT", MapDelete: "DELETE", MapPatch: "PATCH",
};
const CONTROLLER_MARKERS = new Set(["ApiController", "Route", "RoutePrefix"]);

/** An action template starting with "/" or "~/" ignores the controller's prefix. */
function combine(prefix: string, template: string): string {
  return template.startsWith("/") || template.startsWith("~/") ? template.replace(/^~/, "") : joinPaths(prefix, template);
}

function isController(cls: Node, name: string, attributes: Attribute[]): boolean {
  const bases = cls.namedChildren.find((n) => n?.type === "base_list")?.text ?? "";
  return name.endsWith("Controller") || attributes.some((a) => CONTROLLER_MARKERS.has(a.name)) || /\bController(Base)?\b/.test(bases);
}

/**
 * The (method, template) pairs one action declares. `[Route]` alone accepts any method;
 * `[HttpGet]` with no template takes the action's `[Route]` templates.
 */
function actionTemplates(attributes: Attribute[], text: (node: Node | undefined) => string | null): Array<[string, string]> {
  const verbs = attributes
    .filter((a) => a.name in VERB_ATTRIBUTES)
    .map((a) => ({ method: VERB_ATTRIBUTES[a.name]!, template: a.args[0] ? text(a.args[0]) : "" }));
  const routes = attributes.filter((a) => a.name === "Route").flatMap((a) => text(a.args[0]) ?? []);
  if (verbs.length === 0) return routes.map((template) => ["*", template]);
  return verbs.flatMap(({ method, template }): Array<[string, string]> => {
    if (template === null) return [];
    if (template !== "" || routes.length === 0) return [[method, template]];
    return routes.map((route) => [method, route]);
  });
}

/** Attribute-routed MVC / Web API controllers. Conventionally routed actions are skipped. */
function controllerRoutes(root: Node, consts: Consts): SeamDraft[] {
  const text = (node: Node | undefined) => (node ? staticString(node, consts) : null);
  const found: SeamDraft[] = [];

  for (const cls of root.descendantsOfType("class_declaration")) {
    const name = cls?.childForFieldName("name")?.text ?? "";
    const attributes = cls ? attributesOf(cls) : [];
    if (!cls || !isController(cls, name, attributes)) continue;

    const controller = name.replace(/Controller$/, "");
    const area = text(attributes.find((a) => a.name === "Area")?.args[0]);
    const prefixes = attributes.filter((a) => a.name === "Route" || a.name === "RoutePrefix").flatMap((a) => text(a.args[0]) ?? []);
    const attributeRouted = prefixes.length > 0;

    for (const action of cls.childForFieldName("body")?.namedChildren ?? []) {
      if (action?.type !== "method_declaration") continue;
      const actionName = (action.childForFieldName("name")?.text ?? "").replace(/Async$/, "");
      for (const [method, template] of actionTemplates(attributesOf(action), text)) {
        // `[HttpGet]` with no template anywhere is a verb constraint on a conventional route;
        // the path lives in Program.cs route tables, not here.
        if (!attributeRouted && template === "") continue;
        for (const prefix of attributeRouted ? prefixes : [""]) {
          const raw = combine(prefix, template)
            .replace(/\[controller\]/gi, controller)
            .replace(/\[action\]/gi, actionName)
            .replace(/\[area\]/gi, area ?? "{area}");
          found.push(routeSeam(PLUGIN, method, raw, lines(action)));
        }
      }
    }
  }
  return found;
}

/** Minimal APIs: `app.MapGet("/x", ...)`, including prefixes from `MapGroup`. */
function minimalApiRoutes(root: Node, consts: Consts): SeamDraft[] {
  const groups = new Map<string, string>();

  // The prefix a receiver carries: a MapGroup chain, or a variable holding one.
  const groupPrefix = (node: Node | null): string | null => {
    if (node?.type === "identifier") return groups.get(node.text) ?? null;
    const fn = node?.type === "invocation_expression" ? node.childForFieldName("function") : null;
    if (!node || fn?.type !== "member_access_expression") return null;
    const receiver = fn.childForFieldName("expression");
    if (memberName(fn) !== "MapGroup") return groupPrefix(receiver); // .WithTags(...), .RequireAuthorization(), ...
    const path = args(node)[0];
    const segment = path ? staticString(path, consts) : null;
    return segment === null ? null : joinPaths(groupPrefix(receiver) ?? "", segment);
  };

  for (const declarator of root.descendantsOfType("variable_declarator")) {
    const name = declarator?.childForFieldName("name");
    const prefix = declarator ? groupPrefix(declaratorValue(declarator)) : null;
    if (name && prefix !== null) groups.set(name.text, prefix);
  }

  const found: SeamDraft[] = [];
  for (const call of root.descendantsOfType("invocation_expression")) {
    const fn = call?.childForFieldName("function");
    if (!call || fn?.type !== "member_access_expression") continue;
    const method = MAP_METHODS[memberName(fn)];
    const first = args(call)[0];
    const path = method && first ? staticString(first, consts) : null;
    if (!method || path === null) continue;
    found.push(routeSeam(PLUGIN, method, joinPaths(groupPrefix(fn.childForFieldName("expression")) ?? "", path), lines(call)));
  }
  return found;
}

export const csRoutes: ExtractorPlugin = {
  name: PLUGIN,
  languages: ["C#"],
  wants: wantsCSharp,
  needsTree: true,
  extract: ({ tree }) => {
    if (!tree) return [];
    const consts = collectConsts(tree.rootNode);
    return [...controllerRoutes(tree.rootNode, consts), ...minimalApiRoutes(tree.rootNode, consts)];
  },
};
