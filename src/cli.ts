import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { resolveDbPath } from "./config.js";
import { runQueued } from "./core/queue.js";
import { BrainError } from "./core/types.js";
import { hookStatus, installHook, removeHook, type HookCommand } from "./ingest/hooks.js";
import { enrolRepo, removeRepo, setRepoRef } from "./ingest/registry.js";
import { syncRepo, type SyncResult } from "./ingest/sync.js";
import { LOCAL_CALLER, LocalAccessPolicy } from "./serve/access.js";
import { describeFreshness, freshnessOf } from "./serve/freshness.js";
import type { Format, ToolDeps, ToolResult } from "./serve/tools/common.js";
import { findConsumers } from "./serve/tools/find-consumers.js";
import { getPage } from "./serve/tools/get-page.js";
import { impact } from "./serve/tools/impact.js";
import { repoCard } from "./serve/tools/repo-card.js";
import { SqliteStore } from "./store/sqlite.js";
import { DEFAULT_MODEL, generateWiki, type WikiResult } from "./wiki/generate.js";
import { claudeRunner } from "./wiki/runner.js";
import type { Store } from "./store/store.js";

const HELP = `brain: organisation-wide context for coding agents

Usage:
  brain repo add <path> [--name <name>] [--ref <branch>]   enrol a local clone
  brain repo list                                          enrolled repos and freshness
  brain repo set-ref <name> <ref>                          index a different ref, e.g. origin/main
  brain repo remove <name>                                 remove a repo, its facts and its hook
  brain sync [<name>] [--wiki]                             index the tracked branch (all repos if no name);
                                                           --wiki also updates the wiki of repos that have one
  brain hooks install|remove [<name>]                      re-sync automatically when the tracked ref moves
  brain hooks status                                       which repos sync automatically
  brain wiki <name> [--full] [--model <model>]             sync, then have Claude Code write the repo's wiki, or
                                                           rewrite only the pages changes affect (default ${DEFAULT_MODEL})
  brain page <name> [<page>]                               a wiki page (or the page list) as an agent gets it
  brain card <name> [--detailed]                           the repo card an agent would get
  brain consumers "<METHOD /path>" [--detailed]            who serves and who calls an endpoint
  brain impact <repo> [--path <file>] [--route "<METHOD /path>"] [--detailed]
                                                           routes a repo or file serves, and their callers

Store: ${resolveDbPath()} (set BRAIN_DB to change)`;

async function main(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      name: { type: "string" },
      ref: { type: "string" },
      path: { type: "string" },
      route: { type: "string" },
      model: { type: "string" },
      wiki: { type: "boolean", default: false },
      full: { type: "boolean", default: false },
      detailed: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const [command, sub, arg, extra] = positionals;
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
          console.log(`Removed ${arg}, its facts and its hook.`);
        } else {
          throw new BrainError("Usage: brain repo add <path> | list | set-ref <name> <ref> | remove <name>");
        }
        break;
      case "sync": {
        const names = sub ? [sub] : store.listRepos().map((repo) => repo.name);
        if (names.length === 0) throw new BrainError("No repos enrolled. Run: brain repo add <path>");
        for (const name of names) {
          if (!values.wiki) printSync(await syncRepo(store, name));
          else await syncAndWiki(store, name, { model: values.model, onlyIfWiki: true });
        }
        break;
      }
      case "hooks":
        await hooks(store, sub, arg);
        break;
      case "wiki":
        if (!sub) throw new BrainError("Usage: brain wiki <name> [--full] [--model <model>]");
        console.log(`Bringing ${sub}'s wiki up to date with Claude Code (${values.model ?? DEFAULT_MODEL}); writing pages takes a few minutes...`);
        await syncAndWiki(store, sub, { model: values.model, full: values.full });
        break;
      case "page":
        if (!sub) throw new BrainError("Usage: brain page <name> [<page>]");
        print(await getPage(tools, LOCAL_CALLER, { repo: sub, page: arg }));
        break;
      case "card":
        if (!sub) throw new BrainError("Usage: brain card <name> [--detailed]");
        print(await repoCard(tools, LOCAL_CALLER, sub, format));
        break;
      case "consumers":
        if (!sub) throw new BrainError("Usage: brain consumers \"GET /api/orders/{id}\" [--detailed]");
        print(await findConsumers(tools, LOCAL_CALLER, { target: sub, format }));
        break;
      case "impact":
        if (!sub) throw new BrainError("Usage: brain impact <repo> [--path <file>] [--route \"GET /path\"] [--detailed]");
        print(await impact(tools, LOCAL_CALLER, { repo: sub, path: values.path, route: values.route, format }));
        break;
      default:
        throw new BrainError(`Unknown command "${command}".\n\n${HELP}`);
    }
  } finally {
    store.close();
  }
}

/**
 * Syncs a repo, then brings its wiki up to the new commit, one run per repo at a time: a hook
 * firing mid-run is folded into one more pass when this one finishes.
 */
async function syncAndWiki(store: Store, name: string, options: { model?: string; full?: boolean; onlyIfWiki?: boolean }): Promise<void> {
  let full = options.full;
  const outcome = await runQueued(join(dirname(resolveDbPath()), "locks"), name, async () => {
    printSync(await syncRepo(store, name));
    if (options.onlyIfWiki && store.pages(name).length === 0) return;
    printWiki(await generateWiki(store, claudeRunner, name, { model: options.model, full }));
    full = false;
  });
  if (outcome === "queued") console.log(`${name}: already being synced; that run will go again to pick this up.`);
}

function printWiki(wiki: WikiResult): void {
  const at = `@${wiki.commit.slice(0, 7)}`;
  if (wiki.reports.length === 0) {
    const carried = wiki.carried.length ? `; ${wiki.carried.length} pages re-checked and moved to ${at}` : "";
    console.log(`${wiki.repo}: wiki up to date at ${at}, nothing its pages cite changed (no AI run${carried})`);
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
    console.log("No repos enrolled. Run: brain repo add <path>");
    return;
  }
  for (const repo of repos) {
    const state = store.getState(repo.name);
    const status = state ? describeFreshness(await freshnessOf(repo, state), repo.ref) : "not synced";
    console.log(`${repo.name.padEnd(32)} ${status.padEnd(34)} ${repo.path}`);
  }
}

function print(result: ToolResult<unknown>): void {
  if (!result.ok) throw new BrainError(result.text);
  console.log(result.text);
}

function printSync(result: SyncResult): void {
  const from = result.previousCommit ? `${result.previousCommit.slice(0, 7)} -> ` : "";
  const extract = result.fullExtract ? "extractors changed, re-read every file" : `${result.extracted} files with seams`;
  console.log(
    `${result.repo}: ${from}${result.commit.slice(0, 7)} ` +
      `(+${result.added} ~${result.changed} -${result.removed}, ${result.unchanged} unchanged; ${extract})`,
  );
  for (const path of result.failures) console.error(`  could not extract ${path}`);
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
