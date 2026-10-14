import { cleanPath } from "../core/citations.js";
import { changedFiles, inWorktree } from "../core/git.js";
import { normalisePath, PARAM } from "../core/http.js";
import { detectLanguage } from "../core/languages.js";
import { normaliseName, withoutVersion, type NamedFamily } from "../core/links.js";
import { familyOf, type LinkSurvey, type PieceOutcome, type Seam, type SeamCite, type SeamKind, type SeamPiece } from "../core/seams.js";
import { BrainError } from "../core/types.js";
import { requireRepo } from "../ingest/registry.js";
import type { Store } from "../store/store.js";
import { citationProblem, fileReader, loose, methodShown, spanText } from "./check.js";
import { DEFAULT_MODEL } from "./generate.js";
import { isSource, isTestPath, isVendored, vendoredFolders } from "./inventory.js";
import { inheritedRoutes, surveyLinks, surveyText } from "./link-survey.js";
import { prompt } from "./prompts.js";
import type { Runner } from "./runner.js";
import { packPieces, pieceKey, piecesOf, pieceText, screenPieces, type Piece } from "./screen.js";

const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "*"]);
/** Files in these languages never declare a route or make a call, so changing one costs no run. */
const NEVER_SEAMS = new Set(["Markdown", "CSS", "SCSS", "Less"]);
/** Package manifests with no known language, which can still publish or use a package. */
const MANIFESTS = new Set(["requirements.txt", "go.mod", "Gemfile", "Pipfile", "setup.cfg", "packages.config"]);
/** Every file that can publish a package or depend on one; the links run reads them all, unscreened. */
const PACKAGE_FILES = /(^|\/)(package\.json|[^/]+\.(cs|fs|vb)proj|pyproject\.toml|setup\.py|setup\.cfg|requirements\.txt|Pipfile|composer\.json|Gemfile|go\.mod|pom\.xml|build\.gradle(\.kts)?|packages\.config)$/;
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

/** What a mapping run answers: the seams it found, and for each file or part it was given, whether it declares any. */
function schema(fields: Record<string, unknown>): object {
  return {
    type: "object",
    properties: {
      seams: {
        type: "array",
        items: { type: "object", properties: { ...fields, runtime: { type: "boolean" }, cites: CITES }, required: [...Object.keys(fields), "runtime", "cites"] },
      },
      files: {
        type: "array",
        items: {
          type: "object",
          properties: { file: { type: "string" }, from: { type: "integer" }, outcome: { type: "string", enum: ["entries", "none"] } },
          required: ["file", "from", "outcome"],
        },
      },
    },
    required: ["seams", "files"],
  };
}

/** One kind of Claude Code run, with its prompt, schema and the kinds it may list. */
interface Pass {
  prompt: string;
  schema: object;
  kinds: ReadonlySet<string>;
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
  },
  {
    prompt: "list-links",
    schema: schema({ kind: { type: "string", enum: [...NAMED_KINDS] }, name: { type: "string" } }),
    kinds: NAMED_KINDS,
  },
];

function isPackageManifest(path: string): boolean {
  return PACKAGE_FILES.test(path);
}

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
  /** Routes classes get from a base class, worked out by the brain from the survey. */
  derived: number;
  /** Pieces of own source read by screening, and how many it flagged for each run. */
  screened: { pieces: number; http: number; links: number };
  /** Flagged pieces no mapping run answered for, even when asked again: what they declare is unknown. */
  unmapped: { path: string; start: number; end: number }[];
  costUsd: number;
  /** Time taken, start to finish; the runs go side by side, so less than their sum. */
  durationMs: number;
}

export interface SeamOptions {
  model?: string;
  /** Map the whole repo again even if its seams exist. */
  full?: boolean;
  /** A worktree of the indexed commit, shared with sync's other steps; one is made if not given. */
  cwd?: string;
}

