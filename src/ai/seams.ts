import { cleanPath } from "../core/citations.js";
import { changedFiles, withWorktree } from "../core/git.js";
import { normalisePath, PARAM } from "../core/http.js";
import { detectLanguage } from "../core/languages.js";
import { normaliseName, withoutVersion, type NamedFamily } from "../core/links.js";
import { familyOf, type Seam, type SeamCite, type SeamKind } from "../core/seams.js";
import { BrainError } from "../core/types.js";
import { requireRepo } from "../ingest/registry.js";
import type { Store } from "../store/store.js";
import { citationProblem, fileReader, loose, methodShown, spanText } from "./check.js";
import { DEFAULT_MODEL } from "./generate.js";
import { prompt } from "./prompts.js";
import type { Runner } from "./runner.js";

const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "*"]);
/** Files in these languages never declare a route or make a call, so changing one costs no run. */
const NEVER_SEAMS = new Set(["Markdown", "CSS", "SCSS", "Less"]);
/** Package manifests with no known language, which can still publish or use a package. */
const MANIFESTS = new Set(["requirements.txt", "go.mod", "Gemfile", "Pipfile", "setup.cfg", "packages.config"]);
/** Events, gRPC and packages: named, not a method and path. Their kinds are stored as given. */
const NAMED_KINDS = new Set<string>(["event-publish", "event-subscribe", "grpc-serve", "grpc-call", "package-publish", "package-use"]);
/** Kinds that declare something, so their name must be known; the rest may name it at run time. */
const KNOWN_NAMES = new Set<string>(["route", "grpc-serve", "package-publish", "package-use"]);

const CITES = {
  type: "array",
  minItems: 1,
  items: {
    type: "object",
    properties: { file: { type: "string" }, start: { type: "integer" }, end: { type: "integer" } },
    required: ["file", "start", "end"],
  },
};

function schema(fields: Record<string, unknown>): object {
  return {
    type: "object",
    properties: {
      seams: {
        type: "array",
        items: { type: "object", properties: { ...fields, runtime: { type: "boolean" }, cites: CITES }, required: [...Object.keys(fields), "runtime", "cites"] },
      },
    },
    required: ["seams"],
  };
}

/** One Claude Code run, with its prompt, schema and the kinds it may list. */
interface Pass {
  prompt: string;
  schema: object;
  kinds: ReadonlySet<string>;
  /** Whether a changed file could hold one of its kinds. */
  covers: (path: string) => boolean;
  /** Whether a full map asks once more for what the first run missed. */
  sweep: boolean;
}

/**
 * HTTP and the other links are mapped in separate runs. One run asked for both listed a quarter
 * fewer routes and a third fewer calls on eShop, so HTTP keeps the prompt it was tuned on.
 */
const PASSES: readonly Pass[] = [
  {
    prompt: "list-seams",
    schema: schema({ kind: { type: "string", enum: ["route", "call"] }, method: { type: "string" }, path: { type: "string" } }),
    kinds: new Set(["route", "call"]),
    covers: (path) => detectLanguage(path) !== null,
    sweep: false,
  },
  {
    prompt: "list-links",
    schema: schema({ kind: { type: "string", enum: [...NAMED_KINDS] }, name: { type: "string" } }),
    kinds: NAMED_KINDS,
    covers: () => true,
    // On eshop the links run stopped early, skipping whole files: the web app's event handlers and
    // the mobile app's gRPC calls were missed in two runs of three.
    sweep: true,
  },
];

/**
 * One entry of the AI's answer, before verification. A route or call has a method and path; the
 * other kinds (an event published or subscribed to, a gRPC method served or called, a package
 * published or used) have a name instead.
 */
export interface FoundSeam {
  kind: "route" | "call" | Exclude<SeamKind, "http-route" | "http-call">;
  method?: string;
  path?: string;
  name?: string;
  runtime: boolean;
  cites: { file: string; start: number; end: number }[];
}

export interface DroppedSeam {
  /** How the AI described it, e.g. "route GET /api/tags (src/tags.ts:3)" or "event-publish OrderStarted (src/a.cs:9)". */
  seam: string;
  reason: string;
}

export interface SeamsResult {
  repo: string;
  commit: string;
  /** "full": the whole repo was mapped; "update": only `redone` files. */
  mode: "full" | "update";
  /** Files whose seams were listed again in an update. Empty: nothing that could declare one changed, so no run. */
  redone: string[];
  kept: Seam[];
  /** What was still dropped after the second pass (or the first, if nothing was). */
  dropped: DroppedSeam[];
  /** How many the first pass dropped and were asked for again; 0 when none were. */
  retried: number;
  /** How many a full map's second look found that the first run had missed. */
  swept: number;
  costUsd: number;
  /** Time taken, start to finish; the runs go side by side, so less than their sum. */
  durationMs: number;
}

