import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { localPerson, resolveDbPath } from "./config.js";
import type { FactKind, FactRecord } from "./core/facts.js";
import { anchorProblems, parseAnchor } from "./ingest/facts.js";
import { confirmFact, factLine, factsAbout, visibleFacts } from "./serve/facts.js";
import { checkFacts, type FactChecksResult } from "./ai/fact-checks.js";
import { findSystem } from "./serve/systems.js";
import { recordFact } from "./serve/tools/record-fact.js";
import { runQueued } from "./core/queue.js";
import { listTree, resolveCommit, withWorktree } from "./core/git.js";
import { familyOf } from "./core/seams.js";
import { BrainError, type RepoNote, type RepoRecord } from "./core/types.js";
import { doctor, execProgram, formatChecks } from "./doctor.js";
import { hookStatus, installHook, removeHook, type HookCommand } from "./ingest/hooks.js";
import { confirmProposedNote, enrolRepo, removeRepo, requireRepo, setRepoNote, setRepoRef } from "./ingest/registry.js";
import { syncRepo, type SyncResult } from "./ingest/sync.js";
import { LOCAL_CALLER, LocalAccessPolicy } from "./serve/access.js";
import { describeFreshness, freshnessOf } from "./serve/freshness.js";
import { count, type Format, type ToolDeps, type ToolResult } from "./serve/tools/common.js";
import { findConsumers } from "./serve/tools/find-consumers.js";
import { getPage } from "./serve/tools/get-page.js";
import { cardRequest } from "./serve/tools/repo-card.js";
import { search } from "./serve/tools/search.js";
import { systemOverview } from "./serve/tools/system-overview.js";
import { impactRequest } from "./serve/tools/work-impact.js";
import { joinHint } from "./serve/systems.js";
import { suggestSystems, type SuggestResult } from "./ai/systems.js";
import { inventory } from "./ai/inventory.js";
import { SqliteStore } from "./store/sqlite.js";
import { DEFAULT_MODEL, generateWiki, type PlanReport, type WikiResult } from "./ai/generate.js";
import { claudeRunner, limitRunner } from "./ai/runner.js";
import { updateSeams, type SeamsResult } from "./ai/seams.js";
import { updateTraces, type TracesResult } from "./ai/traces.js";
import type { Store } from "./store/store.js";

const HELP = `brain: organisation-wide context for coding agents

Get started:
  brain doctor                                             check Node, git, Claude Code and the MCP registration
  brain add <path> [<path>...] [--name <name>] [--note "<focus>"] [--no-hook] [--no-ai]
                                                           add repos: index them, have Claude Code write their wikis
                                                           and map their links (3 at a time), and keep them up to date

Keep repos up to date:
  brain sync [<name>] [--full] [--only links|wiki|facts] [--no-ai] [--model <m>]
                                                           bring repos up to their tracked branch (all if no name);
                                                           --full redoes everything, --only links, wiki or facts
                                                           just that step, --no-ai indexes only
  brain hooks install|remove|status [<name>]               re-sync automatically whenever the tracked branch moves
  brain repo list                                          repos and how up to date each is
  brain note <name> ["<focus>" | --clear | --confirm]      what a repo's wiki should focus on, e.g. "Ordering matters
                                                           most"; --confirm applies one an agent proposed
  brain wiki plan <name>                                   a large repo's page plan: its areas, flows and what's written
  brain repo add <path> [--name <name>] [--ref <branch>]   enrol only (no AI); then brain sync <name>
  brain repo set-ref <name> <ref>                          track a different branch, e.g. origin/release
  brain repo remove <name>                                 remove a repo, everything held about it, and its hook

See what an agent gets:
  brain search "<query>" [--repo <name>]... [--detailed]   search every repo's wiki and endpoints
  brain card <name> [--detailed]                           what a repo is, its wiki, what it calls and what calls it
  brain page <name> [<page>]                               a wiki page, or the list of pages
  brain consumers "<METHOD /path>" [--detailed] [--follow] who serves and who calls an endpoint; also
                                                           "event <name>", "grpc <Service/Method>", "package <name>";
                                                           --follow traces what handling it sets off, across repos
  brain impact <repo> [--path <file>] [--route "<METHOD /path>"] [--detailed]
                                                           routes, events, gRPC methods and packages a repo or
                                                           file provides, and who uses each
  brain impact --work "<description of work>"              which systems, repos and endpoints the work would touch

Systems (which repos make up a product):
  brain systems                                            list systems and whether a person has confirmed them
  brain systems suggest [--model <m>]                      have Claude Code suggest systems from the repos' cards (cents)
  brain systems show <system>                              a system's overview: its repos and how they connect
  brain systems confirm <system> | --all                   confirm suggested systems
  brain systems set <system> [<repo>...] [--summary "<line>"]
                                                           add or move repos into a system, or change its summary
  brain systems rename <system> <new name>                 rename a system
  brain systems remove <system>                            remove a system (its repos stay enrolled)

Facts from people (agents record them with brain_record_fact; you confirm them):
  brain facts [<repo or system>] [--all]                   list facts, proposed and stale ones marked; --all adds retired
  brain facts add <repo or system> --kind <k> --text "<fact>" [--quote "<words>"] [--anchor <file:lines>]... [--ticket <t>]
                                                           record a fact yourself, confirmed (kinds: rule, term,
                                                           purpose, decision, answer)
  brain facts confirm <id>                                 confirm a proposed fact, or re-confirm a stale one
  brain facts check [<repo or system>] [--full]            have Claude Code check facts against the code now (cents);
                                                           sync does this for new and changed ones
  brain facts edit <id> [--text "<fact>"] [--anchor <file:lines>]...
                                                           reword a fact or re-anchor it at the current commit
  brain facts retire <id>                                  mark a fact no longer true (kept for history)
  brain facts export                                       every fact as Markdown, by repo and system
  brain gaps                                               searches the brain couldn't answer, most asked first

Store: ${resolveDbPath()} (set BRAIN_DB to change). Model: ${DEFAULT_MODEL} unless --model is given.`;

