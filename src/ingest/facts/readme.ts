import type { FactReader } from "./reader.js";

const SUMMARY_MAX = 300;

/**
 * The README's first real paragraph: what the repo says it is, in its authors' words. Headings,
 * badges, HTML, code (fenced or indented), tables and lists are skipped, and so are lead-ins
 * ending in ":" ("Run the following command:"). A quote counts, since many READMEs open with
 * their description in one.
 */
export const readme: FactReader = {
  name: "readme",
  wants: (path) => /^readme(\.md|\.markdown)?$/i.test(path),
  needsContent: true,
  read(_path, text) {
    const found = firstParagraph(text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, ""));
    return found ? [{ kind: "summary", name: "summary", value: found.text, line: found.line }] : [];
  },
};

function firstParagraph(text: string): { text: string; line: number } | undefined {
  const lines = text.split(/\r?\n/);
  let inCode = false;
  let block: string[] = [];
  let start = 0;
  const take = () => {
    const found = block.length && !isHeadingBlock(block) ? plain(block.join(" ")) : "";
    block = [];
    return found.length >= 20 && !found.endsWith(":") ? found : "";
  };
  for (let i = 0; i <= lines.length; i++) {
    const raw = lines[i] ?? "";
    const line = raw.trim().replace(/^(>\s*)+(#+\s+)?/, "");
    if (/^(```|~~~)/.test(line)) inCode = !inCode;
    const indentedCode = block.length === 0 && /^( {4}|\t)/.test(raw);
    const skip = inCode || indentedCode || /^(```|~~~|#|<|\||[-*+] |\d+\. |!\[|\[!\[)/.test(line);
    if (line === "" || skip) {
      const found = take();
      if (found) return { text: truncate(found), line: start + 1 };
      continue;
    }
    if (block.length === 0) start = i;
    block.push(line);
  }
  return undefined;
}

/** A Setext heading: text underlined with === or ---. */
function isHeadingBlock(block: string[]): boolean {
  return block.length >= 2 && /^(=+|-+)$/.test(block[block.length - 1]!);
}

/** Markdown down to plain text: images dropped, links to their text, emphasis and code marks removed. */
function plain(markdown: string): string {
  return markdown
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/(\*\*|__|`)/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function truncate(text: string): string {
  if (text.length <= SUMMARY_MAX) return text;
  const cut = text.slice(0, SUMMARY_MAX);
  return `${cut.slice(0, cut.lastIndexOf(" ") > 0 ? cut.lastIndexOf(" ") : SUMMARY_MAX)}…`;
}