export interface SeamOptions {
  model?: string;
  /** Map the whole repo again even if its seams exist. */
  full?: boolean;
}

/**
 * Has Claude Code list the HTTP routes a repo serves and the calls it makes, the events it
 * publishes and handles, the gRPC methods it serves and calls, and the packages it publishes and
 * uses, at the commit the brain has indexed, verifies each against the lines it cites, and
 * stores what passes. The first run maps the whole repo. After that only files that changed are
 * mapped again, plus any file whose seams cite a changed file (a moved prefix or base URL), so a
 * change costs little and a Markdown-only change costs nothing.
 */
export async function updateSeams(store: Store, runner: Runner, name: string, options: SeamOptions = {}): Promise<SeamsResult> {
  const repo = requireRepo(store, name);
  const state = store.getState(name);
  if (!state) throw new BrainError(`"${name}" has not been synced yet. Run: brain sync ${name}`);

  const changes = !options.full && state.seamsCommit ? await changedFiles(repo.path, state.seamsCommit, state.commit) : null;
  let redo: string[] | null = null;
  if (changes) {
    const changed = new Set(changes.map((c) => c.path));
    const files = new Set(changes.filter((c) => c.status !== "D" && mayDeclareSeams(c.path)).map((c) => c.path));
    for (const seam of store.seams({ repos: [name], includeUnresolved: true })) {
      if (seam.cites.some((cite) => changed.has(cite.path))) files.add(seam.path);
    }
    redo = [...files].sort();
    if (redo.length === 0) {
      store.replaceSeams(name, { commit: state.commit, paths: [], seams: [] });
      return { repo: name, commit: state.commit, mode: "update", redone: [], kept: [], dropped: [], retried: 0, swept: 0, costUsd: 0, durationMs: 0 };
    }
  }

  const started = Date.now();
  let costUsd = 0;
  const list = async (cwd: string, pass: Pass, scope: string): Promise<unknown[]> => {
    const run = await runner.run<{ seams?: unknown }>({ cwd, prompt: prompt(pass.prompt, { scope }), schema: pass.schema, model: options.model ?? DEFAULT_MODEL });
    costUsd += run.costUsd;
    if (!Array.isArray(run.output?.seams)) throw new BrainError("The AI's seam list was malformed. Nothing was stored.");
    return run.output.seams.filter((item) => pass.kinds.has((item as Partial<FoundSeam>)?.kind ?? ""));
  };
  type Mapped = { kept: Seam[]; dropped: DroppedSeam[]; retried: number };
  const map = async (cwd: string, pass: Pass, scope: string): Promise<Mapped> => {
    const first = verifySeams(await list(cwd, pass, scope), cwd, name, state.commit, redo);
    if (first.dropped.length === 0) return { ...first, retried: 0 };
    // Output varies between runs and a contributing line is easy to leave out; ask once more for
    // just the dropped entries, with the reasons, before giving up on them.
    try {
      const second = verifySeams(await list(cwd, pass, retryScope(first.dropped, redo)), cwd, name, state.commit, redo);
      return { kept: uniqueSeams([...first.kept, ...second.kept]), dropped: second.dropped, retried: first.dropped.length };
    } catch (error) {
      if (!(error instanceof BrainError)) throw error;
      return { ...first, retried: 0 };
    }
  };

  // A full map of a pass that sweeps then asks once more, with what was found, for anything missed.
  // Its additions go through the same check. Updates cover only a few files, so they don't sweep.
  const run = async (cwd: string, pass: Pass): Promise<Mapped & { swept: number }> => {
    const found = await map(cwd, pass, scopeText(redo));
    if (redo || !pass.sweep) return { ...found, swept: 0 };
    try {
      const more = await map(cwd, pass, sweepScope(found.kept));
      const kept = uniqueSeams([...found.kept, ...more.kept]);
      return { kept, dropped: [...found.dropped, ...more.dropped], retried: found.retried + more.retried, swept: kept.length - found.kept.length };
    } catch (error) {
      if (!(error instanceof BrainError)) throw error;
      return { ...found, swept: 0 };
    }
  };

  const { kept, dropped, retried, swept } = await withWorktree(repo.path, state.commit, async (cwd) => {
    // The runs are independent and only read the worktree, so they go side by side. An update
    // runs one only when a file it's redoing could hold that run's kinds.
    const results = await Promise.all(PASSES.filter((pass) => !redo || redo.some(pass.covers)).map((pass) => run(cwd, pass)));
    const total = (key: "retried" | "swept") => results.reduce((sum, r) => sum + r[key], 0);
    return { kept: results.flatMap((r) => r.kept), dropped: results.flatMap((r) => r.dropped), retried: total("retried"), swept: total("swept") };
  });

  store.replaceSeams(name, { commit: state.commit, paths: redo, seams: kept });
  return {
    repo: name,
    commit: state.commit,
    mode: redo ? "update" : "full",
    redone: redo ?? [],
    kept,
    dropped,
    retried,
    swept,
    costUsd,
    durationMs: Date.now() - started,
  };
}

