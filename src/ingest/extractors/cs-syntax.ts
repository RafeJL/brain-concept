import type { Node } from "@vscode/tree-sitter-wasm";
import { grammarFor } from "../parse.js";
import { expressionPart, stringReader, type Part } from "./strings.js";

/** Syntax helpers for C# trees, shared by cs-routes and cs-calls. */

export function wantsCSharp(path: string): boolean {
  return grammarFor(path) === "c-sharp";
}

/** The value of `name = value` in a C# variable declarator (the grammar gives it no field). */
export function declaratorValue(declarator: Node): Node | null {
  const name = declarator.childForFieldName("name");
  return declarator.namedChildren.find((n) => n !== null && n.id !== name?.id && n.type !== "bracketed_argument_list") ?? null;
}

export const { staticString, collectConsts, resolveUrl } = stringReader({
  literal(node, consts): Part[] | null {
    switch (node.type) {
      case "string_literal":
        return [{ text: node.text.replace(/u8$/, "").slice(1, -1) }];
      case "verbatim_string_literal":
        return [{ text: node.text.slice(2, -1) }];
      case "raw_string_literal":
        return [{ text: node.namedChildren.find((n) => n?.type === "raw_string_content")?.text ?? "" }];
      case "interpolated_string_expression":
        return node.namedChildren.flatMap((child): Part[] => {
          if (child?.type === "string_content" || child?.type === "escape_sequence") return [{ text: child.text }];
          if (child?.type !== "interpolation") return [];
          return [expressionPart(child.namedChildren.find((n) => n !== null && !n.type.startsWith("interpolation_")), consts)];
        });
      default:
        return null;
    }
  },
  declaratorValue,
  allowRelative: true,
});

/** Positional argument expressions of an invocation or `new` expression. */
export function args(node: Node): Node[] {
  const list = node.childForFieldName("arguments") ?? node.namedChildren.find((n) => n?.type === "argument_list") ?? null;
  return (list?.namedChildren ?? [])
    .filter((n): n is Node => n?.type === "argument" && n.childForFieldName("name") === null)
    .map((argument) => argument.namedChildren.at(-1))
    .filter((n): n is Node => n != null);
}

export interface Attribute {
  /** Without namespace or "Attribute" suffix: `HttpGet`, `Route`. */
  name: string;
  /** Positional arguments only; `Name = "x"` style arguments are left out. */
  args: Node[];
}

const NAMED_ARGUMENT = new Set(["assignment_expression", "name_equals", "name_colon"]);

/** Attributes written directly on a class, method or interface member. */
export function attributesOf(declaration: Node): Attribute[] {
  return declaration.namedChildren
    .filter((list) => list?.type === "attribute_list")
    .flatMap((list) => list!.namedChildren.filter((a): a is Node => a?.type === "attribute"))
    .map((attribute) => ({
      name: (attribute.childForFieldName("name")?.text ?? "").split(".").at(-1)!.replace(/Attribute$/, ""),
      args: (attribute.namedChildren.find((n) => n?.type === "attribute_argument_list")?.namedChildren ?? [])
        .filter((arg): arg is Node => arg?.type === "attribute_argument")
        .filter((arg) => !arg.namedChildren.some((c) => c !== null && NAMED_ARGUMENT.has(c.type)))
        .map((arg) => arg.namedChildren.at(-1))
        .filter((n): n is Node => n != null),
    }));
}

/** `GetAsync` for `x.GetAsync<T>`; the method name of a member access. */
export function memberName(access: Node): string {
  return (access.childForFieldName("name")?.text ?? "").split("<")[0]!;
}

/** The thing a method is called on, as a name: `_httpClient`, `Client`, `CreateClient`. */
export function receiverName(access: Node): string {
  const target = access.childForFieldName("expression");
  if (target?.type === "member_access_expression") return memberName(target);
  if (target?.type === "invocation_expression") {
    const fn = target.childForFieldName("function");
    return fn?.type === "member_access_expression" ? memberName(fn) : fn?.text ?? "";
  }
  return target?.text ?? "";
}