async function main(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      name: { type: "string" },
      ref: { type: "string" },
      path: { type: "string" },
      route: { type: "string" },
      work: { type: "string" },
      summary: { type: "string" },
      all: { type: "boolean", default: false },
      repo: { type: "string", multiple: true },
      offset: { type: "string" },
      model: { type: "string" },
      "no-ai": { type: "boolean", default: false },
      "no-hook": { type: "boolean", default: false },
      full: { type: "boolean", default: false },
      only: { type: "string" },
      kind: { type: "string" },
      note: { type: "string" },
      clear: { type: "boolean", default: false },
      confirm: { type: "boolean", default: false },
      text: { type: "string" },
      quote: { type: "string" },
      ticket: { type: "string" },
      anchor: { type: "string", multiple: true },
      detailed: { type: "boolean", default: false },
      follow: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const [command, sub, arg, extra, ...more] = positionals;
  if (!command || values.help || command === "help") {
    console.log(HELP);
    return;
  }

  const store = new SqliteStore(resolveDbPath());
  // The CLI answers exactly what an agent would get over MCP, as the local user.
  const tools: ToolDeps = { store, access: new LocalAccessPolicy() };
  const format: Format = values.detailed ? "detailed" : "concise";
  try {
    switch (command) {
      case "repo":
        if (sub === "add" && arg) {
          const repo = await enrolRepo(store, { path: arg, name: values.name, ref: values.ref });
          console.log(`Enrolled ${repo.name} (tracking ${repo.ref}) from ${repo.path}`);
          console.log(`Next: brain sync ${repo.name}`);
        } else if (sub === "list") {
          await listRepos(store);
        } else if (sub === "set-ref" && arg && extra) {
          await setRepoRef(store, arg, extra);
          console.log(`${arg} now tracks ${extra}. Next: brain sync ${arg}`);
          if ((await hookStatus(store, arg)).installed) {
            await installHook(store, arg, hookCommand());
            console.log(`Its hook now watches ${extra}.`);
          }
        } else if (sub === "remove" && arg) {
          if (store.getRepo(arg)) await removeHook(store, arg);
          removeRepo(store, arg);
          console.log(`Removed ${arg}, everything the brain held about it, and its hook.`);
        } else {
          throw new BrainError("Usage: brain repo add <path> | list | set-ref <name> <ref> | remove <name>");
        }
        break;
      case "sync": {
        const names = sub ? [sub] : store.listRepos().map((repo) => repo.name);
        if (names.length === 0) throw new BrainError("No repos enrolled. Add one with: brain add <path>");
        const only = onlyStep(values.only);
        await eachAtOnce(names, MAX_REPOS, (name) => name, async (name) => {
          if (values["no-ai"]) printSync(await syncRepo(store, name));
          else await syncAndRefresh(store, name, { model: values.model, full: values.full, only });
        });
        break;
      }
      case "add": {
        const paths = positionals.slice(1);
        if (paths.length === 0) throw new BrainError('Usage: brain add <path> [<path>...] [--name <name>] [--note "<focus>"] [--no-hook] [--no-ai]');
        if (paths.length > 1 && (values.name || values.note)) throw new BrainError("--name and --note apply to one repo; add it on its own.");
        const note = values.note ? { text: values.note, by: await localPerson(), at: new Date().toISOString() } : undefined;
        await addRepos(store, paths, { name: values.name, ref: values.ref, note, model: values.model, ai: !values["no-ai"], hook: !values["no-hook"] });
        break;
      }
      case "note":
        await repoNote(store, sub, arg, values);
        break;
      case "wiki":
        if (sub !== "plan" || !arg) throw new BrainError("Usage: brain wiki plan <name>");
        printPlan(store, arg);
        break;
      case "doctor": {
        const checks = await doctor({
          store,
          dbPath: resolve(resolveDbPath()),
          nodeVersion: process.versions.node,
          exec: execProgram,
          hook: hookCommand(),
          mcpEntry: fileURLToPath(new URL("../bin/brain-mcp.mjs", import.meta.url)),
        });
        console.log(formatChecks(checks, store.listRepos().length > 0));
        if (checks.some((check) => !check.ok)) process.exitCode = 1;
        break;
      }
      case "hooks":
        await hooks(store, sub, arg);
        break;
      case "page":
        if (!sub) throw new BrainError("Usage: brain page <name> [<page>]");
        print(await getPage(tools, LOCAL_CALLER, { repo: sub, page: arg }));
        break;
      case "card":
        if (!sub) throw new BrainError("Usage: brain card <name> [--detailed]");
        print(await cardRequest(tools, LOCAL_CALLER, sub, format));
        break;
      case "consumers":
        if (!sub) throw new BrainError("Usage: brain consumers \"GET /api/orders/{id}\" [--detailed]");
        print(await findConsumers(tools, LOCAL_CALLER, { target: sub, format, follow: values.follow }));
        break;
      case "impact":
        if (!sub && !values.work) throw new BrainError('Usage: brain impact <repo> [--path <file>] [--route "GET /path"] [--detailed] | brain impact --work "<description>"');
        print(await impactRequest(tools, LOCAL_CALLER, { repo: sub, work: values.work, path: values.path, route: values.route, format }));
        break;
      case "systems":
        await systems(store, tools, sub, [arg, extra, ...more].filter((p): p is string => p !== undefined), {
          all: values.all,
          summary: values.summary,
          model: values.model,
        });
        break;
      case "search":
        if (!sub) throw new BrainError('Usage: brain search "<query>" [--repo <name>]... [--detailed] [--offset <n>]');
        print(await search(tools, LOCAL_CALLER, { query: sub, repos: values.repo, format, offset: Number(values.offset ?? 0) || 0 }));
        break;
      case "facts":
        await facts(store, tools, sub, arg, values);
        break;
      case "gaps":
        printGaps(store);
        break;
      default:
        throw new BrainError(`Unknown command "${command}".\n\n${HELP}`);
    }
  } finally {
    store.close();
  }
}

