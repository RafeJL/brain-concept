import { loose } from "../ai/check.js";
import { seamRef, type TraceLink, type TraceStep } from "../core/traces.js";
import { familyOf, FAMILIES, type Seam } from "../core/seams.js";
import type { WikiPage } from "../core/types.js";
import type { Store } from "../store/store.js";
import { lineRange, linkCalls } from "./tools/common.js";

/**
 * Children shown per step in a concise trace; the rest are counted. In production systems the
 * median service calls four others (Alibaba and Meta traces), so most steps show in full.
 */
const FAN_SHOWN = 5;

/** One step of a trace: an entry point and what its handling reaches, each reached thing followed in turn. */
export interface TraceNode {
  repo: string;
  /** What reaches here: "start", a call or event from the step above, or a table read after a write. */
  via: string;
  entry: string;
  label: string;
  pointer: string;
  outcome:
    | { type: "reaches"; reached: Reached[] }
    | { type: "ends"; pointer: string }
    | { type: "unmapped"; reason?: string }
    | { type: "loop" };
}

/** Something an entry point reaches, and where it goes next. */
export interface Reached {
  what: string;
  /** The chain's linking names and where it ends: "via CreateOrderAsync → Handle (…:32)". */
  how: string;
  next: TraceNode[];
  /** Repos it continues in that the caller can't read: counted, never named. */
  hidden: number;
  /** Set when what is reached is named only at run time (a URL or queue from config): it can't be followed. */
  runtime?: boolean;
  /** Set when what's reached is a table read or written. */
  table?: { name: string; access: "read" | "write" };
}

/**
 * Follows what an entry point's handling sets off, hop by hop: each exit point to whoever serves
 * or handles it (in any readable repo, or the same one), and each table write to the jobs of the
 * same repo that poll that table. Tables aren't followed across repos: services'
 * same-named tables are usually different databases. No depth limit: a visited set stops loops
 * and the link map is finite, so it always ends. No AI; built from checked chains when asked.
 */
export function traceFrom(store: Store, readable: readonly string[], starts: readonly Seam[]): TraceNode[] {
  const all = store.listRepos().map((r) => r.name);
  const seams = new Map(all.map((repo) => [repo, store.seams({ repos: [repo], includeUnresolved: true })]));
  const links = new Map<string, TraceLink[]>();
  const linksOf = (repo: string) => links.get(repo) ?? links.set(repo, store.traceLinks(repo)).get(repo)!;
  const visited = new Set<string>();

  const visit = (repo: string, entry: string, label: string, pointer: string, via: string): TraceNode => {
    const node: TraceNode = { repo, via, entry, label, pointer, outcome: { type: "unmapped" } };
    const id = `${repo}\u0000${entry}`;
    if (visited.has(id)) return { ...node, outcome: { type: "loop" } };
    visited.add(id);
    const all = linksOf(repo).filter((l) => l.entry === entry);
    const failed = all.find((l) => l.target.type === "unmapped");
    const chains = all.filter((l) => l.target.type !== "unmapped");
    if (chains.length === 0) {
      if (failed?.target.type === "unmapped") return { ...node, outcome: { type: "unmapped", reason: failed.target.reason } };
      const inherited = seams.get(repo)?.find((s) => s.derived && seamRef(s) === entry);
      const base = inherited?.cites[0];
      return base ? { ...node, outcome: { type: "unmapped", reason: `inherited from a base class, so its handling is the base method at ${base.path}:${lineRange(base.start, base.end)}` } } : node;
    }
    const ends = chains.find((l) => l.target.type === "none");
    if (ends) return { ...node, outcome: { type: "ends", pointer: stepPointer(ends.steps[0]!) } };

    const reached: Reached[] = [];
    for (const chain of chains) {
      const how = howOf(chain.steps);
      if (chain.target.type === "exit") {
        const ref = chain.target.ref;
        const exits = seams.get(repo)!.filter((s) => seamRef(s) === ref);
        const { next, hidden } = followExit(exits, readable, seams, (s) => visit(s.repo, seamRef(s), labelOf(s), `${s.path}:${lineRange(s.startLine, s.endLine)}`, ref));
        const runtime = exits.length > 0 && exits.every((x) => x.key === null);
        reached.push({ what: exitWords(ref), how, next, hidden, ...(runtime ? { runtime } : {}) });
      } else if (chain.target.type === "table") {
        const { name, access } = chain.target;
        // A write carries the flow on only to what runs by itself and reads that table: a job polling
        // it. A route or handler reading the same table is set off by its own caller, not by the write.
        const readers =
          access === "write"
            ? linksOf(repo).filter((l) => l.entryKind === "job" && l.target.type === "table" && l.target.access === "read" && tableKey(l.target.name) === tableKey(name))
            : [];
        const next = [...new Map(readers.map((r) => [r.entry, r])).values()].map((r) =>
          visit(repo, r.entry, `${kindLabel(r.entryKind)} ${r.entryLabel}`, `${r.entryPath}:${r.entryLine}`, `table ${name}`),
        );
        reached.push({ what: `${access === "write" ? "writes" : "reads"} table ${name}`, how, next, hidden: 0, table: { name, access } });
      }
    }
    return { ...node, outcome: { type: "reaches", reached } };
  };

  return starts.map((s) => visit(s.repo, seamRef(s), labelOf(s), `${s.path}:${lineRange(s.startLine, s.endLine)}`, "start"));
}