/** Characters of numbered file text per mapping run, and pieces at most: small enough that a run reads them all. */
const EXTRACT_CHARS = 60_000;
const EXTRACT_PIECES = 12;
/** OpenAPI and Swagger specs declare routes though they aren't code. */
const SPEC = /(^|\/)[^/]*(openapi|swagger)[^/]*\.(json|ya?ml)$/i;

/**
 * Has Claude Code list the HTTP routes a repo serves and the calls it makes, the events it
 * publishes and handles, the gRPC methods it serves and calls, and the packages it publishes and
 * uses, at the commit the brain has indexed, verifies each against the lines it cites, and stores
 * what passes, with what was covered.
 *
 * One run can't cover a large repo: it stops after a sample, different each time (atlas: 124, 13
 * and 25 routes from one commit). So the work is split by the brain, not the AI:
 * 1. A survey run finds what applies everywhere: route templates, base classes whose methods are
 *    routes, where settings live.
 * 2. A fast model screens every piece of the repo's own source (tests, vendored and generated code
 *    left out), its text in the prompt so none is skipped, for routes, calls and messages.
 * 3. Flagged pieces are mapped a few at a time, their text in the prompt, each answered for.
 * 4. Inherited routes are worked out from the survey and checked like the rest.
 * Each piece's outcome is stored, so answers can tell "none" from "not mapped". After the first
 * map only changed files are screened and mapped again, plus any file whose seams cite one.
 */