/** `--only links` maps routes, calls and other links; `--only wiki` writes the wiki; `--only facts` checks facts against the code. */
type Step = "links" | "wiki" | "facts";

function onlyStep(value: string | undefined): Step | undefined {
  if (value === undefined || value === "links" || value === "wiki" || value === "facts") return value;
  throw new BrainError(`--only takes links, wiki or facts, not "${value}".`);
}

/**
 * Claude Code runs at once across everything one command does: steps and repos go side by side
 * up to this, and the rest queue, to stay under the account's rate limits.
 */
const MAX_RUNS = 4;
/** Repos `brain add` and `brain sync` work on at once. */
const MAX_REPOS = 3;
const runner = limitRunner(claudeRunner, MAX_RUNS);

/**
 * Syncs a repo, then has Claude Code bring its links, its wiki and its fact checks up to the new
 * commit. The three read the same commit and don't depend on each other, so they go side by side
 * in one worktree, and the sync takes as long as the slowest. One sync per repo at a time: a hook
 * firing mid-run is folded into one more pass when this one finishes. A failed step is reported
 * and the others still finish.
 */
async function syncAndRefresh(store: Store, name: string, options: { model?: string; full?: boolean; only?: Step }): Promise<void> {
  let full = options.full;
  const outcome = await runQueued(join(dirname(resolveDbPath()), "locks"), name, async () => {
    const synced = await syncRepo(store, name);
    printSync(synced);
    const steps: Record<Step, [string, (cwd: string) => Promise<void>]> = {
      // What each entry point leads to depends on the links just mapped, so it follows them in the same step.
      links: [
        "routes and calls",
        async (cwd) => {
          printSeams(await updateSeams(store, runner, name, { model: options.model, full, cwd }));
          printTraces(await updateTraces(store, runner, name, { model: options.model, full, cwd }));
        },
      ],
      wiki: ["wiki", async (cwd) => printWiki(await generateWiki(store, runner, name, { model: options.model, full, cwd }))],
      facts: ["fact checks", async (cwd) => printChecks(await checkFacts(store, runner, name, { model: options.model, full, cwd }))],
    };
    const chosen = (Object.keys(steps) as Step[]).filter((step) => !options.only || options.only === step);
    await withWorktree(requireRepo(store, name).path, synced.commit, (cwd) =>
      Promise.all(chosen.map((step) => reported(name, steps[step][0], () => steps[step][1](cwd)))),
    );
    full = false;
  });
  if (outcome === "queued") console.log(`${name}: already being synced; that run will go again to pick this up.`);
}

/** Runs `work` on each item, at most `max` at once. One item's BrainError is reported and the rest carry on. */
async function eachAtOnce<T>(items: readonly T[], max: number, label: (item: T) => string, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++]!;
      try {
        await work(item);
      } catch (error) {
        if (!(error instanceof BrainError)) throw error;
        console.error(`${label(item)}: ${error.message}`);
        process.exitCode = 1;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(max, items.length) }, worker));
}

async function reported(name: string, step: string, work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch (error) {
    if (!(error instanceof BrainError)) throw error;
    console.error(`${name}: ${step} not updated: ${error.message}`);
  }
}