/** Who serves a call or handles a published event, among all repos; those the caller can't read are only counted. */
function followExit(all: readonly Seam[], readable: readonly string[], seams: ReadonlyMap<string, Seam[]>, visit: (s: Seam) => TraceNode): { next: TraceNode[]; hidden: number } {
  // Only a named exit can be matched; one named at run time leads nowhere the brain can see.
  const exits = all.filter((x) => x.key !== null);
  if (exits.length === 0) return { next: [], hidden: 0 };
  const family = familyOf(exits[0]!.kind);
  const every = [...seams.values()].flat().filter((s) => s.key !== null);
  const targets =
    family === "event"
      ? every.filter((s) => s.kind === FAMILIES.event.uses && exits.some((x) => x.key === s.key))
      : (() => {
          const providers = every.filter((s) => s.kind === FAMILIES[family].provides);
          return linkCalls(exits, providers, providers).map((link) => link.route);
        })();
  const unique = [...new Map(targets.map((t) => [`${t.repo}\u0000${seamRef(t)}`, t])).values()];
  const shown = unique.filter((t) => readable.includes(t.repo));
  return { next: shown.map(visit), hidden: new Set(unique.filter((t) => !readable.includes(t.repo)).map((t) => t.repo)).size };
}

/**
 * A table's name as code in one repo spells it in different places: `ordering.orders`,
 * `[dbo].[Orders]`, `"orders"` and `Orders` are the same table. The schema, quotes and case go.
 */
