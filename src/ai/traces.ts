import { basename } from "node:path";
import { cleanPath, type Citation } from "../core/citations.js";
import { changedFiles, changedLines, inWorktree, type ChangedFile } from "../core/git.js";
import type { Seam } from "../core/seams.js";
import { ENTRY_KINDS, EXIT_KINDS, foundRef, seamRef, type TraceLink, type TraceStep } from "../core/traces.js";
import { BrainError } from "../core/types.js";
import { moveAnchor } from "../ingest/facts.js";
import { requireSynced } from "../ingest/registry.js";
import type { Store } from "../store/store.js";
import { citationProblem, fileReader, loose, spanText } from "./check.js";
import { DEFAULT_MODEL } from "./generate.js";
import { detectLanguage } from "../core/languages.js";
import { isSource, isTestPath } from "./inventory.js";
import { prompt } from "./prompts.js";
import { chunk, type Runner } from "./runner.js";

/**
 * Entry points one run follows at most. Each is a chain through several files, read closely;
 * more go in runs side by side, under the runner's cap. A judgement to check at the gate.
 */
const BATCH_ENTRIES = 25;
/** Lines either side of an exit point's own line that a chain's last step may stop short by. */
const SLACK = 3;

const STEP = {
  type: "object",
  properties: { file: { type: "string" }, start: { type: "integer" }, end: { type: "integer" }, calls: { type: "string" } },
  required: ["file", "start", "end"],
};
const STEPS = { type: "array", items: STEP };
const SCHEMA = {
  type: "object",
  properties: {
    traces: {
      type: "array",
      items: {
        type: "object",
        properties: {
          entry: { type: "string" },
          found: {
            type: "object",
            properties: { kind: { type: "string", enum: ["job", "ui"] }, name: { type: "string" }, file: { type: "string" }, line: { type: "integer" } },
            required: ["kind", "name", "file", "line"],
          },
          leads: { type: "array", items: { type: "object", properties: { exit: { type: "string" }, steps: STEPS }, required: ["exit", "steps"] } },
          tables: {
            type: "array",
            items: { type: "object", properties: { name: { type: "string" }, access: { type: "string", enum: ["read", "write"] }, steps: STEPS }, required: ["name", "access", "steps"] },
          },
          ends: { type: "boolean" },
          steps: STEPS,
        },
      },
    },
  },
  required: ["traces"],
};

/** One entry point as the run answered it, before checking. */
interface FoundTrace {
  entry?: string;
  found?: { kind: "job" | "ui"; name: string; file: string; line: number };
  leads?: { exit: string; steps: RawStep[] }[];
  tables?: { name: string; access: "read" | "write"; steps: RawStep[] }[];
  ends?: boolean;
  steps?: RawStep[];
}
interface RawStep {
  file: string;
  start: number;
  end: number;
  calls?: string;
}

/** An entry point the run is asked about. */
interface Entry {
  id: string;
  ref: string;
  kind: TraceLink["entryKind"];
  label: string;
  path: string;
  line: number;
}

export interface DroppedChain {
  entry: string;
  reason: string;
}

export interface TracesResult {
  repo: string;
  commit: string;
  /** "full": every entry point followed; "update": only those whose code changed; "none": nothing to do. */
  mode: "full" | "update" | "none";
  /** Entry points followed this run, including jobs and UI actions found. */
  followed: number;
  /** Chains kept this run: to exit points, to tables, and entries that reach nothing. */
  kept: number;
  dropped: DroppedChain[];
  /** Exit points (outside tests) that no entry point, job or UI action was found to reach. */
  untriggered: string[];
  costUsd: number;
  durationMs: number;
}

/** A link's label in answers: `POST /api/orders`, `OrderStartedIntegrationEvent`. */
function labelOf(seam: Seam): string {
  return seam.kind.startsWith("http-") ? `${seam.method} ${seam.rawPath}` : seam.rawPath;
}