function printSeams(result: SeamsResult): void {
  const at = `@${result.commit.slice(0, 7)}`;
  if (result.mode === "update" && result.redone.length === 0) {
    console.log(`${result.repo}: routes and calls up to date at ${at}, no code changed (no AI run)`);
    return;
  }
  const routes = result.kept.filter((s) => s.kind === "http-route").length;
  const calls = result.kept.filter((s) => s.kind === "http-call");
  const runtime = calls.filter((s) => s.key === null).length;
  // Events, gRPC and packages by kind, e.g. ", event-publish 3, event-subscribe 5".
  const byKind = new Map<string, number>();
  for (const seam of result.kept.filter((s) => familyOf(s.kind) !== "http")) byKind.set(seam.kind, (byKind.get(seam.kind) ?? 0) + 1);
  const links = [...byKind].map(([kind, n]) => `, ${kind} ${n}`).join("");
  const scope = result.mode === "full" ? "mapped" : `updated in ${result.redone.length} file${result.redone.length === 1 ? "" : "s"}`;
  const retried = result.retried ? `, ${result.retried} dropped and asked for again` : "";
  const dropped = result.dropped.length ? `, ${result.dropped.length} ${result.retried ? "still " : ""}dropped` : result.retried ? ", all recovered" : "";
  const swept = result.swept ? `, ${result.swept} more found on a second look` : "";
  console.log(
    `${result.repo}: routes and calls ${scope} at ${at} · ${count(routes, "route")}, ${count(calls.length - runtime, "call")}` +
      `${runtime ? ` (+${runtime} run-time)` : ""}${links}${swept}${retried}${dropped} · $${result.costUsd.toFixed(2)} · ${Math.round(result.durationMs / 1000)}s`,
  );
  for (const drop of result.dropped.slice(0, 3)) console.log(`    dropped: ${drop.reason} · ${drop.seam}`);
  if (result.dropped.length > 3) console.log(`    … and ${result.dropped.length - 3} more`);
}

function printWiki(wiki: WikiResult): void {
  const at = `@${wiki.commit.slice(0, 7)}`;
  if (wiki.plan) console.log(`${wiki.repo}: ${planText(wiki.plan)}`);
  if (wiki.reports.length === 0) {
    const carried = wiki.carried.length ? `; ${wiki.carried.length} pages re-checked and moved to ${at}` : "";
    const ran = wiki.costUsd ? `only the planning run, $${wiki.costUsd.toFixed(2)}` : "no AI run";
    console.log(`${wiki.repo}: wiki up to date at ${at}, no page needed rewriting (${ran}${carried})`);
    if (wiki.waiting.length) console.log(`  ${wiki.waiting.join(", ")} failed the check at ${at}; it's tried again after the next change, or with --full`);
    return;
  }
  const action = wiki.mode === "full" ? "written" : "updated";
  console.log(`${wiki.repo}: wiki ${action} at ${at} · $${wiki.costUsd.toFixed(2)} · ${Math.round(wiki.durationMs / 1000)}s`);
  for (const report of wiki.reports) {
    const kept = report.claims - report.removed.length;
    const state = report.published ? "published" : "NOT published (too few claims supported; previous version kept if any)";
    const twice = report.attempts > 1 ? " · second attempt" : "";
    console.log(`  ${report.slug.padEnd(24)} ${kept}/${report.claims} claims kept · ${state}${twice}`);
    for (const claim of report.removed.slice(0, 3)) console.log(`    removed: ${claim.reason} · "${claim.text.slice(0, 90)}…"`);
    if (report.removed.length > 3) console.log(`    … and ${report.removed.length - 3} more`);
  }
  if (wiki.carried.length) console.log(`  unchanged, moved to ${at}: ${wiki.carried.join(", ")}`);
  console.log(`Read them with: brain page ${wiki.repo}`);
}

/** "planned again (a new project at src/Payments.API): +1 page (payments)", or why no plan passed. */
function planText(plan: PlanReport): string {
  if (plan.problems.length) return `wiki not planned again (${plan.reason}): the plan failed the check (${plan.problems.slice(0, 3).join("; ")}), so it kept its pages`;
  const changes = [
    plan.added.length ? `+${count(plan.added.length, "page")} (${plan.added.join(", ")})` : "",
    plan.retired.length ? `−${count(plan.retired.length, "page")} (${plan.retired.join(", ")})` : "",
  ].filter(Boolean);
  return `wiki planned (${plan.reason}): ${changes.join(", ") || "no pages added or dropped"}`;
}

function printTraces(result: TracesResult): void {
  if (result.mode === "none") return;
  const scope = result.mode === "full" ? "traced" : `traced again for ${count(result.followed, "entry point")}`;
  const missing = result.untriggered.length ? ` · ${count(result.untriggered.length, "exit point")} no entry point was found to reach` : "";
  console.log(`${result.repo}: what each entry point leads to ${scope} · ${count(result.kept, "checked chain")}${result.dropped.length ? `, ${result.dropped.length} dropped` : ""}${missing} · $${result.costUsd.toFixed(2)} · ${Math.round(result.durationMs / 1000)}s`);
  for (const drop of result.dropped.slice(0, 3)) console.log(`    dropped: ${drop.entry}: ${drop.reason}`);
  if (result.dropped.length > 3) console.log(`    … and ${result.dropped.length - 3} more`);
}

/** How the hook should run this CLI: absolute paths, since hooks get no predictable PATH. */
function hookCommand(): HookCommand {
  return {
    node: process.execPath,
    brain: fileURLToPath(new URL("../bin/brain.mjs", import.meta.url)),
    dbPath: process.env.BRAIN_DB,
    logPath: join(dirname(resolveDbPath()), "hooks.log"),
  };
}

