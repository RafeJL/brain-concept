import { matchEndpoints, type MatchQuality } from "../../core/http.js";
import { parseTarget } from "../../core/links.js";
import { familyOf, isProvider, type Seam, type SeamFamily } from "../../core/seams.js";
import type { Caller } from "../access.js";
import { absenceNote } from "../coverage.js";
import {
  alsoDeclared,
  count,
  endpointOf,
  FAMILY_LABEL,
  footer,
  groupRoutes,
  lineRange,
  linkCalls,
  PAGE_SIZE,
  pointer,
  requireSyncedRepo,
  TIER,
  type Format,
  type ToolDeps,
  type ToolResult,
} from "./common.js";

export interface ImpactInput {
  repo: string;
  /** A file in the repo: only what is declared there. */
  path?: string;
  /** An endpoint, event, gRPC method or package: only what the repo provides matching it. */
  route?: string;
  format: Format;
  offset?: number;
}

/** Something the repo provides (a route, a published event, a gRPC method, a package) and who uses it. */
export interface RouteImpact {
  route: Seam;
  /** The same endpoint declared elsewhere in the repo, e.g. in an OpenAPI spec. */
  also: Seam[];
  callers: Array<{ seam: Seam; match: MatchQuality }>;
}

export interface Impact {
  repo: string;
  path?: string;
  /** Everything provided, routes or not. */
  routes: RouteImpact[];
  /** Calls the file or repo makes itself; reported so an empty answer still says something. */
  outgoingCalls: number;
  /** The same for its event subscriptions, gRPC calls and package dependencies. */
  otherUses: number;
  /** The family asked about: whose map's coverage an empty answer reports. */
  family: SeamFamily;
}

/**
 * The seam-level blast radius of changing a repo, a file in it, or one endpoint: the routes it
 * serves, events it publishes, gRPC methods it serves and packages it publishes, and who uses
 * each one, in any readable repo (its own included, e.g. e2e tests or its own event handlers).
 */
export async function impact(deps: ToolDeps, caller: Caller, input: ImpactInput): Promise<ToolResult<Impact>> {
  const found = await requireSyncedRepo(deps, caller, input.repo);
  if (!found.ok) return found;
  const target = input.route ? parseTarget(input.route) : null;
  if (input.route && !target) {
    return { ok: false, text: `"${input.route}" is not an endpoint, event, gRPC method or package. Try "GET /api/orders/{id}" or "event OrderStarted".` };
  }

  const path = input.path?.replace(/\\/g, "/").replace(/^\.?\//, "");
  const routes = deps.store.seams({ repos: [input.repo], path }).filter((route) => {
    if (!isProvider(route.kind)) return false;
    if (!target) return true;
    if (familyOf(route.kind) !== target.family) return false;
    return target.family === "http" ? matchEndpoints(endpointOf(route), target.endpoint) !== null : route.key === target.key;
  });
  const groups = groupRoutes(routes);
  const everything = deps.store.seams({ repos: found.readable });
  const links = linkCalls(
    everything.filter((seam) => !isProvider(seam.kind)),
    groups.map((g) => g.primary),
    everything.filter((seam) => isProvider(seam.kind)),
  );
  const impacts: RouteImpact[] = groups.map(({ primary: route, also }) => ({
    route,
    also,
    callers: links.filter((link) => link.route === route).map(({ call, match }) => ({ seam: call, match })),
  }));
  impacts.sort((a, b) => b.callers.length - a.callers.length || a.route.path.localeCompare(b.route.path) || a.route.startLine - b.route.startLine);

  const uses = deps.store.seams({ repos: [input.repo], path, includeUnresolved: true }).filter((seam) => !isProvider(seam.kind));
  const outgoingCalls = uses.filter((seam) => seam.kind === "http-call").length;
  const data: Impact = { repo: input.repo, path, routes: impacts, outgoingCalls, otherUses: uses.length - outgoingCalls, family: target?.family ?? "http" };
  return { ok: true, data, text: await render(deps, data, found.readable, input.format, input.offset ?? 0) };
}

async function render(deps: ToolDeps, { repo, path, routes, outgoingCalls, otherUses, family }: Impact, readable: string[], format: Format, offset: number): Promise<string> {
  const scope = path ? `${repo} · ${path}` : repo;
  if (routes.length === 0) {
    const uses = [
      ...(outgoingCalls ? [`makes ${count(outgoingCalls, "HTTP call")}`] : []),
      ...(otherUses ? [`has ${count(otherUses, "event subscription, gRPC call or package dependency", "event subscriptions, gRPC calls or package dependencies")}`] : []),
    ];
    const calls = uses.length ? ` It ${uses.join(" and ")}; use brain_find_consumers on one to see who provides it.` : "";
    const note = absenceNote(deps.store, repo, family, path);
    return `No matching routes, events, gRPC methods or packages are mapped in ${scope}.${calls}${note ? `\n${note}` : ""}`;
  }

  const withCallers = routes.filter((r) => r.callers.length > 0);
  const quiet = routes.filter((r) => r.callers.length === 0);
  const callerRepos = new Set(withCallers.flatMap((r) => r.callers.map((c) => c.seam.repo)));
  const callerCount = withCallers.reduce((sum, r) => sum + r.callers.length, 0);
  const out = [`${scope} · ${provided(routes.map((r) => r.route))}, ${count(callerCount, "caller")} in ${count(callerRepos.size, "repo")} · ${TIER}`];

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
      families: familiesOf(routes.map((r) => r.route)),
      closing: "Only enrolled repos are covered. Confirm in the repo before editing.",
    })),
  );
  return out.join("\n");
}

const PROVIDED: Record<SeamFamily, [string, string]> = {
  http: ["route", "routes"],
  event: ["event published", "events published"],
  grpc: ["gRPC method", "gRPC methods"],
  package: ["package", "packages"],
};

/** "2 routes, 1 event published": what is provided, by family. */
function provided(seams: readonly Seam[]): string {
  return familiesOf(seams)
    .map((family) => {
      const n = seams.filter((s) => familyOf(s.kind) === family).length;
      return `${n} ${PROVIDED[family][n === 1 ? 0 : 1]}`;
    })
    .join(", ");
}

/** The families present, HTTP first. */
function familiesOf(seams: readonly Seam[]): SeamFamily[] {
  return (Object.keys(FAMILY_LABEL) as SeamFamily[]).filter((family) => seams.some((s) => familyOf(s.kind) === family));
}