/** An entry point to ask about, numbered E1, E2… in the order given. */
function toEntry(seam: Seam, i: number): Entry {
  return { id: `E${i + 1}`, ref: seamRef(seam), kind: seam.kind as Entry["kind"], label: labelOf(seam), path: seam.path, line: seam.startLine };
}

/** A job or UI action: an entry point Claude Code found by reading code, not one from the link map. */
function isFound(kind: TraceLink["entryKind"]): boolean {
  return kind === "job" || kind === "ui";
}

/**
 * Has Claude Code follow each entry point of a repo (the routes it serves, the events it handles,
 * the gRPC methods it serves, and the jobs and UI actions it finds) through the code to what it
 * reaches: the exit points it can lead to, the tables it reads or writes, or nothing. Each answer
 * is a chain of steps, checked without AI: lines that exist, a start in the entry point's file,
 * an end on the exit point's own line (or the table's name), and a name shared by each step and
 * the next. After the first run, only entry points whose chains cite changed lines are followed
 * again; chains whose files only moved around them are moved through the diff, with no AI run.
 */
export async function updateTraces(store: Store, runner: Runner, name: string, options: { model?: string; full?: boolean; cwd?: string } = {}): Promise<TracesResult> {
  const { repo, state } = requireSynced(store, name);
  const started = Date.now();
  const seams = store.seams({ repos: [name], includeUnresolved: true }).filter((s) => !isTestPath(s.path));
  // A route a class inherits is handled by its base class's code: tracing each of hundreds of
  // derived classes would repeat one chain. Answers point at the base method instead.
  const entrySeams = unique(seams.filter((s) => ENTRY_KINDS.includes(s.kind) && !s.derived));
  // Calls and publishes named only at run time are exits too: a chain may end at one, so a
  // handler calling a URL from config doesn't read as reaching nothing.
  const exitSeams = seams.filter((s) => EXIT_KINDS.includes(s.kind));
  const exitRefs = [...new Set(exitSeams.map(seamRef))].sort();
  const previous = store.traceLinks(name);
  // A repo meeting no other service (a library, a docs repo) has nothing to trace.
  if (entrySeams.length === 0 && exitSeams.length === 0) {
    if (previous.length) store.replaceTraceLinks(name, null, []);
    return { repo: name, commit: state.commit, mode: "none", followed: 0, kept: 0, dropped: [], untriggered: [], costUsd: 0, durationMs: Date.now() - started };
  }
  const full = options.full || previous.length === 0;

  // What changed since each entry point's chains were made, and which chains can just move.
  const keep: TraceLink[] = [];
  const due = new Set<string>();
  const gone = new Set<string>();
  let discoverIn: string[] | null = full ? null : [];
  const refind = new Set<string>();
  if (!full) {
    const changesSince = new Map<string, ChangedFile[] | null>();
    const byEntry = groupBy(previous, (l) => l.entry);
    for (const [entry, links] of byEntry) {
      const first = links[0]!;
      const seamKind = !isFound(first.entryKind);
      if (seamKind && !entrySeams.some((s) => seamRef(s) === entry)) {
        gone.add(entry);
        continue;
      }
      if (first.commit === state.commit) {
        keep.push(...links);
        continue;
      }
      if (!changesSince.has(first.commit)) changesSince.set(first.commit, await changedFiles(repo.path, first.commit, state.commit));
      const moved = await movedLinks(links, repo.path, state.commit, changesSince.get(first.commit)!);
      if (moved) keep.push(...moved);
      else if (seamKind) due.add(entry);
      else {
        // A job or UI action whose code changed is looked for again in its file.
        gone.add(entry);
        refind.add(first.entryPath);
      }
    }
    for (const seam of entrySeams) if (!byEntry.has(seamRef(seam))) due.add(seamRef(seam));
    // Jobs and UI actions are found by reading code: they're looked for in source files added since,
    // and again in the files of those whose code changed. Not in every changed file, or nearly every
    // commit would cost a run.
    const look = new Set(refind);
    const all = previous.length ? await changedFiles(repo.path, previous[0]!.commit, state.commit) : [];
    for (const c of all ?? []) if (c.status === "A" && isSource({ path: c.path, language: detectLanguage(c.path) })) look.add(c.path);
    discoverIn = [...look].sort();
  }
  const asked = entrySeams.filter((s) => full || due.has(seamRef(s))).map(toEntry);
  if (asked.length === 0 && (discoverIn?.length ?? 1) === 0) {
    store.replaceTraceLinks(name, [...gone, ...keep.map((l) => l.entry)], keep);
    return { repo: name, commit: state.commit, mode: "none", followed: 0, kept: 0, dropped: [], untriggered: untriggered(store.traceLinks(name), exitRefs), costUsd: 0, durationMs: Date.now() - started };
  }

  const exitIds = new Map(exitRefs.map((ref, i) => [`X${i + 1}`, ref]));
  const exitsText = exitRefs.length
    ? exitRefs
        .map((ref, i) => {
          const where = exitSeams.filter((s) => seamRef(s) === ref).map((s) => `${s.path}:${s.startLine}`);
          return `- X${i + 1}: ${ref.replace(/^\S+ /, `${kindWord(ref)} `)} (${where.slice(0, 4).join("; ")}${where.length > 4 ? `; +${where.length - 4} more` : ""})`;
        })
        .join("\n")
    : "- (none: this repository makes no calls and publishes nothing)";
  let costUsd = 0;
  const model = options.model ?? DEFAULT_MODEL;

  const { links, dropped, found } = await inWorktree(repo.path, state.commit, options.cwd, async (cwd) => {
    const linesOf = fileReader(cwd);
    const ask = async (batch: readonly Entry[], discover: string, notes = "") => {
      const entriesText = batch.length ? batch.map((e) => `- ${e.id}: ${kindWord(e.ref)} ${e.label} (${e.path}:${e.line})`).join("\n") : "- (none this time)";
      const run = await runner.run<{ traces?: unknown }>({ cwd, prompt: prompt("list-traces", { entries: entriesText, exits: exitsText, discover }) + notes, schema: SCHEMA, model });
      costUsd += run.costUsd;
      if (!Array.isArray(run.output?.traces)) throw new BrainError("The AI's traces were malformed.");
      return run.output.traces as FoundTrace[];
    };
    const discoverText = (files: readonly string[] | null) =>
      files === null
        ? "Also list every job (a timer, background worker, scheduled task or start-up task that runs on its own) and every UI action (a page, component or command a person triggers that leads to an exit point) anywhere in the repository, each as found: {kind, name, file, line} with what it reaches."
        : files.length
          ? `Also list any job (a timer, background worker, scheduled task or start-up task) or UI action (a page, component or command a person triggers that leads to an exit point) in these changed files, each as found: {kind, name, file, line} with what it reaches:\n${files.slice(0, 200).map((f) => `- ${f}`).join("\n")}`
          : "";

    const batches = asked.length ? chunk(asked, BATCH_ENTRIES) : [[]];
    const answers = await Promise.all(
      batches.map(async (batch, i) => {
        try {
          return { batch, traces: await ask(batch, i === 0 ? discoverText(discoverIn) : "") };
        } catch (error) {
          if (!(error instanceof BrainError)) throw error;
          return { batch, traces: [] as FoundTrace[] };
        }
      }),
    );

    const links: TraceLink[] = [];
    const dropped: DroppedChain[] = [];
    const found = new Set<string>();
    const check = (batch: readonly Entry[], traces: readonly FoundTrace[]) => {
      const failed: Entry[] = [];
      for (const entry of batch) {
        const answer = traces.find((t) => t.entry === entry.id);
        const result = answer ? checkTrace(answer, entry, exitIds, exitSeams, linesOf, state.commit, name) : { links: [], problems: ["no answer for it"] };
        if (result.links.length) links.push(...result.links);
        if (result.problems.length) {
          dropped.push(...result.problems.map((reason) => ({ entry: `${entry.label}`, reason })));
          if (!result.links.length) failed.push(entry);
        }
      }
      for (const answer of traces.filter((t) => !t.entry && t.found)) {
        // Finding jobs and UI actions is optional: one that reaches nothing (a component that calls
        // nothing) is left out quietly, not counted as a dropped chain.
        if (!answer.leads?.length && !answer.tables?.length) continue;
        const f = answer.found!;
        const path = cleanPath(String(f.file));
        const declared = foundAt(String(f.name ?? "").trim(), path, Number(f.line), linesOf);
        if (typeof declared === "string") {
          dropped.push({ entry: `${f.kind} ${f.name}`, reason: declared });
          continue;
        }
        const entry: Entry = { id: "", ref: foundRef(f.kind, f.name.trim(), path), kind: f.kind, label: f.name.trim(), path, line: declared.line };
        const result = checkTrace(answer, entry, exitIds, exitSeams, linesOf, state.commit, name);
        if (result.links.length) {
          links.push(...result.links);
          found.add(entry.ref);
        }
        dropped.push(...result.problems.map((reason) => ({ entry: entry.label, reason })));
      }
      return failed;
    };
    const failed = answers.flatMap(({ batch, traces }) => check(batch, traces));
    // An entry point whose every chain failed is asked once more, told why.
    if (failed.length) {
      const reasons = dropped.filter((d) => failed.some((e) => e.label === d.entry)).map((d) => `- ${d.entry}: ${d.reason}`);
      try {
        const again = await ask(failed, "", `\n\nAn earlier answer for these was dropped by the automatic check, for these reasons. Answer them again, citing the lines each step and name come from:\n${reasons.slice(0, 40).join("\n")}`);
        for (const entry of failed) for (let i = dropped.length - 1; i >= 0; i--) if (dropped[i]!.entry === entry.label) dropped.splice(i, 1);
        check(failed, again);
      } catch (error) {
        if (!(error instanceof BrainError)) throw error;
      }
    }

    // A second look, as full link maps get: exit points nothing was found to reach are asked about
    // directly, once, with every entry point listed so an answer can name the one that leads there.
    // Only answers given are checked; an entry point it doesn't mention keeps what it had. On an
    // update it asks only about exit points that just lost their trigger or sit in changed code,
    // so one nothing really reaches (dead code) doesn't cost a run on every commit.
    const reachedNow = new Set([...keep, ...links].flatMap((l) => (l.target.type === "exit" ? [l.target.ref] : [])));
    const reachedBefore = new Set(previous.flatMap((l) => (l.target.type === "exit" ? [l.target.ref] : [])));
    const askedFiles = new Set([...asked.map((e) => e.path), ...(discoverIn ?? [])]);
    const worthAsking = (ref: string) => full || reachedBefore.has(ref) || exitSeams.some((s) => seamRef(s) === ref && askedFiles.has(s.path));
    const missing = [...exitIds].filter(([, ref]) => !reachedNow.has(ref) && worthAsking(ref));
    if (missing.length) {
      const everyEntry = entrySeams.map(toEntry);
      const lookFor = [
        "These exit points weren't reached by any chain. For each, find what leads to it: one of the entry points above (answer with its id), or a job or UI action (answer as found: {kind, name, file, line}). Leave out any that nothing in this repository leads to.",
        ...missing.map(([id, ref]) => `- ${id}: ${ref.replace(/^\S+ /, `${kindWord(ref)} `)}`),
      ].join("\n");
      try {
        const traces = await ask(everyEntry, lookFor);
        const given = everyEntry.filter((e) => traces.some((t) => t.entry === e.id));
        check(given, traces);
      } catch (error) {
        if (!(error instanceof BrainError)) throw error;
      }
    }
    // An entry point no chain held for is recorded with why, so it isn't asked about on every sync:
    // only once its declaration changes, or with --full.
    for (const entry of asked) {
      if (links.some((l) => l.entry === entry.ref)) continue;
      const reason = dropped.find((d) => d.entry === entry.label)?.reason ?? "no answer for it";
      links.push({ repo: name, entry: entry.ref, entryKind: entry.kind, entryLabel: entry.label, entryPath: entry.path, entryLine: entry.line, target: { type: "unmapped", reason }, steps: [], commit: state.commit });
    }
    return { links, dropped, found };
  });

  // The rows replaced: every entry point asked about, those gone, those moved, and on an update the
  // jobs and UI actions in changed files (found again, or no longer there).
  const replaced = full
    ? null
    : [
        ...asked.map((e) => e.ref),
        ...gone,
        ...keep.map((l) => l.entry),
        ...found,
        ...previous.filter((l) => isFound(l.entryKind) && discoverIn!.includes(l.entryPath)).map((l) => l.entry),
      ];
  const stillKept = keep.filter((l) => !isFound(l.entryKind) || !discoverIn!.includes(l.entryPath));
  // The second look can add chains to an entry point kept or already answered.
  const replacing = replaced && [...new Set([...replaced, ...links.map((l) => l.entry)])];
  store.replaceTraceLinks(name, replacing, settled([...stillKept, ...links]));
  return {
    repo: name,
    commit: state.commit,
    mode: full ? "full" : "update",
    followed: asked.length + found.size,
    kept: links.filter((l) => l.target.type !== "unmapped").length,
    dropped,
    untriggered: untriggered(store.traceLinks(name), exitRefs),
    costUsd,
    durationMs: Date.now() - started,
  };
}