async function hooks(store: Store, action: string | undefined, name: string | undefined): Promise<void> {
  const names = name ? [name] : store.listRepos().map((repo) => repo.name);
  if (action === "status") {
    for (const repoName of names) {
      const status = await hookStatus(store, repoName);
      const state = status.installed ? "syncs automatically" : status.problem ? `can't install: ${status.problem}` : "manual sync only";
      console.log(`${repoName.padEnd(32)} ${state}`);
    }
  } else if (action === "install") {
    for (const repoName of names) {
      const path = await installHook(store, repoName, hookCommand());
      console.log(`${repoName}: installed ${path}`);
    }
    console.log(`Background syncs log to ${hookCommand().logPath}`);
  } else if (action === "remove") {
    for (const repoName of names) console.log(`${repoName}: ${(await removeHook(store, repoName)) ? "removed" : "no hook installed"}`);
  } else {
    throw new BrainError("Usage: brain hooks install [<name>] | brain hooks remove [<name>] | brain hooks status");
  }
}

async function listRepos(store: Store): Promise<void> {
  const repos = store.listRepos();
  if (repos.length === 0) {
    console.log("No repos enrolled. Add one with: brain add <path>");
    return;
  }
  for (const repo of repos) {
    const state = store.getState(repo.name);
    const status = state ? describeFreshness(await freshnessOf(repo, state), repo.ref) : "not synced";
    console.log(`${repo.name.padEnd(32)} ${status.padEnd(34)} ${repo.path}`);
  }
}

/**
 * Everything a person trying the brain needs for some repos: enrol them, index them, have Claude
 * Code write their wikis and map their links, and install the hooks that keep them current. Says
 * roughly what the AI step costs before it starts. Repos go side by side, and each is answerable
 * (its card, its files) as soon as it's indexed, before its wiki is written.
 */
async function addRepos(
  store: Store,
  paths: readonly string[],
  options: { name?: string; ref?: string; note?: RepoNote; model?: string; ai: boolean; hook: boolean },
): Promise<void> {
  const repos: RepoRecord[] = [];
  for (const path of paths) {
    try {
      const repo = await enrolRepo(store, { path, name: options.name, ref: options.ref, note: options.note });
      console.log(`Added ${repo.name}, tracking ${repo.ref}, from ${repo.path}`);
      repos.push(repo);
    } catch (error) {
      if (!(error instanceof BrainError) || paths.length === 1) throw error;
      console.error(`${path}: not added: ${error.message}`);
      process.exitCode = 1;
    }
  }
  if (options.ai) {
    const estimates = await Promise.all(repos.map(estimate));
    for (const e of estimates) console.log(`${e.repo}: ${e.files} files, roughly $${e.cost[0]}–${e.cost[1]} and ${e.minutes[0]}–${e.minutes[1]} minutes`);
    const most = Math.max(...estimates.map((e) => e.minutes[1]));
    const total = (i: 0 | 1) => estimates.reduce((sum, e) => sum + e.cost[i], 0);
    console.log(
      `Claude Code will now read ${repos.length === 1 ? "it" : `them, ${Math.min(MAX_REPOS, repos.length)} at a time`} to map links and write wikis: ` +
        `roughly $${total(0)}–${total(1)} of your Claude Code allowance${repos.length > 1 ? `, finishing in about ${most}+ minutes` : ""}. Later updates cost cents.`,
    );
  }
  await eachAtOnce(repos, MAX_REPOS, (repo) => repo.name, async (repo) => {
    if (options.ai) await syncAndRefresh(store, repo.name, { model: options.model });
    else printSync(await syncRepo(store, repo.name));
    if (!options.hook) return;
    try {
      await installHook(store, repo.name, hookCommand());
      console.log(`${repo.name}: will re-sync in the background whenever ${repo.ref} moves (log: ${hookCommand().logPath})`);
    } catch (error) {
      if (!(error instanceof BrainError)) throw error;
      console.log(`${repo.name}: no hook installed (${error.message}). Run brain sync ${repo.name} after pulling.`);
    }
  });
  for (const repo of repos) {
    const hint = joinHint(store, repo.name);
    if (hint) console.log(hint);
  }
  if (repos.length === 0) return;
  const first = repos[0]!.name;
  console.log("");
  const later = repos.length === 1 ? `Next: brain sync ${first} to have Claude Code write its wiki` : "Next: brain sync to have Claude Code write their wikis";
  console.log(options.ai ? `Next: ask Claude Code "what does ${first} do?", or run: brain card ${first}` : later);
}

/** Rough first-sync cost and time from a repo's size, measured on the trial repos. */
async function estimate(repo: RepoRecord): Promise<{ repo: string; files: number; cost: [number, number]; minutes: [number, number] }> {
  const files = (await listTree(repo.path, await resolveCommit(repo.path, repo.ref))).length;
  const [cost, minutes]: [[number, number], [number, number]] =
    files <= 300 ? [[0.5, 2], [2, 5]] : files <= 1000 ? [[1, 4], [5, 10]] : [[8, 12], [15, 25]];
  return { repo: repo.name, files, cost, minutes };
}

