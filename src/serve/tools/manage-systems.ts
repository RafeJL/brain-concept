import type { Caller } from "../access.js";
import { findSystem, visibleSystems } from "../systems.js";
import { readableRepos, type ToolDeps, type ToolResult } from "./common.js";

export type SystemAction = "confirm" | "set" | "rename";
export const SYSTEM_ACTIONS: readonly SystemAction[] = ["confirm", "set", "rename"];

export interface SystemsInput {
  action: SystemAction;
  /** The system's name. set creates it when there is none. */
  system: string;
  /** set: repos to add to it, moved out of any other system. */
  repos?: string[];
  /** set: its one-line summary. */
  summary?: string;
  /** rename: the new name. */
  to?: string;
  /** The person's words agreeing to this change, said in the conversation. */
  confirmedWith?: string;
}

const MAX_CHARS = 300;

/**
 * Which repos make up which product, curated from a conversation: confirm a suggested one, add or move repos and change a summary, rename one. Changes need the person's
 * words agreeing, as facts do. Removing a system stays in the terminal. Backs `brain_systems`.
 */
export async function manageSystems(deps: ToolDeps, caller: Caller, input: SystemsInput): Promise<ToolResult<unknown>> {
  const readable = await readableRepos(deps, caller);
  const visible = visibleSystems(deps.store, readable);
  const words = input.confirmedWith?.trim();
  if (!words) return { ok: false, text: "Nothing changed. Give confirmed_with: the person's words agreeing to the change, after you've shown it to them. Never decide for them." };
  if (words.length > MAX_CHARS * 2) return { ok: false, text: `Keep confirmed_with under ${MAX_CHARS * 2} characters.` };
  const name = input.system.trim();
  if (!name) return { ok: false, text: "Give the system's name." };
  const system = findSystem(deps.store, name, readable);
  const known = `Systems you can see: ${visible.map((s) => s.name).join(", ") || "none"}.`;

  switch (input.action) {
    case "confirm": {
      if (!system) return { ok: false, text: `No system named "${name}". ${known}` };
      if (system.status === "confirmed") return { ok: true, data: system, text: `${system.name} is already confirmed.` };
      deps.store.confirmSystems([system.name]);
      return { ok: true, data: system, text: `Confirmed ${system.name}: ${system.repos.join(", ")}. Agents no longer see it labelled suggested.` };
    }
    case "set": {
      const repos = input.repos ?? [];
      const summary = input.summary?.trim();
      if (repos.length === 0 && summary === undefined) return { ok: false, text: "Give repos to add, a summary, or both." };
      if (summary && summary.length > MAX_CHARS) return { ok: false, text: `Keep the summary under ${MAX_CHARS} characters.` };
      const unknown = repos.filter((r) => !readable.includes(r));
      if (unknown.length) return { ok: false, text: `No readable repo named ${unknown.map((r) => `"${r}"`).join(", ")}. Repos you can read: ${readable.join(", ")}.` };
      // A system the caller can't see keeps its name to itself: making one with that name fails as a clash would.
      if (!system && deps.store.systems().some((s) => s.name.toLowerCase() === name.toLowerCase())) return { ok: false, text: `"${name}" can't be used as a system name. ${known}` };
      const moved = repos.flatMap((r) => {
        const from = visible.find((s) => s.repos.includes(r) && s.name !== system?.name);
        return from ? [`${r} (from ${from.name})`] : [];
      });
      deps.store.setSystem(system?.name ?? name, repos, summary);
      // Read back by name: a new system with no repos yet has no readable member to be visible by.
      const after = deps.store.systems().find((s) => s.name.toLowerCase() === (system?.name ?? name).toLowerCase())!;
      return {
        ok: true,
        data: after,
        text: `${system ? "Updated" : "Created"} ${after.name}, confirmed: ${after.repos.join(", ") || "no repos yet"}.${moved.length ? ` Moved ${moved.join(", ")}.` : ""}${summary ? ` Summary: ${summary}` : ""}`,
      };
    }
    case "rename": {
      const to = input.to?.trim();
      if (!system) return { ok: false, text: `No system named "${name}". ${known}` };
      if (!to) return { ok: false, text: "Give the new name (to)." };
      if (deps.store.systems().some((s) => s.name.toLowerCase() === to.toLowerCase() && s.name !== system.name)) return { ok: false, text: `"${to}" can't be used: another system has that name.` };
      deps.store.renameSystem(system.name, to);
      return { ok: true, data: { from: system.name, to }, text: `Renamed ${system.name} to ${to}. Facts on it moved with it.` };
    }
  }
}
