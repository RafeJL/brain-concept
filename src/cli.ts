import { parseArgs } from "node:util";
import { resolveDbPath } from "./config.js";
import { BrainError } from "./core/types.js";
import { enrolRepo, removeRepo } from "./ingest/registry.js";
import { syncRepo, type SyncResult } from "./ingest/sync.js";
import { LOCAL_CALLER, LocalAccessPolicy } from "./serve/access.js";
import { describeFreshness, freshnessOf } from "./serve/freshness.js";
import { repoCard } from "./serve/tools/repo-card.js";
import { SqliteStore } from "./store/sqlite.js";
import type { Store } from "./store/store.js";

const HELP = `brain: organisation-wide context for coding agents

Usage:
  brain repo add <path> [--name <name>] [--ref <branch>]   enrol a local clone
  brain repo list                                          enrolled repos and freshness
  brain repo remove <name>                                 remove a repo and all its facts
  brain sync [<name>]                                      index the tracked branch (all repos if no name)
  brain card <name> [--detailed]                           the repo card an agent would get

Store: ${resolveDbPath()} (set BRAIN_DB to change)`;

async function main(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      name: { type: "string" },
      ref: { type: "string" },
      detailed: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const [command, sub, arg] = positionals;
  if (!command || values.help || command === "help") {
    console.log(HELP);
    return;
  }

  const store = new SqliteStore(resolveDbPath());
  try {
    switch (command) {
      case "repo":
        if (sub === "add" && arg) {
          const repo = await enrolRepo(store, { path: arg, name: values.name, ref: values.ref });
          console.log(`Enrolled ${repo.name} (tracking ${repo.ref}) from ${repo.path}`);
          console.log(`Next: brain sync ${repo.name}`);
        } else if (sub === "list") {
          await listRepos(store);
        } else if (sub === "remove" && arg) {
          removeRepo(store, arg);
          console.log(`Removed ${arg} and all of its facts.`);
        } else {
          throw new BrainError("Usage: brain repo add <path> | brain repo list | brain repo remove <name>");
        }
        break;
      case "sync": {
        const names = sub ? [sub] : store.listRepos().map((repo) => repo.name);
        if (names.length === 0) throw new BrainError("No repos enrolled. Run: brain repo add <path>");
        for (const name of names) printSync(await syncRepo(store, name));
        break;
      }
      case "card": {
        if (!sub) throw new BrainError("Usage: brain card <name> [--detailed]");
        const deps = { store, access: new LocalAccessPolicy() };
        const result = await repoCard(deps, LOCAL_CALLER, sub, values.detailed ? "detailed" : "concise");
        if (!result.ok) throw new BrainError(result.text);
        console.log(result.text);
        break;
      }
      default:
        throw new BrainError(`Unknown command "${command}".\n\n${HELP}`);
    }
  } finally {
    store.close();
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

function printSync(result: SyncResult): void {
  const from = result.previousCommit ? `${result.previousCommit.slice(0, 7)} → ` : "";
  console.log(
    `${result.repo}: ${from}${result.commit.slice(0, 7)} ` +
      `(+${result.added} ~${result.changed} -${result.removed}, ${result.unchanged} unchanged)`,
  );
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