/** `brain note <repo> ["<text>" | --clear | --confirm]`: the note that steers a repo's wiki. */
async function repoNote(store: Store, name: string | undefined, text: string | undefined, values: { clear: boolean; confirm: boolean }): Promise<void> {
  if (!name) throw new BrainError('Usage: brain note <repo> ["<what the wiki should focus on>" | --clear | --confirm]');
  const repo = requireRepo(store, name);
  if (values.confirm) {
    const note = confirmProposedNote(store, name, await localPerson());
    console.log(`${name}: note confirmed: "${note.text}". The next sync plans its wiki with it.`);
  } else if (values.clear) {
    setRepoNote(store, name, null);
    console.log(`${name}: note cleared.`);
  } else if (text) {
    setRepoNote(store, name, { text, by: await localPerson(), at: new Date().toISOString() });
    console.log(`${name}: note set. The next sync plans its wiki with it, and each page follows it when next rewritten (sync ${name} --only wiki --full rewrites them all now).`);
  } else {
    console.log(repo.note ? `${name}: "${repo.note.text}" (${repo.note.by}, ${repo.note.at.slice(0, 10)})` : `${name}: no note`);
    if (repo.proposedNote) console.log(`  proposed by ${repo.proposedNote.by}: "${repo.proposedNote.text}". Confirm with: brain note ${name} --confirm`);
  }
}

/** `brain wiki plan <repo>`: a large repo's page plan, and which pages are written. */
function printPlan(store: Store, name: string): void {
  requireRepo(store, name);
  const plan = store.wikiPlan(name);
  const pages = new Map(store.pages(name).map((p) => [p.slug, p]));
  if (plan.length === 0) {
    const map = inventory(store.getFiles(name));
    console.log(
      map.large
        ? `${name} has no page plan yet: it's large (${map.sourceFiles} source files, ${count(map.projects.length, "project")}), so its next sync plans a page per area.`
        : `${name} has no page plan: it's small enough for the fixed pages (${[...pages.keys()].join(", ") || "none written yet"}).`,
    );
    return;
  }
  const state = store.getState(name);
  console.log(`${name}: ${count(plan.length, "page")} planned at @${state?.planCommit?.slice(0, 7) ?? "?"}${state?.planNote ? ", with its note" : ""}`);
  for (const page of plan) {
    const written = pages.get(page.slug);
    console.log(`  ${page.slug.padEnd(24)} ${page.kind.padEnd(12)} ${written ? `written @${written.commit.slice(0, 7)}` : "not written yet"}`);
    if (page.brief) console.log(`    ${page.brief}`);
    if (page.covers.length) console.log(`    covers ${page.covers.join(", ")}`);
  }
}

/** `brain systems`: list, suggest, show, confirm, set, rename, remove. */
async function systems(
  store: Store,
  tools: ToolDeps,
  action: string | undefined,
  args: string[],
  options: { all: boolean; summary?: string; model?: string },
): Promise<void> {
  const [name, ...rest] = args;
  switch (action) {
    case undefined:
    case "list": {
      const all = store.systems();
      if (all.length === 0) {
        console.log("No systems yet. Suggest them with: brain systems suggest");
        return;
      }
      for (const system of all) {
        console.log(`${system.name} (${system.status}) · ${count(system.repos.length, "repo")}: ${system.repos.join(", ") || "none"}`);
        if (system.summary) console.log(`  ${system.summary}`);
        if (system.status === "suggested" && system.reason) console.log(`  why: ${system.reason}`);
      }
      const grouped = new Set(all.flatMap((s) => s.repos));
      const ungrouped = store.listRepos().map((r) => r.name).filter((r) => !grouped.has(r));
      if (ungrouped.length) console.log(`In no system: ${ungrouped.join(", ")}`);
      if (all.some((s) => s.status === "suggested")) console.log("\nConfirm with: brain systems confirm <system> (or --all); fix with: brain systems set <system> <repo>...");
      return;
    }
    case "suggest":
      printSuggestion(await suggestSystems(store, runner, { model: options.model }));
      return;
    case "show":
      if (!name) throw new BrainError("Usage: brain systems show <system>");
      print(await systemOverview(tools, LOCAL_CALLER, name));
      return;
    case "confirm": {
      if (!name && !options.all) throw new BrainError("Usage: brain systems confirm <system> | --all");
      const confirmed = store.confirmSystems(options.all ? null : [name!]);
      if (confirmed.length) console.log(`Confirmed: ${confirmed.join(", ")}`);
      else console.log(options.all ? "No suggested systems to confirm." : `No suggested system named "${name}". See: brain systems`);
      return;
    }
    case "set": {
      if (!name || (rest.length === 0 && options.summary === undefined)) throw new BrainError('Usage: brain systems set <system> <repo>... [--summary "<one line>"]');
      const unknown = rest.filter((repo) => !store.getRepo(repo));
      if (unknown.length) throw new BrainError(`Not enrolled: ${unknown.join(", ")}. See: brain repo list`);
      const existed = store.systems().some((s) => s.name.toLowerCase() === name.toLowerCase());
      store.setSystem(name, rest, options.summary);
      const system = store.systems().find((s) => s.name.toLowerCase() === name.toLowerCase())!;
      console.log(`${existed ? "Updated" : "Created"} ${system.name} (confirmed): ${system.repos.join(", ") || "no repos"}`);
      return;
    }
    case "rename":
      if (!name || !rest[0]) throw new BrainError("Usage: brain systems rename <system> <new name>");
      if (!store.renameSystem(name, rest[0])) throw new BrainError(`No system named "${name}". See: brain systems`);
      console.log(`Renamed ${name} to ${rest[0]}.`);
      return;
    case "remove":
      if (!name) throw new BrainError("Usage: brain systems remove <system>");
      if (!store.removeSystem(name)) throw new BrainError(`No system named "${name}". See: brain systems`);
      console.log(`Removed ${name}. Its repos are still enrolled, now in no system.`);
      return;
    default:
      throw new BrainError("Usage: brain systems [suggest | show <system> | confirm <system> | set <system> <repo>... | rename <system> <new> | remove <system>]");
  }
}

