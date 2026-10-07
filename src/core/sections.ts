import { parseCitations, withoutCitations } from "./citations.js";

/** One part of a wiki page, as search indexes and points at it. */
export interface Section {
  /** The `##` or `###` heading it sits under; "" for the text before the first one. */
  heading: string;
  /** Its text with citations taken out, so snippets read as prose. */
  body: string;
  /** The files its citations name, so a file name finds the sections about it. */
  paths: string[];
}

const HEADING = /^#{2,3}\s+(.+?)\s*#*\s*$/;
const FENCE = /^\s*(```|~~~)/;

/**
 * Splits a page at its `##` and `###` headings, ignoring `#` lines inside code blocks. A page is a
 * few thousand words, so a hit on the whole page says little; a section says where to look.
 * Headings with nothing under them are dropped.
 */
export function splitSections(markdown: string): Section[] {
  const parts: { heading: string; lines: string[] }[] = [{ heading: "", lines: [] }];
  let inFence = false;
  for (const line of markdown.split(/\r?\n/)) {
    if (FENCE.test(line)) inFence = !inFence;
    const heading = inFence ? null : HEADING.exec(line);
    if (heading) parts.push({ heading: heading[1]!, lines: [] });
    // The page's own `# Title` is already the page title.
    else if (inFence || !/^#\s/.test(line)) parts[parts.length - 1]!.lines.push(line);
  }
  return parts.flatMap(({ heading, lines }) => {
    const text = lines.join("\n");
    const body = withoutCitations(text).replace(/\s+/g, " ").replace(/ ([.,;:)])(?=\s|$)/g, "$1").trim();
    if (!body) return [];
    return [{ heading, body, paths: [...new Set(parseCitations(text).map((c) => c.path))] }];
  });
}

/**
 * Text with its camelCase and PascalCase words also written apart, so "orders controller" finds
 * `OrdersController.cs` and "order items" finds `/api/orderItems`. The original stays for exact
 * matches.
 */
export function searchWords(text: string): string {
  const apart = text.replace(/([a-z\d])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
  return apart === text ? text : `${text} ${apart}`;
}
