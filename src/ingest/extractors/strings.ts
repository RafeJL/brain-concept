import type { Node } from "@vscode/tree-sitter-wasm";
import { normalisePath, PARAM } from "../../core/http.js";

/**
 * A piece of a string expression: known text, or something only known at run time. A run-time
 * part keeps the name it was read from (`url` in `${url}`, `relativeUrl` in `opts.relativeUrl`),
 * because the name is often the only clue to what it holds.
 */
export type Part = { text: string } | { dynamic: true; name?: string };

/** Same-file string constants, by name. */
export type Consts = ReadonlyMap<string, string>;

/**
 * An expression embedded in a string (`${x}`, `{x}`, `+ x`): a constant's text if it is one,
 * otherwise a run-time part named after the expression's last identifier.
 */
export function expressionPart(expression: Node | null | undefined, consts: Consts): Part {
  if (expression?.type === "identifier") {
    const value = consts.get(expression.text);
    if (value !== undefined) return { text: value };
  }
  return { dynamic: true, name: expression?.text.match(/(\w+)\W*$/)?.[1] };
}

export type UrlResolution =
  | { status: "path"; raw: string; key: string }
  | { status: "dynamic"; raw: string }
  | { status: "not-url" };

/**
 * How one language writes strings. Everything else about reading them (`+` concatenation,
 * parentheses, constants, turning parts into a path) is the same in every language.
 */
export interface StringSyntax {
  /** Parts of a literal node (plain, template, interpolated...), or null if it isn't a literal. */
  literal(node: Node, consts: Consts): Part[] | null;
  /** The value expression of a variable declarator. */
  declaratorValue(declarator: Node): Node | null;
  /**
   * Accept a leading literal with no "/" as a relative path (`"api/orders"`). Right for C#
   * HttpClient, where URLs are relative to BaseAddress; wrong for JS, where `get("title")` is
   * usually not HTTP at all.
   */
  allowRelative: boolean;
}

export interface StringReader {
  /** The text of a string with no run-time parts (constants allowed), or null. */
  staticString(node: Node, consts?: Consts): string | null;
  /** `const X = "..."` values in a file. Names declared twice with different values are dropped. */
  collectConsts(root: Node): Map<string, string>;
  /** The path a URL expression points at; see `resolveParts`. */
  resolveUrl(node: Node, consts: Consts): UrlResolution;
}

const NO_CONSTS: Consts = new Map();
const RELATIVE_PATH = /^[A-Za-z0-9_~.-]+(\/|$)/;
/** Names of values that hold a URL or a path rather than one parameter. */
const PATH_NAME = /(url|uri|path|endpoint|route|resource|href|address)s?$/i;
/** Text after which a run-time value is a path parameter or query value, not the rest of the path. */
const SEPARATOR = /[/?&=#]$/;

/**
 * Whether a trailing run-time value supplies the rest of the path: it is glued to text with no
 * separator (`${API}${url}`, `API + path`), or it is named like a path (`${API}/${relativeUrl}`).
 * `"/orders/" + id` is an ordinary parameter.
 */
function endsInRunTimePath(parts: readonly Part[]): boolean {
  const last = parts.at(-1);
  const before = parts.at(-2);
  if (!last || !before || !("dynamic" in last)) return false;
  const inQuery = parts.some((p) => "text" in p && p.text.includes("?"));
  if (inQuery) return false;
  const glued = "text" in before && !SEPARATOR.test(before.text);
  return glued || PATH_NAME.test(last.name ?? "");
}

export function stringReader(syntax: StringSyntax): StringReader {
  const partsOf = (node: Node, consts: Consts): Part[] | null => {
    const literal = syntax.literal(node, consts);
    if (literal) return literal;
    switch (node.type) {
      case "binary_expression": {
        if (node.childForFieldName("operator")?.text !== "+") return null;
        const side = (child: Node | null) => (child ? partsOf(child, consts) ?? [expressionPart(child, consts)] : []);
        return [...side(node.childForFieldName("left")), ...side(node.childForFieldName("right"))];
      }
      case "parenthesized_expression": {
        const inner = node.namedChildren[0];
        return inner ? partsOf(inner, consts) : null;
      }
      case "identifier":
        return [expressionPart(node, consts)];
      default:
        return null;
    }
  };

  const staticString = (node: Node, consts: Consts = NO_CONSTS): string | null => {
    const parts = partsOf(node, consts);
    return parts && parts.every((p) => "text" in p) ? parts.map((p) => (p as { text: string }).text).join("") : null;
  };

  const collectConsts = (root: Node): Map<string, string> => {
    const consts = new Map<string, string>();
    const ambiguous = new Set<string>();
    for (const declarator of root.descendantsOfType("variable_declarator")) {
      const name = declarator?.childForFieldName("name");
      const value = declarator ? syntax.declaratorValue(declarator) : null;
      const text = name?.type === "identifier" && value ? staticString(value) : null;
      if (!name || text === null) continue;
      if (consts.has(name.text) && consts.get(name.text) !== text) ambiguous.add(name.text);
      consts.set(name.text, text);
    }
    for (const name of ambiguous) consts.delete(name);
    return consts;
  };

  const resolveUrl = (node: Node, consts: Consts) => resolveParts(partsOf(node, consts), node.text, syntax.allowRelative);

  return { staticString, collectConsts, resolveUrl };
}

/**
 * Works out the path a URL expression points at, from its parts. A leading run-time value
 * followed by a "/" is a base URL and is dropped (`${API_ROOT}/articles` → `/articles`); later
 * run-time values become parameters. "dynamic" means the path itself is only known at run time.
 */
export function resolveParts(parts: readonly Part[] | null, sourceText: string, allowRelative: boolean): UrlResolution {
  if (!parts || parts.length === 0) return { status: "not-url" };
  const raw = sourceText.length > 160 ? `${sourceText.slice(0, 157)}...` : sourceText;

  const start = parts.findIndex((p) => "text" in p);
  if (start < 0) return { status: "dynamic", raw };
  const first = (parts[start] as { text: string }).text;
  if (start > 0 && !first.startsWith("/")) return { status: "dynamic", raw };
  const absolute = first.startsWith("/") || /^https?:\/\//i.test(first);
  if (start === 0 && !absolute && !(allowRelative && RELATIVE_PATH.test(first))) return { status: "not-url" };
  if (endsInRunTimePath(parts.slice(start))) return { status: "dynamic", raw };

  const joined = parts
    .slice(start)
    .map((p) => ("text" in p ? p.text : PARAM))
    .join("");
  return { status: "path", raw, key: normalisePath(joined) };
}
