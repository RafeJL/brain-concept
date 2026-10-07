import { execFile } from "node:child_process";
import { hookStatus, type HookCommand } from "./ingest/hooks.js";
import type { Store } from "./store/store.js";

/** One line of `brain doctor`: what was checked, what was found, and how to fix it if it failed. */
export interface Check {
  ok: boolean;
  label: string;
  detail: string;
  fix?: string;
}

/** Runs a program without a shell; `ok` is false if it couldn't start or exited non-zero. */
export type Exec = (command: string, args: string[]) => Promise<{ ok: boolean; out: string }>;

export interface DoctorDeps {
  store: Store;
  dbPath: string;
  nodeVersion: string;
  exec: Exec;
  /** How hooks run the brain, to tell an outdated hook from a current one. */
  hook: HookCommand;
  /** Absolute path to bin/brain-mcp.mjs, for the registration command. */
  mcpEntry: string;
}

/** node:sqlite, which the store uses, has no flag from this version. */
const MIN_NODE = [22, 13];

export const execProgram: Exec = (command, args) =>
  new Promise((resolve) => {
    execFile(command, args, { windowsHide: true, timeout: 30_000 }, (error, stdout, stderr) =>
      resolve({ ok: !error, out: `${stdout}${stderr}`.trim() }),
    );
  });

/**
 * What a person trying the brain needs in place, checked in order: Node, git, Claude Code, the
 * store, the MCP registration, and the hooks. Every failed check says how to fix it.
 */
export async function doctor(deps: DoctorDeps): Promise<Check[]> {
  const checks: Check[] = [];
  const [major = 0, minor = 0] = deps.nodeVersion.split(".").map(Number);
  checks.push({
    ok: major > MIN_NODE[0]! || (major === MIN_NODE[0] && minor >= MIN_NODE[1]!),
    label: "Node",
    detail: deps.nodeVersion,
    fix: `Install Node ${MIN_NODE.join(".")} or later (the store uses the built-in node:sqlite).`,
  });

  const git = await deps.exec("git", ["--version"]);
  checks.push({ ok: git.ok, label: "git", detail: git.ok ? git.out : "not found on PATH", fix: "Install Git for Windows (or git for your OS) and open a new terminal." });

  const claude = await deps.exec("claude", ["--version"]);
  checks.push({
    ok: claude.ok,
    label: "Claude Code",
    detail: claude.ok ? `${claude.out} (sign in by running \`claude\` once, if you haven't)` : "not found on PATH",
    fix: "Install Claude Code, run `claude` once to sign in, then open a new terminal. The brain uses it to write wikis.",
  });

  const repos = deps.store.listRepos();
  const withWiki = repos.filter((repo) => deps.store.pages(repo.name).length > 0).length;
  checks.push({
    ok: true,
    label: "Store",
    detail: `${deps.dbPath} · ${repos.length} repo${repos.length === 1 ? "" : "s"}${repos.length ? `, ${withWiki} with a wiki` : ""}`,
  });

  if (claude.ok) checks.push(mcpCheck(await deps.exec("claude", ["mcp", "get", "citation-brain"]), deps));

  for (const repo of repos) {
    const status = await hookStatus(deps.store, repo.name, deps.hook);
    if (status.problem) checks.push({ ok: false, label: `Hook: ${repo.name}`, detail: status.problem });
    else if (!status.installed) {
      checks.push({ ok: false, label: `Hook: ${repo.name}`, detail: "not installed, so it only updates when you run brain sync", fix: `Run: brain hooks install ${repo.name}` });
    } else if (status.outdated) {
      checks.push({ ok: false, label: `Hook: ${repo.name}`, detail: "installed by an older brain", fix: `Run: brain hooks install ${repo.name}` });
    } else {
      checks.push({ ok: true, label: `Hook: ${repo.name}`, detail: "syncs automatically when its branch moves" });
    }
  }
  return checks;
}

/** Paths compared the way Windows treats them: any slash, any case. */
function samePath(text: string, path: string): boolean {
  const norm = (value: string) => value.replace(/\\/g, "/").toLowerCase();
  return norm(text).includes(norm(path));
}

/** Whether Claude Code has the brain registered, runs this checkout of it, and can connect. */
function mcpCheck(registered: { ok: boolean; out: string }, deps: DoctorDeps): Check {
  const env = process.env.BRAIN_DB ? ` -e BRAIN_DB="${deps.dbPath}"` : "";
  const add = `claude mcp add --scope user${env} citation-brain -- node "${deps.mcpEntry}"`;
  if (!registered.ok) {
    return { ok: false, label: "MCP server", detail: "not registered, so Claude Code can't ask the brain", fix: `Run: ${add}` };
  }
  if (!samePath(registered.out, deps.mcpEntry)) {
    return {
      ok: false,
      label: "MCP server",
      detail: "registered, but it runs a different copy of the brain",
      fix: `Run: claude mcp remove citation-brain -s user, then: ${add}`,
    };
  }
  if (/failed|✘/i.test(registered.out)) {
    return { ok: false, label: "MCP server", detail: "registered, but Claude Code can't connect to it", fix: "Run: claude mcp get citation-brain, and check the command runs on its own." };
  }
  return { ok: true, label: "MCP server", detail: "citation-brain is registered in Claude Code and connects" };
}

/** The checks as `brain doctor` prints them, ending with what to do next. */
export function formatChecks(checks: readonly Check[], hasRepos: boolean): string {
  const lines = checks.flatMap((check) => [
    `${check.ok ? "✓" : "✗"} ${check.label.padEnd(14)} ${check.detail}`,
    ...(!check.ok && check.fix ? [`  ${" ".repeat(14)} → ${check.fix}`] : []),
  ]);
  const failed = checks.filter((check) => !check.ok).length;
  lines.push("");
  if (failed) lines.push(`${failed} thing${failed === 1 ? "" : "s"} to fix. Run brain doctor again afterwards.`);
  else if (!hasRepos) lines.push("All set. Next: brain add <path to a git repo>");
  else lines.push("All set. Ask Claude Code about one of your repos, e.g. \"what does <repo> do?\"");
  return lines.join("\n");
}
