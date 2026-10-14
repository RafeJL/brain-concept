import { matchEndpoints, type MatchQuality } from "../../core/http.js";
import { parseTarget, type LinkTarget } from "../../core/links.js";
import { familyOf, isProvider, type Seam } from "../../core/seams.js";
import { seamRef } from "../../core/traces.js";
import type { Caller } from "../access.js";
import { coverageNote } from "../coverage.js";
import { renderTrace, traceFrom } from "../trace.js";
import {
  alsoDeclared,
  builtFrom,
  count,
  endpointOf,
  FAMILY_LABEL,
  footer,
  groupRoutes,
  NO_REPOS,
  PAGE_SIZE,
  pointer,
  readableRepos,
  ROLES,
  TIER,
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
  /** Also trace what handling it sets off, hop by hop across repos. */
  follow?: boolean;
}

export interface Hit {
  /** "server": serves, publishes or declares it; "caller": calls, handles or depends on it. */
  role: "server" | "caller";
  seam: Seam;
  match: MatchQuality;
  /** For servers: the same endpoint declared elsewhere in the repo (OpenAPI specs). */
  also: Seam[];
}

export interface Consumers {
  target: LinkTarget;
  hits: Hit[];
}

/**
 * Who serves and who calls an endpoint, or who publishes and who handles an event, serves and
 * calls a gRPC method, or publishes and depends on a package, across every repo the caller can read.
 */
export async function findConsumers(deps: ToolDeps, caller: Caller, input: ConsumersInput): Promise<ToolResult<Consumers>> {
  const target = parseTarget(input.target, input.method);
  if (!target) {
    return {
      ok: false,
      text: `"${input.target}" is not an endpoint, event, gRPC method or package. Try "GET /api/orders/{id}", "event OrderStarted", "grpc Basket/GetBasket" or "package @citation/ui".`,
    };
  }
  const readable = await readableRepos(deps, caller);
  const scope = input.repos?.length ? readable.filter((name) => input.repos!.includes(name)) : readable;
  if (readable.length === 0) return { ok: false, text: NO_REPOS };
  if (scope.length === 0) return { ok: false, text: `None of the requested repos are enrolled or readable. Repos you can read: ${readable.join(", ")}.` };

  const matches = deps.store.seams({ repos: scope }).flatMap((seam) => {
    if (familyOf(seam.kind) !== target.family) return [];
    const match = target.family === "http" ? matchEndpoints(endpointOf(seam), target.endpoint) : seam.key === target.key ? "exact" : null;
    return match ? [{ seam, match }] : [];
  });
  const matchOf = new Map(matches.map(({ seam, match }) => [seam, match]));
  const servers = groupRoutes(matches.filter(({ seam }) => isProvider(seam.kind)).map(({ seam }) => seam));
  const serving = new Set(servers.map((s) => s.primary.repo));
  // A repo calling an endpoint it serves itself (its tests, its own front end) is listed after other callers.
  const selfCall = (hit: Hit) => hit.role === "caller" && serving.has(hit.seam.repo);
  const hits: Hit[] = [
    ...servers.map(({ primary, also }): Hit => ({ role: "server", seam: primary, match: matchOf.get(primary)!, also })),
    ...matches.filter(({ seam }) => !isProvider(seam.kind)).map(({ seam, match }): Hit => ({ role: "caller", seam, match, also: [] })),
  ].sort(
    (a, b) =>
      Number(a.role === "caller") - Number(b.role === "caller") ||
      Number(selfCall(a)) - Number(selfCall(b)) ||
      Number(a.match === "suffix") - Number(b.match === "suffix") ||
      a.seam.repo.localeCompare(b.seam.repo) ||
      a.seam.path.localeCompare(b.seam.path) ||
      a.seam.startLine - b.seam.startLine,
  );

  const data = { target, hits };
  const text = await render(deps, data, scope, input.format, input.offset ?? 0);
  return { ok: true, data, text: input.follow ? `${text}\n\n${followText(deps, data, readable, input.format)}` : text };
}

/**
 * What handling the target sets off: from each server of an endpoint or gRPC method, or each
 * handler of an event, every hop its checked chains reach, across repos.
 */