function sweepScope(found: readonly Seam[]): string {
  return [
    "Cover the whole repository. An earlier pass found these, and may have stopped before it had looked everywhere:",
    ...(found.length ? found.map((s) => `- ${s.kind} ${s.rawPath} (${s.path})`) : ["- (none)"]),
    "Go through every service, app and project in turn (web, mobile and desktop front ends, APIs, workers, tests) and list only the ones it missed. An empty list is a fine answer.",
  ].join("\n");
}

function retryScope(dropped: readonly DroppedSeam[], redo: readonly string[] | null): string {
  return [
    "An earlier pass listed these, and the automatic check dropped them for the reasons given:",
    ...dropped.map((d) => `- ${d.seam}: ${d.reason}`),
    "List again only the ones that are real, this time citing every line each fixed segment of the path, or each part of the name, comes from (such as a base-URL constant, a route prefix or the class a method belongs to), and leave out any you can't support.",
    ...(redo ? ["Only these files are being mapped:", ...redo.map((path) => `- ${path}`)] : []),
  ].join("\n");
}

function scopeText(redo: readonly string[] | null): string {
  if (!redo) return "Cover the whole repository.";
  return [
    "Only list entries declared in these files. Read any other file you need to resolve prefixes, base URLs and names:",
    ...redo.map((path) => `- ${path}`),
  ].join("\n");
}

function mayDeclareSeams(path: string): boolean {
  const language = detectLanguage(path);
  return language === null ? MANIFESTS.has(path.split("/").at(-1)!) : !NEVER_SEAMS.has(language);
}

/**
 * Keeps the entries the cited code supports, against the repo checked out at `root`. Entries
 * declared outside `only` (when given) are ignored, since only those files are being redone.
 */
export function verifySeams(
  found: readonly unknown[],
  root: string,
  repo: string,
  commit: string,
  only: readonly string[] | null = null,
): { kept: Seam[]; dropped: DroppedSeam[] } {
  const linesOf = fileReader(root);
  const kept: Seam[] = [];
  const dropped: DroppedSeam[] = [];
  for (const item of found) {
    const reason = problemWith(item, linesOf);
    if (reason) {
      dropped.push({ seam: describe(item), reason });
      continue;
    }
    const entry = item as FoundSeam;
    const cites = entry.cites.map((c) => ({ path: cleanPath(c.file), start: c.start, end: c.end }));
    if (entry.kind === "call" && !entry.runtime) moveCallSiteFirst(cites, entry.path!, linesOf);
    const [declared, ...contributing] = cites;
    if (only && !only.includes(declared!.path)) continue;
    const place = { repo, path: declared!.path, startLine: declared!.start, endLine: declared!.end, cites: contributing, commit };
    if (NAMED_KINDS.has(entry.kind)) {
      // Named kinds fit the HTTP columns: the family stands in for the method, the name for the path.
      const kind = entry.kind as SeamKind;
      const family = familyOf(kind) as NamedFamily;
      const rawPath = entry.name!.trim();
      kept.push({ ...place, kind, method: family, rawPath, key: entry.runtime ? null : normaliseName(family, rawPath) });
      continue;
    }
    kept.push({
      ...place,
      kind: entry.kind === "route" ? "http-route" : "http-call",
      method: entry.method!.toUpperCase(),
      rawPath: entry.path!.trim(),
      key: entry.runtime ? null : normalisePath(entry.path!),
    });
  }
  return { kept: uniqueSeams(kept), dropped };
}

/** One of each seam: the same kind, method and path declared at the same line. */
function uniqueSeams(seams: readonly Seam[]): Seam[] {
  return [...new Map(seams.map((s) => [`${s.kind} ${s.method} ${s.key ?? s.rawPath} ${s.path}:${s.startLine}`, s])).values()];
}

