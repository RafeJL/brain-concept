import { spawn } from "node:child_process";
import { BrainError } from "../core/types.js";

/** One task for the AI: a prompt run in a folder, answered as JSON matching `schema`. */
export interface RunRequest {
  cwd: string;
  prompt: string;
  schema: object;
  model: string;
}

export interface RunResult<T> {
  output: T;
  costUsd: number;
  durationMs: number;
  model: string;
}

/** The only door to an AI. Tests pass a fake; the brain uses `claudeRunner`. */
export interface Runner {
  run<T>(request: RunRequest): Promise<RunResult<T>>;
}

/**
 * Arguments for an isolated, read-only, headless Claude Code run: no MCP servers, no user
 * settings, memory or hooks (so it can't call the brain, or anything else), file tools only,
 * structured output.
 */
export function claudeArgs(request: RunRequest): string[] {
  return [
    "-p", request.prompt,
    "--output-format", "json",
    "--json-schema", JSON.stringify(request.schema),
    "--safe-mode",
    "--strict-mcp-config",
    "--allowedTools", "Read,Grep,Glob",
    "--permission-mode", "dontAsk",
    "--no-session-persistence",
    "--model", request.model,
  ];
}

interface ClaudeResult {
  is_error?: boolean;
  result?: string;
  structured_output?: unknown;
  total_cost_usd?: number;
  duration_ms?: number;
  modelUsage?: Record<string, unknown>;
}

/** Turns Claude Code's `--output-format json` result into a RunResult, or throws why it can't. */
export function parseClaudeResult<T>(stdout: string): RunResult<T> {
  let result: ClaudeResult;
  try {
    result = JSON.parse(stdout) as ClaudeResult;
  } catch {
    throw new BrainError(`Claude Code did not return JSON: ${stdout.slice(0, 200)}`);
  }
  if (result.is_error) throw new BrainError(`Claude Code reported an error: ${String(result.result ?? "").slice(0, 300)}`);
  if (result.structured_output === undefined) throw new BrainError("Claude Code returned no structured output.");
  return {
    output: result.structured_output as T,
    costUsd: result.total_cost_usd ?? 0,
    durationMs: result.duration_ms ?? 0,
    model: Object.keys(result.modelUsage ?? {})[0] ?? "unknown",
  };
}

/** Runs the locally installed Claude Code CLI (`claude` on PATH). */
export const claudeRunner: Runner = {
  run<T>(request: RunRequest): Promise<RunResult<T>> {
    return new Promise((resolve, reject) => {
      const child = spawn("claude", claudeArgs(request), { cwd: request.cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("error", (error) =>
        reject(new BrainError(`Could not start Claude Code ("claude" on PATH): ${error.message}`)),
      );
      child.on("close", (code) => {
        if (!stdout.trim()) return reject(new BrainError(`Claude Code exited with ${code} and no output. ${stderr.slice(0, 300)}`));
        try {
          resolve(parseClaudeResult<T>(stdout));
        } catch (error) {
          reject(error);
        }
      });
    });
  },
};
