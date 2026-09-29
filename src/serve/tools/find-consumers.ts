import { matchEndpoints, parseEndpoint, type Endpoint, type MatchQuality } from "../../core/http.js";
import type { Seam } from "../../core/seams.js";
import type { Caller } from "../access.js";
import {
  alsoDeclared,
  count,
  endpointOf,
  footer,
  groupRoutes,
  PAGE_SIZE,
  pointer,
  readableRepos,
  unresolvedNote,
  type Format,
  type ToolDeps,
  type ToolResult,
} from "./common.js";

export interface ConsumersInput {
  target: string;
  method?: string;
  repos?: string[];
  format: Format;
  offset?: number;
}

export interface Hit {
  role: "server" | "caller";
  seam: Seam;
  match: MatchQuality;
  /** For servers: the same endpoint declared elsewhere in the repo (OpenAPI specs). */
  also: Seam[];
}

export interface Consumers {
  target: Endpoint;
  hits: Hit[];
}

/** Who serves and who calls an endpoint, across every repo the caller can read. */
export async function findConsumers(deps: ToolDeps, caller: Caller, input: ConsumersInput): Promise<ToolResult<Consumers>> {
  const target = parseEndpoint(input.target, input.method);
  if (!target) {
    return { ok: false, text: `"${input.target}" is not an endpoint. Try "GET /api/orders/{id}" or "/orders/:id".` };
  }
  const readable = await readableRepos(deps, caller);
  const scope = input.repos?.length ? readable.filter((name) => input.repos!.includes(name)) : readable;
  if (scope.length === 0) return { ok: false, text: "None of the requested repos are enrolled or readable." };

  const matches = deps.store.seams({ repos: scope }).flatMap((seam) => {
    const match = matchEndpoints(endpointOf(seam), target);
    return match ? [{ seam, match }] : [];
  });
  const matchOf = new Map(matches.map(({ seam, match }) => [seam, match]));
  const servers = groupRoutes(matches.filter(({ seam }) => seam.kind === "http-route").map(({ seam }) => seam));
  const hits: Hit[] = [
    ...servers.map(({ primary, also }): Hit => ({ role: "server", seam: primary, match: matchOf.get(primary)!, also })),
    ...matches.filter(({ seam }) => seam.kind === "http-call").map(({ seam, match }): Hit => ({ role: "caller", seam, match, also: [] })),
  ].sort(
    (a, b) =>
      Number(a.role === "caller") - Number(b.role === "caller") ||
      Number(a.match === "suffix") - Number(b.match === "suffix") ||
      a.seam.repo.localeCompare(b.seam.repo) ||
      a.seam.path.localeCompare(b.seam.path) ||
      a.seam.startLine - b.seam.startLine,
  );

  const data = { target, hits };
  return { ok: true, data, text: await render(deps, data, scope, input.format, input.offset ?? 0) };
}

async function render(deps: ToolDeps, { target, hits }: Consumers, scope: string[], format: Format, offset: number): Promise<string> {
  const label = `${target.method ?? "any method"} ${target.key}`;
  if (hits.length === 0) return [`No servers or callers found for ${label}.`, unresolvedNote(deps, scope)].filter(Boolean).join("\n");

  const servers = hits.filter((h) => h.role === "server").length;
  const repos = new Set(hits.map((h) => h.seam.repo));
  const page = hits.slice(offset, offset + PAGE_SIZE);
  const out = [`${label} · ${count(servers, "server")}, ${count(hits.length - servers, "caller")} in ${count(repos.size, "repo")} · parser-built`];
  for (const role of ["server", "caller"] as const) {
    const rows = page.filter((h) => h.role === role);
    if (rows.length === 0) continue;
    out.push("", role === "server" ? "Served by" : "Called by");
    for (const { seam, match, also } of rows) {
      const what = `${seam.method} ${seam.rawPath}`;
      const notes = format === "detailed" ? ` · ${match} · ${seam.plugin}` : match === "suffix" ? " · suffix" : "";
      out.push(`  ${pointer(seam)} · ${what}${notes}`);
      if (also.length) out.push(`    ${alsoDeclared(also)}`);
    }
  }
  out.push(
    ...(await footer(deps, {
      total: hits.length,
      offset,
      pageLength: page.length,
      suffix: hits.some((h) => h.match === "suffix"),
      freshnessRepos: page.map((h) => h.seam.repo),
      unresolvedIn: scope,
      closing: "Confirm in the repo before editing.",
    })),
  );
  return out.join("\n");
}
