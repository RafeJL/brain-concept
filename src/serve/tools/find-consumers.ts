import { matchKeys, methodFromVerb, normalisePath, type MatchQuality } from "../../core/http.js";
import type { Seam } from "../../core/seams.js";
import type { Caller } from "../access.js";
import {
  freshnessByRepo,
  freshnessLine,
  lineRange,
  PAGE_SIZE,
  readableRepos,
  type Format,
  type ToolDeps,
  type ToolResult,
} from "./common.js";

export interface Target {
  method: string | null;
  key: string;
}

/** Accepts "GET /api/articles/:slug", "/articles/{slug}" or a full URL. */
export function parseTarget(target: string, method?: string): Target | null {
  const match = target.trim().match(/^([A-Za-z]+)\s+(\S+)$/);
  const verb = match ? methodFromVerb(match[1]!) : null;
  const path = verb ? match![2]! : target.trim();
  const key = normalisePath(path);
  if (key === null || key === "/") return null;
  const explicit = method ? methodFromVerb(method) : null;
  return { method: explicit ?? verb, key };
}

export interface Hit {
  role: "server" | "caller";
  seam: Seam;
  match: MatchQuality;
}

export interface ConsumersInput {
  target: string;
  method?: string;
  repos?: string[];
  format: Format;
  offset?: number;
}

export interface Consumers {
  target: Target;
  hits: Hit[];
  unresolvedCalls: number;
}

/** Who serves and who calls an endpoint, across every repo the caller can read. */
export async function findConsumers(deps: ToolDeps, caller: Caller, input: ConsumersInput): Promise<ToolResult<Consumers>> {
  const target = parseTarget(input.target, input.method);
  if (!target) {
    return { ok: false, text: `"${input.target}" is not an endpoint. Try "GET /api/orders/{id}" or "/orders/:id".` };
  }
  const readable = await readableRepos(deps, caller);
  const scope = input.repos?.length ? readable.filter((name) => input.repos!.includes(name)) : readable;
  if (scope.length === 0) return { ok: false, text: "None of the requested repos are enrolled or readable." };

  const hits: Hit[] = [];
  for (const seam of deps.store.seams({ repos: scope })) {
    if (target.method && seam.method !== "*" && seam.method !== target.method) continue;
    const match = matchKeys(seam.key!, target.key);
    if (match) hits.push({ role: seam.kind === "http-route" ? "server" : "caller", seam, match });
  }
  hits.sort(
    (a, b) =>
      Number(a.role === "caller") - Number(b.role === "caller") ||
      Number(a.match === "suffix") - Number(b.match === "suffix") ||
      a.seam.repo.localeCompare(b.seam.repo) ||
      a.seam.path.localeCompare(b.seam.path) ||
      a.seam.startLine - b.seam.startLine,
  );
  const unresolvedCalls = scope.reduce((sum, repo) => sum + deps.store.seamCoverage(repo).unresolvedCalls, 0);
  const data = { target, hits, unresolvedCalls };
  return { ok: true, data, text: await render(deps, data, input.format, input.offset ?? 0) };
}

async function render(deps: ToolDeps, { target, hits, unresolvedCalls }: Consumers, format: Format, offset: number): Promise<string> {
  const label = `${target.method ?? "any method"} ${target.key}`;
  const gap =
    unresolvedCalls > 0
      ? `${unresolvedCalls} call${unresolvedCalls === 1 ? "" : "s"} in these repos use URLs only known at run time, so a missing caller isn't proof there is none.`
      : "";
  if (hits.length === 0) return [`No servers or callers found for ${label}.`, gap].filter(Boolean).join("\n");

  const servers = hits.filter((h) => h.role === "server").length;
  const repos = new Set(hits.map((h) => h.seam.repo));
  const page = hits.slice(offset, offset + PAGE_SIZE);
  const out = [
    `${label} · ${servers} server${servers === 1 ? "" : "s"}, ${hits.length - servers} caller${hits.length - servers === 1 ? "" : "s"} in ${repos.size} repo${repos.size === 1 ? "" : "s"} · parser-built`,
  ];
  for (const role of ["server", "caller"] as const) {
    const rows = page.filter((h) => h.role === role);
    if (rows.length === 0) continue;
    out.push("", role === "server" ? "Served by" : "Called by");
    for (const { seam, match } of rows) {
      const where = `${seam.repo} · ${seam.path}:${lineRange(seam.startLine, seam.endLine)}`;
      const what = `${seam.method} ${seam.rawPath}`;
      out.push(format === "detailed" ? `  ${where} · ${what} · ${match} · ${seam.plugin}` : `  ${where} · ${what}${match === "suffix" ? " · suffix" : ""}`);
    }
  }
  out.push("");
  if (hits.length > offset + PAGE_SIZE) {
    out.push(`Showing ${offset + 1}-${offset + page.length} of ${hits.length}. Pass offset=${offset + PAGE_SIZE} for more.`);
  }
  if (hits.some((h) => h.match === "suffix")) out.push("suffix = matched ignoring a base path such as /api.");
  out.push(freshnessLine(deps, await freshnessByRepo(deps, page.map((h) => h.seam.repo))));
  if (gap) out.push(gap);
  out.push("Confirm in the repo before editing.");
  return out.join("\n");
}