function printSuggestion(result: SuggestResult): void {
  if (result.costUsd === 0 && result.kept.length === 0 && result.dropped.length === 0) {
    console.log("Every repo is already in a confirmed system, so there is nothing to suggest.");
    return;
  }
  console.log(`Suggested ${count(result.kept.length, "system")} · $${result.costUsd.toFixed(2)} · ${Math.round(result.durationMs / 1000)}s`);
  for (const system of result.kept) {
    console.log(`  ${system.name}: ${system.repos.join(", ")}`);
    if (system.summary) console.log(`    ${system.summary}`);
    console.log(`    why: ${system.reason}`);
  }
  for (const drop of result.dropped) console.log(`  dropped ${drop.system}: ${drop.reason}`);
  for (const note of result.leftOut) console.log(`  left out of ${note.system}: ${note.reason}`);
  if (result.confirmed.length) console.log(`Already in confirmed systems, so left as they are: ${result.confirmed.join(", ")}`);
  if (result.ungrouped.length) console.log(`In no system: ${result.ungrouped.join(", ")}`);
  if (result.kept.length) console.log("Agents see these labelled suggested. Confirm with: brain systems confirm <system> (or --all)");
}

/** `brain facts`: list, add, confirm, edit, retire, export. */
async function facts(
  store: Store,
  tools: ToolDeps,
  action: string | undefined,
  arg: string | undefined,
  options: { all: boolean; full: boolean; model?: string; kind?: string; text?: string; quote?: string; ticket?: string; anchor?: string[] },
): Promise<void> {
  const readable = store.listRepos().map((r) => r.name);
  const filter = (target?: string) => {
    if (!target) return { ...visibleFacts(store, readable), retired: options.all };
    if (store.getRepo(target)) return { repos: [target], systems: [], retired: options.all };
    const system = findSystem(store, target, readable);
    if (!system) throw new BrainError(`No repo or system named "${target}". See: brain repo list, brain systems`);
    return { repos: [], systems: [system.name], retired: options.all };
  };
  const byId = (id: string | undefined) => {
    const fact = id && /^\d+$/.test(id) ? store.getFact(Number(id)) : undefined;
    if (!fact) throw new BrainError(`No fact #${id ?? "?"}. See: brain facts`);
    return fact;
  };
  const now = () => new Date().toISOString();
  switch (action) {
    case "add": {
      if (!arg || !options.kind || !options.text) throw new BrainError('Usage: brain facts add <repo or system> --kind rule --text "<fact>" [--quote "<their words>"] [--anchor <file:lines>]... [--ticket <t>]');
      const repo = store.getRepo(arg) ? arg : undefined;
      const person = await localPerson();
      // Running the command is the person confirming it.
      const result = await recordFact(
        tools,
        LOCAL_CALLER,
        { repo, system: repo ? undefined : arg, kind: options.kind as FactKind, text: options.text, quote: options.quote ?? options.text, ticket: options.ticket, anchors: options.anchor },
        { confirm: async ({ text, statedBy }) => ({ action: "accept", text, statedBy }), person },
      );
      print(result);
      return;
    }
    case "confirm": {
      const fact = byId(arg);
      if (fact.status === "confirmed" && !fact.staleSince) {
        console.log(`Fact #${fact.id} is already confirmed.`);
        return;
      }
      confirmFact(store, fact, await localPerson(), now(), fact.repo ? store.getState(fact.repo)?.commit ?? null : null);
      console.log(`- ${factLine(store.getFact(fact.id)!)}`);
      if (fact.replaces) console.log(`Retired fact #${fact.replaces}, which it replaces.`);
      if (fact.staleSince && fact.anchors.length) console.log("Its code changed: if the anchors no longer point at it, fix them with: brain facts edit " + fact.id + " --anchor <file:lines>");
      return;
    }
    case "edit": {
      const fact = byId(arg);
      if (options.text === undefined && !options.anchor?.length) throw new BrainError('Usage: brain facts edit <id> [--text "<fact>"] [--anchor <file:lines>]...');
      let anchors: Partial<FactRecord> = {};
      if (options.anchor?.length) {
        const repo = fact.repo ? store.getRepo(fact.repo) : undefined;
        const state = fact.repo ? store.getState(fact.repo) : undefined;
        if (!repo || !state) throw new BrainError("Anchors point at lines in a repo: this fact is on a system.");
        const cites = options.anchor.map((a) => parseAnchor(a) ?? fail(`Anchors are file:lines, e.g. src/follow.ts:12-20. Can't read: ${a}`));
        const problems = await anchorProblems(repo.path, state.commit, cites);
        if (problems.length) throw new BrainError(`The anchors don't hold at @${state.commit.slice(0, 7)}: ${problems.join("; ")}`);
        anchors = { anchors: cites, anchorCommit: state.commit, staleSince: null };
      }
      store.updateFact(fact.id, { ...(options.text !== undefined ? { text: options.text.trim() } : {}), ...anchors });
      console.log(`- ${factLine(store.getFact(fact.id)!)}`);
      return;
    }
    case "retire": {
      const fact = byId(arg);
      store.updateFact(fact.id, { status: "retired" });
      console.log(`Retired fact #${fact.id}. Agents no longer see it; brain facts --all still lists it.`);
      return;
    }
    case "check": {
      // The repos to check in: the one named, a system's members, or every repo with a fact.
      const repos = arg
        ? store.getRepo(arg)
          ? [arg]
          : findSystem(store, arg, readable)?.repos ?? fail(`No repo or system named "${arg}". See: brain repo list, brain systems`)
        : readable.filter((repo) => factsAbout(store, repo, readable).length > 0);
      if (repos.length === 0) console.log("No facts to check yet.");
      for (const repo of repos) printChecks(await checkFacts(store, runner, repo, { model: options.model, full: options.full }), true);
      return;
    }
    case "export": {
      const all = store.facts({ ...visibleFacts(store, readable), retired: true });
      if (all.length === 0) {
        console.log("No facts yet.");
        return;
      }
      const targets = [...new Set(all.map((f) => (f.repo ? `repo ${f.repo}` : `system ${f.system}`)))].sort();
      for (const target of targets) {
        console.log(`# ${target}\n`);
        for (const fact of all.filter((f) => (f.repo ? `repo ${f.repo}` : `system ${f.system}`) === target)) {
          console.log(`- ${factLine(fact)}`);
          console.log(`  - Their words: "${fact.quote}"`);
        }
        console.log("");
      }
      return;
    }
    default: {
      // `brain facts` or `brain facts <repo or system>`.
      const target = action === undefined || action === "list" ? arg : action;
      const listed = store.facts(filter(target));
      if (listed.length === 0) {
        console.log(target ? `No facts on ${target} yet.` : "No facts yet. Agents record them with brain_record_fact; you can add one with: brain facts add");
        return;
      }
      for (const fact of listed) console.log(`${(fact.repo ?? fact.system)!.padEnd(24)} ${factLine(fact)}`);
      const toConfirm = listed.filter((f) => f.status === "proposed" || f.staleSince).length;
      if (toConfirm) console.log(`\n${count(toConfirm, "fact")} to confirm: brain facts confirm <id>`);
    }
  }
}

