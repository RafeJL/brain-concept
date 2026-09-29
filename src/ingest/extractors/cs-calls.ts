import type { Node } from "@vscode/tree-sitter-wasm";
import { methodFromVerb } from "../../core/http.js";
import type { SeamDraft } from "../../core/seams.js";
import { args, attributesOf, collectConsts, memberName, receiverName, resolveUrl, staticString, wantsCSharp } from "./cs-syntax.js";
import { callSeams, lines, type ExtractorPlugin } from "./plugin.js";

const PLUGIN = "cs-calls";

/** HttpClient extension methods that exist nowhere else, so any call to them is HTTP. */
const HTTP_ONLY: Record<string, string> = {
  GetFromJsonAsync: "GET", GetStringAsync: "GET", GetStreamAsync: "GET", GetByteArrayAsync: "GET",
  PostAsJsonAsync: "POST", PutAsJsonAsync: "PUT", PatchAsJsonAsync: "PATCH", DeleteFromJsonAsync: "DELETE",
};
/** Names shared with caches and repositories (`IDistributedCache.GetAsync("key")`). */
const AMBIGUOUS: Record<string, string> = {
  GetAsync: "GET", PostAsync: "POST", PutAsync: "PUT", DeleteAsync: "DELETE", PatchAsync: "PATCH",
};
const REFIT: Record<string, string> = {
  Get: "GET", Post: "POST", Put: "PUT", Delete: "DELETE", Patch: "PATCH", Head: "HEAD", Options: "OPTIONS",
};
const CLIENT_RECEIVER = /client|http/i;

/**
 * HTTP calls a C# repo makes: HttpClient, HttpRequestMessage, RestSharp and Refit interfaces.
 * Ambiguous method names only count when the receiver looks like an HTTP client or the URL
 * contains a "/", so a cache lookup is never mistaken for a call.
 */
function extractCalls(root: Node): SeamDraft[] {
  const consts = collectConsts(root);
  const found: SeamDraft[] = [];

  const record = (at: Node, urlNode: Node | undefined, method: string, sureItIsHttp = true) => {
    if (!urlNode) return;
    const url = resolveUrl(urlNode, consts);
    const pathLike = url.status === "path" && url.raw.includes("/");
    if (sureItIsHttp || pathLike) found.push(...callSeams(PLUGIN, method, url, lines(at)));
  };

  for (const call of root.descendantsOfType("invocation_expression")) {
    const fn = call?.childForFieldName("function");
    if (!call || fn?.type !== "member_access_expression") continue;
    const name = memberName(fn);
    if (HTTP_ONLY[name]) record(call, args(call)[0], HTTP_ONLY[name]!);
    else if (AMBIGUOUS[name]) record(call, args(call)[0], AMBIGUOUS[name]!, CLIENT_RECEIVER.test(receiverName(fn)));
  }

  for (const creation of root.descendantsOfType("object_creation_expression")) {
    const type = (creation?.childForFieldName("type")?.text ?? "").split(".").at(-1);
    if (!creation) continue;
    const [first, second] = args(creation);
    if (type === "HttpRequestMessage") {
      const method = second ? httpMethod(first) : null;
      if (method) record(creation, second, method);
    } else if (type === "RestRequest") {
      record(creation, first, httpMethod(second) ?? "GET");
    }
  }

  for (const iface of root.descendantsOfType("interface_declaration")) {
    for (const member of iface?.childForFieldName("body")?.namedChildren ?? []) {
      if (member?.type !== "method_declaration") continue;
      for (const attribute of attributesOf(member)) {
        const method = REFIT[attribute.name];
        if (method) record(member, attribute.args[0], method);
      }
    }
  }
  return found;
}

/** `HttpMethod.Get`, `Method.Post`, `new HttpMethod("PATCH")`. */
function httpMethod(node: Node | undefined): string | null {
  if (node?.type === "member_access_expression") return methodFromVerb(memberName(node));
  if (node?.type !== "object_creation_expression") return null;
  const arg = args(node)[0];
  const text = arg ? staticString(arg) : null;
  return text ? methodFromVerb(text) : null;
}

export const csCalls: ExtractorPlugin = {
  name: PLUGIN,
  languages: ["C#"],
  wants: wantsCSharp,
  needsTree: true,
  extract: ({ tree }) => (tree ? extractCalls(tree.rootNode) : []),
};
