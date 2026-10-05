import type { FactDraft } from "../../core/facts.js";
import { escapeRegExp, fileName, isRepoOwn, lineMatching, type FactReader } from "./reader.js";

/** A package.json's name and scripts, each cited by line. */
export const packageJson: FactReader = {
  name: "package-json",
  wants: (path) => fileName(path) === "package.json" && isRepoOwn(path),
  needsContent: true,
  read(_path, text) {
    let manifest: unknown;
    try {
      manifest = JSON.parse(text);
    } catch {
      return [];
    }
    if (!isObject(manifest)) return [];

    const facts: FactDraft[] = [];
    if (typeof manifest.name === "string") {
      facts.push({ kind: "package", name: manifest.name, value: manifest.name, line: lineMatching(text, /^\s*"name"\s*:/) });
    }
    if (isObject(manifest.scripts)) {
      const scriptsLine = lineMatching(text, /^\s*"scripts"\s*:/) ?? 1;
      for (const [name, command] of Object.entries(manifest.scripts)) {
        if (typeof command !== "string") continue;
        const line = lineMatching(text, new RegExp(`^\\s*"${escapeRegExp(name)}"\\s*:`), scriptsLine);
        facts.push({ kind: "script", name, value: command, line });
      }
    }
    return facts;
  },
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
