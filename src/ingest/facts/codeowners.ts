import type { FactDraft } from "../../core/facts.js";
import type { FactReader } from "./reader.js";

/** The places GitHub looks, in the order it looks; only the first one found is used. */
export const CODEOWNERS_PATHS = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"] as const;

/** Every CODEOWNERS rule, in file order (on GitHub the last matching rule wins). */
export const codeowners: FactReader = {
  name: "codeowners",
  wants: (path) => (CODEOWNERS_PATHS as readonly string[]).includes(path),
  needsContent: true,
  read(_path, text) {
    const facts: FactDraft[] = [];
    text.split(/\r?\n/).forEach((raw, index) => {
      const line = raw.replace(/(^|\s)#.*$/, "").trim();
      if (!line) return;
      const [pattern, ...owners] = line.split(/\s+/);
      facts.push({ kind: "owners", name: pattern!, value: owners.join(" "), line: index + 1 });
    });
    return facts;
  },
};
