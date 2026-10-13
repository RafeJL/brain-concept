import type { FactRecord } from "../../core/facts.js";
import { firstSentence } from "../../core/sections.js";
import type { SystemRecord } from "../../core/systems.js";
import type { Caller } from "../access.js";
import { factLine, readableChecks } from "../facts.js";
import { linkSummary, neighbours, type Neighbour, type Neighbours } from "../neighbours.js";
import { findSystem, quoted, visibleSystems } from "../systems.js";
import { count, indexedAt, readableRepos, type ToolDeps, type ToolResult } from "./common.js";

export interface SystemMember {
  repo: string;
  /** The product page's opening sentence; null without one. */
  product: string | null;
  routes: number;
  calls: number;
}

/** One repo's links to others: `to` are the repos it calls, with how many endpoints. */
export interface SystemLink {
  from: string;
  to: Neighbour[];
}

export interface SystemOverview {
  system: SystemRecord;
  members: SystemMember[];
  /** Calls between members. */
  within: SystemLink[];
  /** Calls from members to readable repos outside the system, and from those into it. */
  outgoing: SystemLink[];
  incoming: SystemLink[];
  /** What people stated about the system and its readable repos. */
  facts: FactRecord[];
}

/** How long a member's product sentence may run in the overview's table. */
const PRODUCT_WIDTH = 70;

/**
 * A system's overview, assembled when asked so it is never stale: its summary (from the
 * suggestion or a person), each member's product sentence (from its checked product page) and the
 * links between them (from verified seams). No AI. Only repos the caller can read are listed or
 * counted. Backs `brain_get` with `system` and `brain systems show`.
 */
export async function systemOverview(deps: ToolDeps, caller: Caller, name: string): Promise<ToolResult<SystemOverview>> {
  const readable = await readableRepos(deps, caller);
  const system = findSystem(deps.store, name, readable);
  if (!system) {
    const names = visibleSystems(deps.store, readable).map((s) => s.name);
    const list = names.length ? `Systems: ${names.join(", ")}.` : "No systems yet. Suggest them with: brain systems suggest";
    return { ok: false, text: `No system named "${name}". ${list}` };
  }

  const members = system.repos.map((repo): SystemMember => {
    const page = deps.store.pages(repo).find((p) => p.slug === "product");
    const { routes, calls } = deps.store.seamCoverage(repo);
    return { repo, product: page ? firstSentence(page.markdown) : null, routes, calls };
  });
  const within: SystemLink[] = [];
  const outgoing: SystemLink[] = [];
  const incoming = new Map<string, Neighbour[]>();
  for (const repo of system.repos) {
    const { calls, calledBy } = neighbours(deps.store, repo, readable);
    const inside = calls.filter((n) => system.repos.includes(n.repo));
    const outside = calls.filter((n) => !system.repos.includes(n.repo));
    if (inside.length) within.push({ from: repo, to: inside });
    if (outside.length) outgoing.push({ from: repo, to: outside });
    for (const outsider of calledBy.filter((n) => !system.repos.includes(n.repo))) {
      incoming.set(outsider.repo, [...(incoming.get(outsider.repo) ?? []), { ...outsider, repo }]);
    }
  }
  const data: SystemOverview = {
    system,
    members,
    within,
    outgoing,
    incoming: [...incoming].sort(([a], [b]) => a.localeCompare(b)).map(([from, to]) => ({ from, to })),
    facts: readableChecks(deps.store.facts({ repos: system.repos, systems: [system.name] }), readable),
  };
  return { ok: true, data, text: await render(deps, data) };
}

async function render(deps: ToolDeps, { system, members, within, outgoing, incoming, facts }: SystemOverview): Promise<string> {
  const width = Math.max(...members.map((m) => m.repo.length)) + 2;
  const out = [`${system.name} (${system.status}) · ${count(members.length, "repo")}`, ""];
  out.push(system.summary || `(no summary yet: add one with brain systems set ${quoted(system.name)} --summary "<one line>")`, "");
  if (facts.length) {
    out.push("From people (stated by a person, not written by Claude Code; each says whether it was confirmed)");
    for (const fact of facts) out.push(`  ${fact.repo ?? "system"}: ${factLine(fact)}`);
    out.push("");
  }
  out.push("Repos");
  for (const m of members) {
    const product = m.product ? clip(m.product, PRODUCT_WIDTH) : "(no product page yet)";
    out.push(`  ${m.repo.padEnd(width)}${product.padEnd(PRODUCT_WIDTH + 2)}${count(m.routes, "route")} · ${count(m.calls, "call")}`);
  }
  out.push("How they connect", ...(within.length ? links(within, "calls") : ["  (none found)"]));
  const outside = [...links(outgoing, "calls"), ...links(incoming, "calledBy")];
  out.push("Outside the system", ...(outside.length ? outside : ["  (none found)"]));
  out.push("");
  if (system.status === "suggested") {
    out.push(`Suggested by Claude Code from the repos' cards and links${system.reason ? `: ${system.reason}` : ""}`);
    out.push(`Not yet confirmed by a person (brain systems confirm ${quoted(system.name)}).`);
  } else {
    out.push(`Confirmed by a person${system.confirmedAt ? ` on ${system.confirmedAt.slice(0, 10)}` : ""}.`);
  }
  out.push('Each repo line is the opening of its product page (read it with brain_get, page "product"); links come from verified routes, calls, events, gRPC and packages.');
  out.push(`Indexed: ${(await indexedAt(deps, members.map((m) => m.repo))).join("; ")}`);
  return out.join("\n");
}

/**
 * "react-web → aspnet-api, express-api   (22 endpoints each)", or the counts per repo when they
 * differ. `side` says what is counted: what `from` uses of each, or its uses of each.
 */
function links(rows: readonly SystemLink[], side: keyof Neighbours): string[] {
  return rows.map(({ from, to }) => {
    const summary = to.map((n) => linkSummary(n, side));
    const targets = summary.every((s) => s === summary[0])
      ? `${to.map((n) => n.repo).join(", ")}   (${summary[0]}${to.length > 1 ? " each" : ""})`
      : to.map((n, i) => `${n.repo} (${summary[i]})`).join(", ");
    return `  ${from} → ${targets}`;
  });
}

function clip(text: string, width: number): string {
  return text.length <= width ? text : `${text.slice(0, width - 1).trimEnd()}…`;
}
