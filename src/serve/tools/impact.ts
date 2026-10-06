import { matchEndpoints, parseEndpoint, type MatchQuality } from "../../core/http.js";
import type { Seam } from "../../core/seams.js";
import type { Caller } from "../access.js";
import {
  alsoDeclared,
  count,
  endpointOf,
  footer,
  groupRoutes,
  lineRange,
  linkCalls,
  PAGE_SIZE,
  pointer,
  requireSyncedRepo,
  type Format,
  type ToolDeps,
  type ToolResult,
} from "./common.js";

export interface ImpactInput {
  repo: string;
  /** A file in the repo: only routes declared there. */
  path?: string;
  /** An endpoint: only routes of the repo matching it. */
  route?: string;
  format: Format;
  offset?: number;
}

export interface RouteImpact {
  route: Seam;
  /** The same endpoint declared elsewhere in the repo, e.g. in an OpenAPI spec. */
  also: Seam[];
  callers: Array<{ seam: Seam; match: MatchQuality }>;
}

export interface Impact {
  repo: string;
  path?: string;
  routes: RouteImpact[];
  /** Calls the file or repo makes itself; reported so an empty answer still says something. */
  outgoingCalls: number;
}

/**
 * The seam-level blast radius of changing a repo, a file in it, or one endpoint: the routes it
 * serves and who calls each one, in any readable repo (its own included, e.g. e2e tests).
 */
export async function impact(deps: ToolDeps, caller: Caller, input: ImpactInput): Promise<ToolResult<Impact>> {
  const found = await requireSyncedRepo(deps, caller, input.repo);
  if (!found.ok) return found;
  const target = input.route ? parseEndpoint(input.route) : null;
  if (input.route && !target) return { ok: false, text: `"${input.route}" is not an endpoint. Try "GET /api/orders/{id}".` };

  const path = input.path?.replace(/\\/g, "/").replace(/^\.?\//, "");
  const routes = deps.store
    .seams({ repos: [input.repo], kind: "http-route", path })
    .filter((route) => !target || matchEndpoints(endpointOf(route), target));
  const groups = groupRoutes(routes);
  const links = linkCalls(
    deps.store.seams({ repos: found.readable, kind: "http-call" }),
    groups.map((g) => g.primary),
    deps.store.seams({ repos: found.readable, kind: "http-route" }),
  );
  const impacts: RouteImpact[] = groups.map(({ primary: route, also }) => ({
    route,
    also,
    callers: links.filter((link) => link.route === route).map(({ call, match }) => ({ seam: call, match })),
  }));
  impacts.sort((a, b) => b.callers.length - a.callers.length || a.route.path.localeCompare(b.route.path) || a.route.startLine - b.route.startLine);

  const outgoingCalls = deps.store.seams({ repos: [input.repo], kind: "http-call", path, includeUnresolved: true }).length;
  const data: Impact = { repo: input.repo, path, routes: impacts, outgoingCalls };
  return { ok: true, data, text: await render(deps, data, found.readable, input.format, input.offset ?? 0) };
}

async function render(deps: ToolDeps, { repo, path, routes, outgoingCalls }: Impact, readable: string[], format: Format, offset: number): Promise<string> {
  const scope = path ? `${repo} · ${path}` : repo;
  if (routes.length === 0) {
    const calls = outgoingCalls ? ` It makes ${count(outgoingCalls, "HTTP call")}; use brain_find_consumers on one to see who serves it.` : "";
    return `No matching routes are declared in ${scope}.${calls}`;
  }

  const withCallers = routes.filter((r) => r.callers.length > 0);
  const quiet = routes.filter((r) => r.callers.length === 0);
  const callerRepos = new Set(withCallers.flatMap((r) => r.callers.map((c) => c.seam.repo)));
  const callerCount = withCallers.reduce((sum, r) => sum + r.callers.length, 0);
  const out = [`${scope} · ${count(routes.length, "route")}, ${count(callerCount, "caller")} in ${count(callerRepos.size, "repo")} · llm-generated`];

  const shown = format === "detailed" ? routes : withCallers;
  const page = shown.slice(offset, offset + PAGE_SIZE);
  for (const { route, also, callers } of page) {
    const where = path ? lineRange(route.startLine, route.endLine) : `${route.path}:${lineRange(route.startLine, route.endLine)}`;
    out.push("", `${route.method} ${route.rawPath}  (${where})`);
    if (also.length) out.push(`  ${alsoDeclared(also)}`);
    if (callers.length === 0) out.push("  no known callers");
    for (const { seam, match } of callers) {
      const quality = match === "suffix" || format === "detailed" ? ` · ${match}` : "";
      out.push(`  ← ${pointer(seam)}${quality}${seam.repo === repo ? " · same repo" : ""}`);
    }
  }
  if (format !== "detailed" && quiet.length > 0) {
    const names = quiet.slice(0, 8).map((r) => `${r.route.method} ${r.route.rawPath}`);
    out.push("", `No known callers: ${names.join(", ")}${quiet.length > 8 ? `, +${quiet.length - 8} more` : ""}`);
  }
  out.push(
    ...(await footer(deps, {
      total: shown.length,
      offset,
      pageLength: page.length,
      suffix: withCallers.some((r) => r.callers.some((c) => c.match === "suffix")),
      freshnessRepos: [repo, ...callerRepos],
      unresolvedIn: readable,
      relevantRepos: [repo, ...callerRepos],
      closing: "Only enrolled repos are covered. Confirm in the repo before editing.",
    })),
  );
  return out.join("\n");
}
