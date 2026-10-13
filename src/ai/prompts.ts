import { readFileSync } from "node:fs";

/**
 * The AI's instructions live as Markdown in ./prompts, so they read and review as text. They
 * are passed straight to the run, not installed as skills: the task is fixed rather than
 * something to discover, and runs load no skills or settings, so a repo can't add its own.
 * `{{rules}}` pulls in prompts/rules.md (what the citation checker enforces); other
 * `{{placeholders}}` take `values`. Inserted values are never expanded again.
 */
export function prompt(name: string, values: Record<string, string> = {}): string {
  return read(name).replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    if (key === "rules") return read("rules");
    const value = values[key];
    if (value === undefined) throw new Error(`Prompt ${name} needs a value for {{${key}}}`);
    return value;
  });
}

function read(name: string): string {
  // A Windows checkout gives the files CRLF line endings; prompts are the same whatever the checkout.
  return readFileSync(new URL(`./prompts/${name}.md`, import.meta.url), "utf8").replace(/\r\n/g, "\n").trim();
}
