import { changedFiles, withWorktree } from "../core/git.js";
import { normalisePath, PARAM } from "../core/http.js";
import { detectLanguage } from "../core/languages.js";
import type { Seam, SeamCite } from "../core/seams.js";
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

const SCHEMA = {
  type: "object",
  properties: {
    seams: {
      type: "array",
      items: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["route", "call"] },
          method: { type: "string" },
          path: { type: "string" },
          runtime: { type: "boolean" },
          cites: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              properties: { file: { type: "string" }, start: { type: "integer" }, end: { type: "integer" } },
              required: ["file", "start", "end"],
            },
          },
        },
        required: ["kind", "method", "path", "runtime", "cites"],
      },
    },
  },
  required: ["seams"],
};

/** One entry of the AI's answer, before verification. */
export interface FoundSeam {
  kind: "route" | "call";
  method: string;
  path: string;
  runtime: boolean;
  cites: { file: string; start: number; end: number }[];
}

export interface DroppedSeam {
  /** How the AI described it, e.g. "route GET /api/tags (src/tags.ts:3)". */
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
  dropped: DroppedSeam[];
  costUsd: number;
  durationMs: number;
}

export interface SeamOptions {
  model?: string;
  /** Map the whole repo again even if its seams exist. */
  full?: boolean;
}

/**
 * Has Claude Code list the HTTP routes a repo serves and the calls it makes, at the commit the
 * brain has indexed, verifies each against the lines it cites, and stores what passes. The first
 * run maps the whole repo. After that only files that changed are mapped again, plus any file
 * whose seams cite a changed file (a moved prefix or base URL), so a change costs little and a
 * Markdown-only change costs nothing.
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
      return { repo: name, commit: state.commit, mode: "update", redone: [], kept: [], dropped: [], costUsd: 0, durationMs: 0 };
    }
  }

  const { run, kept, dropped } = await withWorktree(repo.path, state.commit, async (cwd) => {
    const run = await runner.run<{ seams?: unknown }>({
      cwd,
      prompt: prompt("list-seams", { scope: scopeText(redo) }),
      schema: SCHEMA,
      model: options.model ?? DEFAULT_MODEL,
    });
    if (!Array.isArray(run.output?.seams)) throw new BrainError("The AI's seam list was malformed. Nothing was stored.");
    return { run, ...verifySeams(run.output.seams, cwd, name, state.commit, redo) };
  });

  store.replaceSeams(name, { commit: state.commit, paths: redo, seams: kept });
  return {
    repo: name,
    commit: state.commit,
    mode: redo ? "update" : "full",
    redone: redo ?? [],
    kept,
    dropped,
    costUsd: run.costUsd,
    durationMs: run.durationMs,
  };
}

function scopeText(redo: readonly string[] | null): string {
  if (!redo) return "Cover the whole repository.";
  return [
    "Only list routes and calls declared in these files. Read any other file you need to resolve prefixes and base URLs:",
    ...redo.map((path) => `- ${path}`),
  ].join("\n");
}

function mayDeclareSeams(path: string): boolean {
  const language = detectLanguage(path);
  return language !== null && !NEVER_SEAMS.has(language);
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
  const kept = new Map<string, Seam>();
  const dropped: DroppedSeam[] = [];
  for (const item of found) {
    const reason = problemWith(item, linesOf);
    if (reason) {
      dropped.push({ seam: describe(item), reason });
      continue;
    }
    const entry = item as FoundSeam;
    const cites = entry.cites.map((c) => ({ path: cleanPath(c.file), start: c.start, end: c.end }));
    if (entry.kind === "call" && !entry.runtime) moveCallSiteFirst(cites, entry.path, linesOf);
    const [declared, ...contributing] = cites;
    if (only && !only.includes(declared!.path)) continue;
    const seam: Seam = {
      repo,
      path: declared!.path,
      kind: entry.kind === "route" ? "http-route" : "http-call",
      method: entry.method.toUpperCase(),
      rawPath: entry.path.trim(),
      key: entry.runtime ? null : normalisePath(entry.path),
      startLine: declared!.start,
      endLine: declared!.end,
      cites: contributing,
      commit,
    };
    kept.set(`${seam.kind} ${seam.method} ${seam.key ?? seam.rawPath} ${seam.path}:${seam.startLine}`, seam);
  }
  return { kept: [...kept.values()], dropped };
}

/**
 * Why an entry isn't supported by what it cites, or null. Its files and lines must exist; a
 * method other than GET (the default almost everywhere) must appear in the cited lines; and
 * every fixed segment of its path must too, which is how a prefix three files away is proven.
 * A run-time URL only needs its call site.
 */
function problemWith(item: unknown, linesOf: (path: string) => string[] | null): string | null {
  const entry = item as Partial<FoundSeam>;
  const shaped =
    (entry?.kind === "route" || entry?.kind === "call") &&
    typeof entry.method === "string" &&
    typeof entry.path === "string" &&
    entry.path.trim() !== "" &&
    typeof entry.runtime === "boolean" &&
    Array.isArray(entry.cites) &&
    entry.cites.length > 0 &&
    entry.cites.every((c) => typeof c?.file === "string" && typeof c.start === "number" && typeof c.end === "number");
  if (!shaped) return "malformed entry";
  const method = entry.method!.toUpperCase();
  if (!METHODS.has(method)) return `unknown method "${entry.method}"`;
  if (entry.runtime && entry.kind === "route") return "a route's path must be known";

  const spans: string[] = [];
  for (const cite of entry.cites!) {
    const lines = linesOf(cleanPath(cite.file));
    const problem = citationProblem({ path: cleanPath(cite.file), start: cite.start, end: cite.end }, lines);
    if (problem) return problem;
    spans.push(spanText(lines!, { path: cite.file, start: cite.start, end: cite.end }));
  }
  if (entry.runtime) return null;

  if (method !== "GET" && method !== "*" && !methodShown(method, spans)) return `${method} isn't in the cited lines`;
  for (const segment of normalisePath(entry.path!).split("/")) {
    if (!segment || segment === PARAM) continue;
    if (!spans.some((span) => span.includes(segment) || loose(span).includes(loose(segment)))) {
      return `"${segment}" isn't in the cited lines`;
    }
  }
  return null;
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

function cleanPath(file: string): string {
  return file.trim().replace(/\\/g, "/").replace(/^\.?\//, "");
}

function describe(item: unknown): string {
  const entry = item as Partial<FoundSeam>;
  const at = Array.isArray(entry?.cites) && entry.cites[0] ? ` (${entry.cites[0].file}:${entry.cites[0].start})` : "";
  return `${entry?.kind ?? "?"} ${entry?.method ?? "?"} ${entry?.path ?? "?"}${at}`;
}