function followText(deps: ToolDeps, { target, hits }: Consumers, readable: readonly string[], format: Format): string {
  if (target.family === "package") return "follow traces endpoints, events and gRPC methods, not packages.";
  const starts = hits.filter((h) => (target.family === "event" ? h.role === "caller" : h.role === "server")).map((h) => h.seam);
  if (starts.length === 0) return `What it sets off: nothing enrolled ${target.family === "event" ? "handles" : "serves"} it.`;
  const lines = renderTrace(traceFrom(deps.store, readable, starts), format === "detailed", deps.store);
  // What starts it: the UI actions, jobs and entry points whose chains lead to each call or publish of it.
  const users = hits.filter((h) => (target.family === "event" ? h.role === "server" : h.role === "caller")).map((h) => h.seam);
  const startedFrom = [
    ...new Set(
      users.flatMap((use) =>
        deps.store
          .traceLinks(use.repo)
          .filter((l) => l.target.type === "exit" && l.target.ref === seamRef(use))
          .map((l) => `${use.repo} ${l.entryKind === "ui" ? "UI action " : l.entryKind === "job" ? "job " : ""}${l.entryLabel} (${l.entryPath}:${l.entryLine})`),
      ),
    ),
  ];
  return [
    ...(startedFrom.length ? [`Started from: ${startedFrom.slice(0, format === "detailed" ? undefined : 5).join("; ")}${format !== "detailed" && startedFrom.length > 5 ? `; +${startedFrom.length - 5} more` : ""}`, ""] : []),
    `What handling it sets off (every hop is a checked chain of cited steps; tables are followed within a repo, not between repos):`,
    ...lines,
  ].join("\n");
}

async function render(deps: ToolDeps, { target, hits }: Consumers, scope: string[], format: Format, offset: number): Promise<string> {
  const family = target.family;
  const roles = ROLES[family];
  const label = family === "http" ? `${target.endpoint.method ?? "any method"} ${target.endpoint.key}` : `${family} ${target.name}`;
  if (hits.length === 0) {
    const none = `No ${roles.provider}s or ${roles.consumer}s found for ${label}.`;
    return [none, family === "http" ? "" : similarNames(deps, scope, target), unresolvedNote(deps, scope, [], family), coverageNote(deps.store, scope, family)].filter(Boolean).join("\n");
  }

  const servers = hits.filter((h) => h.role === "server").length;
  const serving = new Set(hits.filter((h) => h.role === "server").map((h) => h.seam.repo));
  const repos = new Set(hits.map((h) => h.seam.repo));
  const page = hits.slice(offset, offset + PAGE_SIZE);
  const out = [`${label} · ${count(servers, roles.provider)}, ${count(hits.length - servers, roles.consumer)} in ${count(repos.size, "repo")} · ${TIER}`];
  for (const role of ["server", "caller"] as const) {
    const rows = page.filter((h) => h.role === role);
    if (rows.length === 0) continue;
    out.push("", role === "server" ? roles.providedBy : roles.usedBy);
    for (const { seam, match, also } of rows) {
      const what = `${seam.method} ${seam.rawPath}`;
      const notes = format === "detailed" ? ` · ${match}${builtFrom(seam)}` : match === "suffix" ? " · suffix" : "";
      const own = role === "caller" && serving.has(seam.repo) ? " · same repo" : "";
      out.push(`  ${pointer(seam)} · ${what}${notes}${own}`);
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
      relevantRepos: repos,
      families: [family],
      closing: "Confirm in the repo before editing.",
    })),
  );
  return out.join("\n");
}

/** Names match exactly, so when nothing does, the known names containing the one asked for. */
function similarNames(deps: ToolDeps, scope: readonly string[], target: Extract<LinkTarget, { family: "event" | "grpc" | "package" }>): string {
  const names = new Set(
    deps.store
      .seams({ repos: scope })
      .filter((seam) => familyOf(seam.kind) === target.family && seam.key!.includes(target.key))
      .map((seam) => seam.rawPath),
  );
  if (names.size === 0) return "";
  const shown = [...names].sort().slice(0, 5);
  return `Names match exactly. Known ${FAMILY_LABEL[target.family]} names containing "${target.name}": ${shown.join(", ")}${names.size > 5 ? `, +${names.size - 5} more` : ""}.`;
}