function fail(message: string): never {
  throw new BrainError(message);
}

/**
 * One line per repo whose facts were checked: how many, and what the code does about them, then
 * the facts it contradicts or couldn't settle. Nothing when no fact needed a check, unless asked.
 */
function printChecks(result: FactChecksResult, asked = false): void {
  const at = `@${result.commit.slice(0, 7)}`;
  if (result.checked.length === 0) {
    if (asked) console.log(`${result.repo}: facts already checked at ${at}, and nothing they rest on changed (no AI run; --full checks again)`);
    return;
  }
  const words: Record<string, string> = { agrees: "agrees", contradicts: "contradicts", absent: "not in the code", unclear: "unclear" };
  const tally = Object.entries(words)
    .map(([verdict, word]) => [result.checked.filter((c) => c.verdict === verdict).length, word] as const)
    .filter(([n]) => n > 0)
    .map(([n, word]) => `${n} ${word}`)
    .join(", ");
  console.log(`${result.repo}: ${count(result.checked.length, "fact")} checked against the code at ${at} · ${tally} · $${result.costUsd.toFixed(2)} · ${Math.round(result.durationMs / 1000)}s`);
  for (const check of result.checked.filter((c) => c.verdict === "contradicts" || c.verdict === "unclear")) {
    console.log(`    fact #${check.fact} ${check.verdict}: ${check.summary}`);
  }
}

/** `brain gaps`: what agents searched for and the brain couldn't answer. */
function printGaps(store: Store): void {
  const gaps = store.gaps(50);
  if (gaps.length === 0) {
    console.log("No gaps logged yet: every search found something.");
    return;
  }
  console.log("Searches the brain couldn't answer, most asked first. Worth writing down (brain facts add), or a sign a wiki is missing a page.");
  for (const gap of gaps) console.log(`  ${String(gap.times).padStart(3)}×  "${gap.query}"  (${gap.tools.join(", ")}, last ${gap.lastAsked.slice(0, 10)})`);
}

function print(result: ToolResult<unknown>): void {
  if (!result.ok) throw new BrainError(result.text);
  console.log(result.text);
}

function printSync(result: SyncResult): void {
  const from = result.previousCommit ? `${result.previousCommit.slice(0, 7)} -> ` : "";
  console.log(`${result.repo}: ${from}${result.commit.slice(0, 7)} (+${result.added} ~${result.changed} -${result.removed}, ${result.unchanged} unchanged)`);
  if (result.staleFacts) console.log(`${result.repo}: code under ${count(result.staleFacts, "fact")} from people changed; re-confirm with: brain facts ${result.repo}`);
}

main(process.argv.slice(2)).catch((error: unknown) => {
  const badFlag = String((error as { code?: string }).code).startsWith("ERR_PARSE_ARGS");
  if (error instanceof BrainError || badFlag) {
    console.error((error as Error).message);
  } else {
    console.error(error);
  }
  process.exitCode = 1;
});