export function tableKey(name: string): string {
  return loose(name.replace(/["'`[\]]/g, "").split(".").at(-1) ?? name);
}

function labelOf(seam: Seam): string {
  const what = seam.kind.startsWith("http-") ? `${seam.method} ${seam.rawPath}` : seam.rawPath;
  return seam.kind === "event-subscribe" ? `handles ${what}` : seam.kind === "grpc-serve" ? `serves ${what}` : what;
}

function kindLabel(kind: TraceLink["entryKind"]): string {
  return kind === "job" ? "job" : kind === "ui" ? "UI action" : "";
}

function exitWords(ref: string): string {
  const [kind, ...rest] = ref.split(" ");
  const what = rest.join(" ");
  return kind === "event-publish" ? `publishes ${what}` : kind === "grpc-call" ? `calls gRPC ${what}` : `calls ${what}`;
}

function stepPointer(step: TraceStep): string {
  return `${step.path}:${lineRange(step.start, step.end)}`;
}

/** "via CreateOrderAsync → Handle (CreateOrderCommandHandler.cs:32)": the names linking the steps, and where it ends. */
function howOf(steps: readonly TraceStep[]): string {
  const names = steps.flatMap((s) => (s.calls ? [s.calls] : []));
  const last = steps.at(-1)!;
  return `${names.length ? `via ${names.join(" → ")} ` : ""}(${stepPointer(last)})`;
}

/**
 * The trace as lines: each step indented under the one that reaches it. Concise output shows up
 * to FAN_SHOWN things reached per step and counts the rest; detailed shows all, with every step
 * of each chain.
 */
export function renderTrace(nodes: readonly TraceNode[], detailed: boolean, store: Store): string[] {
  const out: string[] = [];
  const pages = new Map<string, Set<string>>();
  const page = (repo: string, path: string) => {
    const found = pageCiting(store.pages(repo), path);
    if (found) pages.set(repo, (pages.get(repo) ?? new Set()).add(found));
  };
  const walk = (node: TraceNode, depth: number) => {
    const pad = "  ".repeat(depth);
    page(node.repo, node.pointer.replace(/:\d.*$/, ""));
    const head = `${pad}${node.repo} · ${node.label.trim()} · ${node.pointer}`;
    switch (node.outcome.type) {
      case "unmapped":
        out.push(
          node.outcome.reason?.startsWith("inherited")
            ? `${head} · ${node.outcome.reason}`
            : node.outcome.reason
              ? `${head} · not mapped: no chain from it held at this commit (${node.outcome.reason})`
              : `${head} · not mapped yet (what it leads to hasn't been traced)`,
        );
        return;
      case "loop":
        out.push(`${head} · goes back to a step above`);
        return;
      case "ends":
        out.push(`${head} · ends here: reaches no other service or table (${node.outcome.pointer})`);
        return;
    }
    out.push(head);
    const reached = node.outcome.reached;
    if (reached.some((r) => r.table)) pages.set(node.repo, (pages.get(node.repo) ?? new Set()).add("data-model"));
    // Concise: tables the flow doesn't continue from go on one line, so the hops stay readable.
    const quiet = detailed ? [] : reached.filter((r) => r.table && r.next.length === 0);
    if (quiet.length) {
      const names = (access: "read" | "write") => [...new Set(quiet.filter((r) => r.table!.access === access).map((r) => r.table!.name))];
      const parts = [names("read").length ? `reads ${names("read").join(", ")}` : "", names("write").length ? `writes ${names("write").join(", ")}` : ""].filter(Boolean);
      out.push(`${pad}  tables: ${parts.join(" · ")}`);
    }
    const flowing = reached.filter((r) => !quiet.includes(r));
    const shown = detailed ? flowing : flowing.slice(0, FAN_SHOWN);
    for (const r of shown) {
      out.push(`${pad}  → ${r.what} ${r.how}`);
      const next = detailed ? r.next : r.next.slice(0, FAN_SHOWN);
      for (const child of next) walk(child, depth + 2);
      if (next.length < r.next.length) out.push(`${pad}      +${r.next.length - next.length} more (format detailed shows them)`);
      if (r.hidden) out.push(`${pad}      continues in ${r.hidden === 1 ? "a repo" : `${r.hidden} repos`} you can't read`);
      if (r.runtime) out.push(`${pad}      (named only at run time, so where it goes can't be followed)`);
      else if (!r.next.length && !r.hidden && !r.table) out.push(`${pad}      (nothing enrolled serves or handles it)`);
    }
    if (shown.length < flowing.length) out.push(`${pad}  +${flowing.length - shown.length} more things it reaches (format detailed shows them)`);
  };
  for (const node of nodes) walk(node, 0);
  const reading = [...pages].flatMap(([repo, slugs]) => [...slugs].filter((s) => store.pages(repo).some((p) => p.slug === s)).map((s) => `${repo} ${s}`));
  if (reading.length) out.push("", `Read along the way: ${reading.join(", ")} (brain_get)`);
  return out;
}

/** The page that cites a file, preferring an area or flow page, so a planner knows where that code is described. */
function pageCiting(pages: readonly WikiPage[], path: string): string | null {
  const citing = pages.filter((p) => p.markdown.includes(`[${path}:`) || p.markdown.includes(` ${path}:`) || p.markdown.includes(`; ${path}:`));
  const best = citing.find((p) => p.kind === "area" || p.kind === "flow") ?? citing.find((p) => p.slug !== "product");
  return best?.slug ?? null;
}
