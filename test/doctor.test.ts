import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { doctor, formatChecks, type Exec } from "../src/doctor.js";
import { installHook, type HookCommand } from "../src/ingest/hooks.js";
import { enrolRepo } from "../src/ingest/registry.js";
import { SqliteStore } from "../src/store/sqlite.js";
import { makeRepo, tempDir } from "./helpers.js";

const MCP_ENTRY = "C:\\brain\\bin\\brain-mcp.mjs";

/** A machine where only the programs in `installed` exist, answering with `outputs`. */
function machine(installed: string[], outputs: Record<string, string> = {}): Exec {
  return async (command, args) => {
    if (!installed.includes(command)) return { ok: false, out: "" };
    const key = [command, ...args].join(" ");
    if (key === "claude mcp get citation-brain") return outputs[key] === undefined ? { ok: false, out: "not found" } : { ok: true, out: outputs[key]! };
    return { ok: true, out: outputs[key] ?? `${command} 1.0` };
  };
}

function hook(): HookCommand {
  return { node: process.execPath, brain: "C:/brain/bin/brain.mjs", logPath: join(tempDir(), "hooks.log") };
}

const REGISTERED = `citation-brain:\n  Status: ✔ Connected\n  Command: node\n  Args: c:/brain/bin/brain-mcp.mjs\n`;

async function run(exec: Exec, store = new SqliteStore(":memory:"), command = hook()) {
  const checks = await doctor({ store, dbPath: "brain.db", nodeVersion: "24.1.0", exec, hook: command, mcpEntry: MCP_ENTRY });
  return { checks, text: formatChecks(checks, store.listRepos().length > 0) };
}

describe("brain doctor", () => {
  it("passes on a ready machine and says what to do next", async () => {
    const { checks, text } = await run(machine(["git", "claude"], { "claude mcp get citation-brain": REGISTERED }));

    expect(checks.every((check) => check.ok)).toBe(true);
    expect(text).toContain("✓ MCP server");
    expect(text).toContain('All set. Next: ask Claude Code to "add <GitHub URL or folder> to the brain", or run: brain add <path or GitHub URL>');
  });

  it("says how to fix a missing git or Claude Code, and skips the MCP check without Claude Code", async () => {
    const { checks, text } = await run(machine([]));

    expect(checks.map((check) => `${check.ok ? "✓" : "✗"} ${check.label}`)).toEqual(["✓ Node", "✗ git", "✗ Claude Code", "✓ Store"]);
    expect(text).toContain("→ Install Git");
    expect(text).toContain("→ Install Claude Code, run `claude` once to sign in");
    expect(text).toContain("2 things to fix.");
  });

  it("prints the exact registration command for this checkout, and spots one registered elsewhere", async () => {
    const missing = await run(machine(["git", "claude"]));
    const elsewhere = await run(machine(["git", "claude"], { "claude mcp get citation-brain": REGISTERED.replace("c:/brain", "d:/old-brain") }));

    expect(missing.text).toContain(`→ Run: claude mcp add --scope user citation-brain -- node "${MCP_ENTRY}"`);
    expect(elsewhere.text).toContain("registered, but it runs a different copy of the brain");
    expect(elsewhere.text).toContain("claude mcp remove citation-brain -s user");
  });

  it("refuses Node older than 22.13", async () => {
    const store = new SqliteStore(":memory:");
    const checks = await doctor({ store, dbPath: "brain.db", nodeVersion: "22.12.0", exec: machine(["git"]), hook: hook(), mcpEntry: MCP_ENTRY });

    expect(checks[0]).toMatchObject({ ok: false, label: "Node" });
  });

  it("flags repos without a hook, and hooks an older brain wrote", async () => {
    const store = new SqliteStore(":memory:");
    await enrolRepo(store, { path: makeRepo({ "a.ts": "1" }), name: "current" });
    await enrolRepo(store, { path: makeRepo({ "a.ts": "1" }), name: "old" });
    await enrolRepo(store, { path: makeRepo({ "a.ts": "1" }), name: "none" });
    const command = hook();
    await installHook(store, "current", command);
    // An older brain passed flags this one no longer accepts.
    await installHook(store, "old", { ...command, syncFlags: ["--wiki"] });

    const { checks } = await run(machine(["git", "claude"], { "claude mcp get citation-brain": REGISTERED }), store, command);
    const hooks = Object.fromEntries(checks.filter((c) => c.label.startsWith("Hook")).map((c) => [c.label, c.ok ? "ok" : c.detail]));

    expect(hooks).toEqual({
      "Hook: current": "ok",
      "Hook: none": "not installed, so it only updates when you run brain sync",
      "Hook: old": "installed by an older brain",
    });
  });

  it("shows enrolments under way, and says how to finish one that failed", async () => {
    const store = new SqliteStore(":memory:");
    await enrolRepo(store, { path: makeRepo({ "a.ts": "1" }), name: "busy" });
    const at = new Date().toISOString();
    const base = { error: null, files: null, estimate: null, costUsd: 0, startedAt: at, updatedAt: at, finishedAt: null };
    // This test's own process stands in for the one enrolling "busy", whose hook comes at the end.
    store.saveEnrolment({ ...base, repo: "busy", source: "acme/busy", status: "running", step: "writing the wiki (2 of 6 pages)", pid: process.pid });
    store.saveEnrolment({ ...base, repo: "gone", source: "acme/gone", status: "failed", step: "cloning it", pid: null, error: "git clone failed: Repository not found." });

    const { checks } = await run(machine(["git", "claude"], { "claude mcp get citation-brain": REGISTERED }), store);

    expect(checks.find((c) => c.label === "Enrolling: busy")).toMatchObject({ ok: true, detail: "writing the wiki (2 of 6 pages) (brain card busy shows how far it has got)" });
    expect(checks.find((c) => c.label === "Enrolling: gone")).toMatchObject({
      ok: false,
      detail: "failed while cloning it: git clone failed: Repository not found.",
      fix: 'Run: brain add "acme/gone" to finish it (it redoes only what\'s missing), or brain repo remove gone',
    });
    expect(checks.some((c) => c.label === "Hook: busy")).toBe(false);
  });
});