export async function updateSeams(store: Store, runner: Runner, name: string, options: SeamOptions = {}): Promise<SeamsResult> {
  const repo = requireRepo(store, name);
  const state = store.getState(name);
  if (!state) throw new BrainError(`"${name}" has not been synced yet. Run: brain sync ${name}`);
  const model = options.model ?? DEFAULT_MODEL;
  const commit = state.commit;

  const changes = !options.full && state.seamsCommit ? await changedFiles(repo.path, state.seamsCommit, state.commit) : null;
  let redo: string[] | null = null;
  const changed = new Set((changes ?? []).map((c) => c.path));
  if (changes) {
    const files = new Set(changes.filter((c) => c.status !== "D" && mayDeclareSeams(c.path)).map((c) => c.path));
    for (const seam of store.seams({ repos: [name], includeUnresolved: true })) {
      if (seam.cites.some((cite) => changed.has(cite.path))) files.add(seam.path);
    }
    redo = [...files].sort();
    if (redo.length === 0) {
      store.replaceSeams(name, { commit: state.commit, paths: changes.filter((c) => c.status === "D").map((c) => c.path), seams: [], pieces: [] });
      return { repo: name, commit: state.commit, mode: "update", redone: [], kept: [], dropped: [], retried: 0, derived: 0, screened: { pieces: 0, http: 0, links: 0 }, unmapped: [], costUsd: 0, durationMs: 0 };
    }
  }

  const started = Date.now();
  let costUsd = 0;
  const all = store.getFiles(name).map((f) => f.path);
  const vendored = vendoredFolders(all);
  const own = all.filter((path) => isSource({ path, language: detectLanguage(path) }, vendored) || (SPEC.test(path) && !isVendored(path, vendored)));
  const manifests = all.filter((path) => isPackageManifest(path) && !isTestPath(path) && !isVendored(path, vendored));
  const inScope = (path: string) => !redo || redo.includes(path);

  const outcome = await inWorktree(repo.path, state.commit, options.cwd, async (cwd) => {
    const linesOf = fileReader(cwd);
    let survey = store.linkSurvey(name);
    // A full map surveys again; an update only when a file the survey rests on changed.
    if (!redo || !survey || surveyFiles(survey).some((path) => changed.has(path))) {
      const surveyed = await surveyLinks(runner, cwd, linesOf, model);
      survey = surveyed.survey;
      costUsd += surveyed.costUsd;
    }

    const pieces = piecesOf(own.filter(inScope), linesOf);
    const screened = await screenPieces(runner, cwd, pieces, linesOf);
    costUsd += screened.costUsd;
    const flagged = (p: Piece) => screened.flags.get(pieceKey(p))!;
    const manifestPieces = piecesOf(manifests.filter((path) => inScope(path) && !own.includes(path)), linesOf);
    const work = [
      { pass: PASSES[0]!, pieces: pieces.filter((p) => flagged(p).route || flagged(p).call) },
      { pass: PASSES[1]!, pieces: [...pieces.filter((p) => flagged(p).message), ...manifestPieces] },
    ];
    const results = await Promise.all(work.map(({ pass, pieces }) => mapPieces(pass, pieces)));

    // Inherited routes, worked out again over the whole repo on every map: a changed base class
    // changes them all. A derived class's own route for the same path wins.
    const listed = new Set(results[0]!.kept.map(routeId));
    const derived = verifySeams(inheritedRoutes(survey, own, linesOf), cwd, name, state.commit).kept
      .filter((s) => !listed.has(routeId(s)))
      .map((s) => ({ ...s, derived: true }));

    const ledger: SeamPiece[] = [...pieces, ...manifestPieces].map((p) => {
      const key = pieceKey(p);
      const isManifest = manifests.includes(p.path);
      return {
        ...p,
        http: isManifest ? "unflagged" : results[0]!.outcomes.get(key) ?? "unflagged",
        links: results[1]!.outcomes.get(key) ?? "unflagged",
      };
    });
    return {
      survey,
      kept: results.flatMap((r) => r.kept),
      dropped: results.flatMap((r) => r.dropped),
      retried: results.reduce((n, r) => n + r.retried, 0),
      derived,
      ledger,
      screened: { pieces: pieces.length, http: work[0]!.pieces.length, links: work[1]!.pieces.length - manifestPieces.length },
    };

    /** Maps flagged pieces a few at a time, then asks again for any no run answered for. */
    async function mapPieces(pass: Pass, todo: readonly Piece[]) {
      const outcomes = new Map<string, PieceOutcome>();
      const kept: Seam[] = [];
      const dropped: DroppedSeam[] = [];
      let retried = 0;
      const round = async (batch: readonly Piece[]) => {
        const files = [...new Set(batch.map((p) => p.path))];
        const text = batch.map((p) => pieceText(p, linesOf(p.path) ?? [], true)).join("\n");
        const ask = async (scope: string) => {
          const run = await runner.run<{ seams?: unknown; files?: unknown }>({ cwd, prompt: prompt(pass.prompt, { scope, files: text }), schema: pass.schema, model });
          costUsd += run.costUsd;
          if (!Array.isArray(run.output?.seams)) throw new BrainError("The AI's seam list was malformed.");
          return { found: run.output.seams.filter((item) => pass.kinds.has((item as Partial<FoundSeam>)?.kind ?? "")), answered: answeredPieces(run.output.files) };
        };
        try {
          const first = await ask(batchScope(survey!));
          let result = verifySeams(first.found, cwd, name, commit, files);
          if (result.dropped.length) {
            // Output varies between runs and a contributing line is easy to leave out; ask once
            // more for just the dropped entries, with the reasons, before giving up on them.
            retried += result.dropped.length;
            try {
              const second = verifySeams((await ask(retryScope(result.dropped))).found, cwd, name, commit, files);
              result = { kept: uniqueSeams([...result.kept, ...second.kept]), dropped: second.dropped };
            } catch (error) {
              if (!(error instanceof BrainError)) throw error;
            }
          }
          kept.push(...result.kept);
          dropped.push(...result.dropped);
          for (const p of batch) {
            // A checked seam declared in the piece, or built from lines in it (a .proto a server implements).
            const within = (c: { path: string; start: number }) => c.path === p.path && c.start >= p.start && c.start <= p.end;
            const used = result.kept.some((s) => within({ path: s.path, start: s.startLine }) || s.cites.some(within));
            if (used) outcomes.set(pieceKey(p), "mapped");
            // The run read it: claims of its that failed the check are reported as dropped, not as a gap.
            else if (first.answered.has(pieceKey(p))) outcomes.set(pieceKey(p), "none");
          }
        } catch (error) {
          if (!(error instanceof BrainError)) throw error;
        }
      };
      await Promise.all(packPieces(todo, linesOf, EXTRACT_CHARS, EXTRACT_PIECES).map(round));
      const missing = todo.filter((p) => !outcomes.has(pieceKey(p)));
      if (missing.length) await Promise.all(packPieces(missing, linesOf, EXTRACT_CHARS / 2, EXTRACT_PIECES / 2).map(round));
      for (const p of todo) if (!outcomes.has(pieceKey(p))) outcomes.set(pieceKey(p), "unmapped");
      return { kept: uniqueSeams(kept), dropped, retried, outcomes };
    }
  });

  const deleted = (changes ?? []).filter((c) => c.status === "D").map((c) => c.path);
  store.replaceSeams(name, {
    commit: state.commit,
    paths: redo ? [...redo, ...deleted] : null,
    seams: outcome.kept,
    pieces: outcome.ledger,
    derived: outcome.derived,
    survey: outcome.survey,
  });
  return {
    repo: name,
    commit: state.commit,
    mode: redo ? "update" : "full",
    redone: redo ?? [],
    kept: outcome.kept,
    dropped: outcome.dropped,
    retried: outcome.retried,
    derived: outcome.derived.length,
    screened: outcome.screened,
    unmapped: outcome.ledger.filter((p) => p.http === "unmapped" || p.links === "unmapped").map(({ path, start, end }) => ({ path, start, end })),
    costUsd,
    durationMs: Date.now() - started,
  };
}