/**
 * Why an entry isn't supported by what it cites, or null. Its files and lines must exist; a
 * method other than GET (the default almost everywhere) must appear in the cited lines; and
 * every fixed segment of its path must too, which is how a prefix three files away is proven.
 * A named entry (an event, gRPC method or package) needs its name, or each part of it, in the
 * cited lines. A run-time URL or name only needs its call site.
 */
function problemWith(item: unknown, linesOf: (path: string) => string[] | null): string | null {
  const entry = item as Partial<FoundSeam>;
  const named = typeof entry?.kind === "string" && NAMED_KINDS.has(entry.kind);
  const shaped =
    (entry?.kind === "route" || entry?.kind === "call" || named) &&
    (named ? nonEmpty(entry.name) : typeof entry.method === "string" && nonEmpty(entry.path)) &&
    typeof entry.runtime === "boolean" &&
    Array.isArray(entry.cites) &&
    entry.cites.length > 0 &&
    entry.cites.every((c) => typeof c?.file === "string" && typeof c.start === "number" && typeof c.end === "number");
  if (!shaped) return "malformed entry";
  const method = named ? "" : entry.method!.toUpperCase();
  if (!named && !METHODS.has(method)) return `unknown method "${entry.method}"`;
  if (entry.runtime && KNOWN_NAMES.has(entry.kind!)) return named ? `a ${entry.kind}'s name must be known` : "a route's path must be known";
  const family = named ? (familyOf(entry.kind as SeamKind) as NamedFamily) : null;
  if (family && !entry.runtime && !normaliseName(family, entry.name!)) {
    return family === "grpc" ? `"${entry.name}" isn't a gRPC Service/Method` : `"${entry.name}" isn't a ${family} name`;
  }

  const spans: string[] = [];
  for (const cite of entry.cites!) {
    const lines = linesOf(cleanPath(cite.file));
    const problem = citationProblem({ path: cleanPath(cite.file), start: cite.start, end: cite.end }, lines);
    if (problem) return problem;
    spans.push(spanText(lines!, { path: cite.file, start: cite.start, end: cite.end }));
  }
  if (entry.runtime) return null;
  const shown = (part: string) => spans.some((span) => span.includes(part.toLowerCase()) || loose(span).includes(loose(part)));
  if (named) {
    const name = family === "package" ? withoutVersion(entry.name!) : entry.name!.trim();
    const missing = shown(name) ? undefined : name.split(/[/.:\s]+/).find((part) => part && !shown(part));
    return missing === undefined ? null : `"${missing}" isn't in the cited lines`;
  }

  if (method !== "GET" && method !== "*" && !methodShown(method, spans)) return `${method} isn't in the cited lines`;
  for (const segment of normalisePath(entry.path!).split("/")) {
    if (!segment || segment === PARAM) continue;
    if (!shown(segment)) return `"${segment}" isn't in the cited lines`;
  }
  return null;
}

function nonEmpty(value: unknown): boolean {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * A call's location is where its path is written, not a shared HTTP wrapper or a base-URL
 * constant in the same file: among the cites in the file the AI cited first, the one holding the
 * path's last fixed segment (what tells this call from the others), then the most of its
 * segments, moves to the front; the first on a tie. Other files stay where they are, since a
 * call built with url_for() cites the route it names, and that route isn't where the call is.
 */
function moveCallSiteFirst(cites: SeamCite[], path: string, linesOf: (path: string) => string[] | null): void {
  const segments = normalisePath(path).split("/").filter((s) => s && s !== PARAM);
  const score = (cite: SeamCite) => {
    const text = loose(linesOf(cite.path)!.slice(cite.start - 1, cite.end).join("\n"));
    const held = segments.filter((segment) => text.includes(loose(segment)));
    return (held.includes(segments.at(-1)!) ? segments.length + 1 : 0) + held.length;
  };
  let best = 0;
  cites.forEach((cite, i) => {
    if (cite.path === cites[0]!.path && score(cite) > score(cites[best]!)) best = i;
  });
  cites.unshift(...cites.splice(best, 1));
}

function describe(item: unknown): string {
  const entry = item as Partial<FoundSeam>;
  const at = Array.isArray(entry?.cites) && entry.cites[0] ? ` (${entry.cites[0].file}:${entry.cites[0].start})` : "";
  if (typeof entry?.kind === "string" && NAMED_KINDS.has(entry.kind)) return `${entry.kind} ${entry.name ?? "?"}${at}`;
  return `${entry?.kind ?? "?"} ${entry?.method ?? "?"} ${entry?.path ?? "?"}${at}`;
}