/**
 * One chain per entry point and target, and no "ends here" for an entry point that reaches
 * something: a second look can find what a first answer missed.
 */
function settled(links: readonly TraceLink[]): TraceLink[] {
  const reaches = new Set(links.filter((l) => l.target.type === "exit" || l.target.type === "table").map((l) => l.entry));
  const seen = new Set<string>();
  return links.filter((l) => {
    if ((l.target.type === "none" || l.target.type === "unmapped") && reaches.has(l.entry)) return false;
    const id = `${l.entry} ${JSON.stringify(l.target)}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

/**
 * Where a job or UI action the run found is declared: its code name must be one identifier
 * (`GracePeriodManagerService`, `CheckoutViewModel.CheckoutAsync`), not a description, and appear
 * in its file. The line given is used when the name is there; otherwise the first line naming it,
 * since a run is more often off by a few lines than wrong about the file.
 */
function foundAt(name: string, path: string, line: number, linesOf: (path: string) => string[] | null): { line: number } | string {
  if (!/^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/.test(name)) return `"${name}" isn't a name from the code`;
  const lines = linesOf(path);
  if (!lines) return `${path} doesn't exist at this commit`;
  const word = lastName(name);
  const named = (i: number) => wholeWord(lines[i] ?? "", word);
  if (Number.isInteger(line) && line >= 1 && line <= lines.length && named(line - 1)) return { line };
  const first = lines.findIndex((_, i) => named(i));
  return first >= 0 ? { line: first + 1 } : `\`${name}\` isn't in ${path}`;
}

/** Whether `word` appears in `text` on its own, not inside a longer name. */
function wholeWord(text: string, word: string): boolean {
  const isName = (c: string | undefined) => c !== undefined && /[\w$]/.test(c);
  for (let at = text.indexOf(word); at >= 0; at = text.indexOf(word, at + 1)) {
    if (!isName(text[at - 1]) && !isName(text[at + word.length])) return true;
  }
  return false;
}

/** Exit points no chain reaches. */
function untriggered(links: readonly TraceLink[], exitRefs: readonly string[]): string[] {
  const reached = new Set(links.flatMap((l) => (l.target.type === "exit" ? [l.target.ref] : [])));
  return exitRefs.filter((ref) => !reached.has(ref));
}

/** The kind of a ref, as the prompt words it. */
function kindWord(ref: string): string {
  const kind = ref.split(" ")[0]!;
  return ({ "http-route": "route", "http-call": "call", "event-subscribe": "handles event", "event-publish": "publishes event", "grpc-serve": "serves gRPC", "grpc-call": "calls gRPC" } as Record<string, string>)[kind] ?? kind;
}

/**
 * One answer as checked chains. Each lead and table read or write is kept or dropped on its own;
 * "ends" is kept only when there is nothing else, so an entry point is never both.
 */
export function checkTrace(
  answer: FoundTrace,
  entry: Entry,
  exitIds: ReadonlyMap<string, string>,
  exitSeams: readonly Seam[],
  linesOf: (path: string) => string[] | null,
  commit: string,
  repo: string,
): { links: TraceLink[]; problems: string[] } {
  const links: TraceLink[] = [];
  const problems: string[] = [];
  const base = { repo, entry: entry.ref, entryKind: entry.kind, entryLabel: entry.label, entryPath: entry.path, entryLine: entry.line, commit };
  for (const lead of answer.leads ?? []) {
    const ref = exitIds.get(String(lead.exit));
    if (!ref) {
      problems.push(`leads to ${lead.exit}, which isn't one of the exit points`);
      continue;
    }
    const steps = toSteps(lead.steps);
    const problem = chainProblem(steps, entry, { exits: exitSeams.filter((s) => seamRef(s) === ref) }, linesOf);
    if (problem) problems.push(`${ref}: ${problem}`);
    else links.push({ ...base, target: { type: "exit", ref }, steps });
  }
  for (const table of answer.tables ?? []) {
    const steps = toSteps(table.steps);
    const name = String(table.name ?? "").trim();
    const problem = name ? chainProblem(steps, entry, { table: name }, linesOf) : "no table name";
    if (problem) problems.push(`table ${name}: ${problem}`);
    else links.push({ ...base, target: { type: "table", name, access: table.access === "read" ? "read" : "write" }, steps });
  }
  if (links.length === 0 && answer.ends) {
    const steps = toSteps(answer.steps);
    const problem = chainProblem(steps, entry, null, linesOf);
    if (problem) problems.push(`ends: ${problem}`);
    else links.push({ ...base, target: { type: "none" }, steps });
  } else if (links.length === 0 && problems.length === 0) {
    problems.push("it gave neither what it reaches nor that it ends");
  }
  return { links, problems };
}

function toSteps(raw: unknown): TraceStep[] {
  return (Array.isArray(raw) ? (raw as RawStep[]) : []).map((s) => ({
    path: cleanPath(String(s?.file ?? "")),
    start: Number(s?.start),
    end: Number(s?.end),
    ...(typeof s?.calls === "string" && s.calls.trim() ? { calls: s.calls.trim() } : {}),
  }));
}

/** The name two steps must share: the last identifier, without generics or arguments (`_mediator.Send` → `Send`). */
function lastName(name: string): string {
  return name.replace(/[<(].*$/s, "").match(/[A-Za-z_$][\w$]*/g)?.at(-1) ?? name;
}

/**
 * Why a chain doesn't hold, or null: every step's lines exist (at most 80); it starts in the
 * entry point's file or one its declaration names; each step's linking name is in its lines and the next step's; and it ends
 * on one of the exit point's own lines, or on lines naming the table.
 */
export function chainProblem(
  steps: readonly TraceStep[],
  start: { path: string; line: number },
  end: { exits: readonly Seam[] } | { table: string } | null,
  linesOf: (path: string) => string[] | null,
): string | null {
  if (steps.length === 0) return "no steps";
  const spans: string[] = [];
  for (const step of steps) {
    const lines = linesOf(step.path);
    const problem = citationProblem(step as Citation, lines);
    if (problem) return problem;
    spans.push(loose(spanText(lines!, step)));
  }
  // A route declared apart from its handler (Laravel's routes file, an Express mount) starts in the
  // handler's file, which the declaration names: `Route::post('users/login', 'AuthController@login')`.
  const first = steps[0]!.path;
  if (first !== start.path) {
    const declared = linesOf(start.path);
    const near = declared ? loose(spanText(declared, { path: start.path, start: start.line, end: start.line })) : "";
    const named = loose(basename(first).replace(/\.[^.]+$/, ""));
    if (!named || !near.includes(named)) return `starts in ${first}, which the entry point's declaration (${start.path}:${start.line}) doesn't name`;
  }
  for (let i = 0; i < steps.length - 1; i++) {
    const name = steps[i]!.calls;
    if (!name) return `step ${i + 1} doesn't name what links it to the next`;
    const word = loose(lastName(name));
    if (!spans[i]!.includes(word)) return `\`${name}\` isn't in step ${i + 1}'s lines`;
    if (!spans[i + 1]!.includes(word)) return `\`${name}\` isn't in step ${i + 2}'s lines`;
  }
  const last = steps.at(-1)!;
  if (end && "exits" in end) {
    const hit = end.exits.some((x) => x.path === last.path && last.start <= x.endLine + SLACK && last.end >= x.startLine - SLACK);
    if (!hit) {
      const where = end.exits[0] ? `${end.exits[0].path}:${end.exits[0].startLine}` : "its line";
      return `doesn't end on the exit point's line (${where})`;
    }
  }
  // An ORM names a table through its model (Eloquent's `User` for `users`, as in Rails and Django),
  // so the singular counts too.
  if (end && "table" in end) {
    const table = loose(lastName(end.table));
    const singular = table.replace(/ies$/, "y").replace(/(s|x|ch|sh)es$/, "$1").replace(/s$/, "");
    const named = spans.at(-1)!.includes(table) || (singular.length > 2 && spans.at(-1)!.includes(singular));
    if (!named) return `\`${end.table}\` isn't in the last step's lines`;
  }
  return null;
}

/**
 * The chains with their steps moved past lines added or removed around them, or null when a
 * change touches a step's lines or deletes its file, so the entry point must be followed again.
 */
async function movedLinks(links: readonly TraceLink[], repoPath: string, to: string, changes: readonly ChangedFile[] | null): Promise<TraceLink[] | null> {
  if (changes === null) return null;
  const cited = new Set(links.flatMap((l) => [l.entryPath, ...l.steps.map((s) => s.path)]));
  const touched = changes.filter((c) => cited.has(c.path)).map((c) => c.path);
  if (touched.length === 0) return links.map((l) => ({ ...l, commit: to }));
  const hunks = await changedLines(repoPath, links[0]!.commit, to, touched);
  if (!hunks) return null;
  const move = (cite: Citation): Citation | null => {
    const change = hunks.get(cite.path);
    if (change === undefined) return cite;
    return change === "deleted" ? null : moveAnchor(cite, change);
  };
  const out: TraceLink[] = [];
  for (const link of links) {
    const entryLine = move({ path: link.entryPath, start: link.entryLine, end: link.entryLine });
    const steps = link.steps.map((s) => {
      const moved = move(s);
      return moved && { ...s, start: moved.start, end: moved.end };
    });
    if (!entryLine || steps.some((s) => s === null)) return null;
    out.push({ ...link, entryLine: entryLine.start, steps: steps as TraceStep[], commit: to });
  }
  return out;
}

/** One link per ref, declared in code rather than a spec where it's both: its chain starts in the code. */
function unique(seams: readonly Seam[]): Seam[] {
  const spec = (s: Seam) => /\.(json|ya?ml)$/i.test(s.path);
  const seen = new Map<string, Seam>();
  for (const seam of [...seams].sort((a, b) => Number(spec(a)) - Number(spec(b)))) if (!seen.has(seamRef(seam))) seen.set(seamRef(seam), seam);
  return [...seen.values()];
}

function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) groups.set(key(item), [...(groups.get(key(item)) ?? []), item]);
  return groups;
}
