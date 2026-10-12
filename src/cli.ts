import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { resolveDbPath } from "./config.js";
import { runQueued } from "./core/queue.js";
import { listTree, resolveCommit } from "./core/git.js";
import { familyOf } from "./core/seams.js";
import { BrainError, type RepoRecord } from "./core/types.js";
import { doctor, execProgram, formatChecks } from "./doctor.js";
import { hookStatus, installHook, removeHook, type HookCommand } from "./ingest/hooks.js";
import { enrolRepo, removeRepo, setRepoRef } from "./ingest/registry.js";
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
import { SqliteStore } from "./store/sqlite.js";
import { DEFAULT_MODEL, generateWiki, type WikiResult } from "./ai/generate.js";
import { claudeRunner } from "./ai/runner.js";
import { updateSeams, type SeamsResult } from "./ai/seams.js";
import type { Store } from "./store/store.js";

const HELP = `brain: organisation-wide context for coding agents

Get started:
  brain doctor                                             check Node, git, Claude Code and the MCP registration
  brain add <path> [--name <name>] [--no-hook] [--no-ai]   add a repo: index it, have Claude Code write its wiki and
                                                           map its routes and calls, and keep it up to date

Keep repos up to date:
  brain sync [<name>] [--full] [--only links|wiki] [--no-ai] [--model <m>]
                                                           bring repos up to their tracked branch (all if no name);
                                                           --full redoes everything, --only links or --only wiki
                                                           just that step, --no-ai indexes only
  brain hooks install|remove|status [<name>]               re-sync automatically whenever the tracked branch moves
  brain repo list                                          repos and how up to date each is
  brain repo add <path> [--name <name>] [--ref <branch>]   enrol only (no AI); then brain sync <name>
  brain repo set-ref <name> <ref>                          track a different branch, e.g. origin/release
  brain repo remove <name>                                 remove a repo, everything held about it, and its hook

See what an agent gets:
  brain search "<query>" [--repo <name>]... [--detailed]   search every repo's wiki and endpoints
  brain card <name> [--detailed]                           what a repo is, its wiki, what it calls and what calls it
  brain page <name> [<page>]                               a wiki page, or the list of pages
  brain consumers "<METHOD /path>" [--detailed]            who serves and who calls an endpoint; also
                                                           "event <name>", "grpc <Service/Method>", "package <name>"
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
      detailed: { type: "boolean", default: false },
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
        for (const name of names) {
          if (values["no-ai"]) printSync(await syncRepo(store, name));
          else await syncAndRefresh(store, name, { model: values.model, full: values.full, only: onlyStep(values.only) });
        }
        break;
      }
      case "add": {
        if (!sub) throw new BrainError("Usage: brain add <path to a git repo> [--name <name>] [--no-hook] [--no-ai]");
        await addRepo(store, sub, { name: values.name, ref: values.ref, model: values.model, ai: !values["no-ai"], hook: !values["no-hook"] });
        break;
      }
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
        print(await findConsumers(tools, LOCAL_CALLER, { target: sub, format }));
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
      default:
        throw new BrainError(`Unknown command "${command}".\n\n${HELP}`);
    }
  } finally {
    store.close();
  }
}

/**
 * Syncs a repo, then has Claude Code bring its routes and calls and its wiki up to the new
 * commit. One run per repo at a time: a hook firing mid-run is folded into one more pass when
 * this one finishes. A failed AI step is reported and the next one still runs.
 */
/** `--only links` maps routes, calls and other links without touching the wiki; `--only wiki` the reverse. */
type Step = "links" | "wiki";

function onlyStep(value: string | undefined): Step | undefined {
  if (value === undefined || value === "links" || value === "wiki") return value;
  throw new BrainError(`--only takes links or wiki, not "${value}".`);
}

async function syncAndRefresh(store: Store, name: string, options: { model?: string; full?: boolean; only?: Step }): Promise<void> {
  let full = options.full;
  const outcome = await runQueued(join(dirname(resolveDbPath()), "locks"), name, async () => {
    printSync(await syncRepo(store, name));
    if (options.only !== "wiki") {
      await reported(name, "routes and calls", async () => printSeams(await updateSeams(store, claudeRunner, name, { model: options.model, full })));
    }
    if (options.only !== "links") {
      await reported(name, "wiki", async () => printWiki(await generateWiki(store, claudeRunner, name, { model: options.model, full })));
    }
    full = false;
  });
  if (outcome === "queued") console.log(`${name}: already being synced; that run will go again to pick this up.`);
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
  if (wiki.reports.length === 0) {
    const carried = wiki.carried.length ? `; ${wiki.carried.length} pages re-checked and moved to ${at}` : "";
    console.log(`${wiki.repo}: wiki up to date at ${at}, nothing its pages cite changed (no AI run${carried})`);
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
 * Everything a person trying the brain needs for one repo: enrol it, index it, have Claude Code
 * write its wiki and map its routes and calls, and install the hook that keeps it current. Says
 * roughly what the AI step costs before it starts.
 */
async function addRepo(
  store: Store,
  path: string,
  options: { name?: string; ref?: string; model?: string; ai: boolean; hook: boolean },
): Promise<void> {
  const repo = await enrolRepo(store, { path, name: options.name, ref: options.ref });
  console.log(`Added ${repo.name}, tracking ${repo.ref}, from ${repo.path}`);
  if (options.ai) {
    console.log(await estimate(repo));
    await syncAndRefresh(store, repo.name, { model: options.model });
  } else {
    printSync(await syncRepo(store, repo.name));
  }
  if (options.hook) {
    try {
      await installHook(store, repo.name, hookCommand());
      console.log(`${repo.name}: will re-sync in the background whenever ${repo.ref} moves (log: ${hookCommand().logPath})`);
    } catch (error) {
      if (!(error instanceof BrainError)) throw error;
      console.log(`${repo.name}: no hook installed (${error.message}). Run brain sync ${repo.name} after pulling.`);
    }
  }
  const hint = joinHint(store, repo.name);
  if (hint) console.log(hint);
  console.log("");
  console.log(options.ai ? `Next: ask Claude Code "what does ${repo.name} do?", or run: brain card ${repo.name}` : `Next: brain sync ${repo.name} to have Claude Code write its wiki`);
}

/** Rough first-sync cost and time from the repo's size, measured on the trial repos. */
async function estimate(repo: RepoRecord): Promise<string> {
  const files = (await listTree(repo.path, await resolveCommit(repo.path, repo.ref))).length;
  const [cost, time] = files <= 300 ? ["$0.50–2", "3–6 minutes"] : files <= 1000 ? ["$1–3", "5–10 minutes"] : ["$4–10", "10–20 minutes"];
  return (
    `${repo.name} has ${files} files. Claude Code will now read it to map its routes and calls and write its wiki: ` +
    `roughly ${cost} of your Claude Code allowance and ${time}. Later updates cost cents.`
  );
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
      printSuggestion(await suggestSystems(store, claudeRunner, { model: options.model }));
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

function print(result: ToolResult<unknown>): void {
  if (!result.ok) throw new BrainError(result.text);
  console.log(result.text);
}

function printSync(result: SyncResult): void {
  const from = result.previousCommit ? `${result.previousCommit.slice(0, 7)} -> ` : "";
  console.log(`${result.repo}: ${from}${result.commit.slice(0, 7)} (+${result.added} ~${result.changed} -${result.removed}, ${result.unchanged} unchanged)`);
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