/** A route's identity for telling a listed route from the same one worked out from a base class. */
function routeId(seam: Seam): string {
  return `${seam.kind} ${seam.method} ${seam.key ?? seam.rawPath} ${seam.path}`;
}

/** The files a survey rests on: when one changes, the survey is made again. */
function surveyFiles(survey: LinkSurvey): string[] {
  return [
    ...survey.templates.flatMap((t) => t.cites.map((c) => c.path)),
    ...survey.inherited.flatMap((b) => [...b.cites, ...b.routes.flatMap((r) => r.cites)].map((c) => c.path)),
    ...survey.configFiles,
  ];
}

/** What a mapping run said of each piece it was given, by key: "entries" or "none". */
function answeredPieces(files: unknown): Map<string, string> {
  if (!Array.isArray(files)) return new Map();
  return new Map(files.flatMap((f) => {
    const answer = f as Partial<{ file: string; from: number; outcome: string }>;
    return typeof answer?.file === "string" ? [[pieceKey({ path: cleanPath(answer.file), start: Number(answer.from ?? 1) }), String(answer.outcome)] as [string, string]] : [];
  }));
}

function batchScope(survey: LinkSurvey): string {
  return [
    "Only list entries declared in the files and parts given at the end, whose text is there with each line numbered. Read any other file you need to resolve prefixes, base URLs, templates and names.",
    surveyText(survey),
    "In `files`, answer for every file and part given: its path as `file`, its first line as `from` (1 for a whole file), and `outcome` \"entries\" if you listed any declared in it, or \"none\".",
  ].filter(Boolean).join("\n");
}

function retryScope(dropped: readonly DroppedSeam[]): string {
  return [
    "An earlier pass over the files at the end listed these, and the automatic check dropped them for the reasons given:",
    ...dropped.map((d) => `- ${d.seam}: ${d.reason}`),
    "List again only the ones that are real, this time citing every line each fixed segment of the path, or each part of the name, comes from (such as a base-URL constant, a route prefix, a route template or the class a method belongs to), and leave out any you can't support. Answer `files` as an empty list.",
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
