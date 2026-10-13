import { formatCitation, parseCitations, type Citation } from "../core/citations.js";
import type { RemovedClaim } from "./check.js";

/** Why a diagram element's citations don't support its label, or null if they do. */
export type ElementCheck = (label: string, cites: readonly Citation[]) => string | null;

export interface CheckedDiagram {
  /** The diagram's lines (without its fences) with unsupported elements removed; null when dropped. */
  lines: string[] | null;
  claims: number;
  removed: RemovedClaim[];
}

/** The diagram types the wiki asks for; anything else can't be checked, so it's dropped. */
const TYPES = /^(flowchart|graph|sequenceDiagram)\b/;
/** A comment line citing the element on the next line: `%% [src/a.ts:12-20]`. */
const CITE_COMMENT = /^\s*%%/;
const ID = /^\s*([A-Za-z_][\w-]*)/;
/** A flowchart link: -->, ---, -.->, ==>, --x, --o, <-->. */
const LINK = /\s*[<xo]?(?:-{2,}|={2,}|-\.+-?)[>xo]?\s*/;
/** A sequence message: A->>B, A-->>B, A->B, A-xB, A-)B, with an optional +/- activation. */
const MESSAGE = /^\s*([^\s:>-][^:>]*?)\s*(?:-{1,2}>>|-{1,2}>|-{1,2}x|-{1,2}\))\s*[+-]?\s*([^:]+?)\s*:\s*(.+)$/;
const NOTE = /^\s*note\s+(?:over|left of|right of)\s+[^:]+:\s*(.+)$/i;
/** Lines that only shape a diagram and claim nothing. */
const STRUCTURE =
  /^\s*(subgraph\b|end\s*$|direction\s|classDef\s|class\s|style\s|linkStyle\s|participant\s|actor\s|autonumber\b|activate\s|deactivate\s|loop\b|alt\b|else\b|opt\b|par\b|and\b|rect\b|critical\b|break\b|box\b)/i;

interface Element {
  line: string;
  cites: Citation[];
  /** Must be cited: a box, a labelled link or a message. A plain link between boxes needn't be. */
  claim: boolean;
  label: string;
  /** Boxes this line defines, and the ids its links join. */
  defines: string[];
  joins: string[];
}

/**
 * Checks a Mermaid diagram the way sentences are checked. Each box, labelled link and message
 * cites its lines in a `%% [path:lines]` comment just above it, and its label's words must appear
 * there. One that fails is removed, along with any link to a box that went; a diagram that loses
 * more than half, or isn't a flowchart or sequence diagram, is dropped whole. Other comments are
 * removed, since nothing checks them.
 */
export function checkDiagram(body: readonly string[], check: ElementCheck): CheckedDiagram {
  const start = body.findIndex((line) => line.trim() !== "" && !CITE_COMMENT.test(line));
  const header = body[start]?.trim() ?? "";
  if (!TYPES.test(header)) {
    return { lines: null, claims: 1, removed: [{ text: header || "(empty diagram)", reason: "not a flowchart or sequence diagram, so it can't be checked" }] };
  }
  const sequence = header.startsWith("sequenceDiagram");

  const elements: Element[] = [];
  let cites: Citation[] = [];
  for (const line of body.slice(start + 1)) {
    if (line.trim() === "") continue;
    if (CITE_COMMENT.test(line)) {
      cites = parseCitations(line);
      continue;
    }
    elements.push({ ...(sequence ? sequenceElement(line) : flowchartElement(line)), line, cites });
    cites = [];
  }

  const removed: RemovedClaim[] = [];
  const failed = new Set<Element>();
  for (const element of elements.filter((e) => e.claim)) {
    const reason = element.cites.length === 0 ? "no citation" : check(element.label, element.cites);
    if (reason) {
      failed.add(element);
      removed.push({ text: element.line.trim(), reason });
    }
  }
  // Flowchart links must join boxes that survived; sequence participants are implicit.
  if (!sequence) {
    const boxes = new Set(elements.filter((e) => !failed.has(e)).flatMap((e) => e.defines));
    for (const element of elements) {
      if (failed.has(element) || element.joins.every((id) => boxes.has(id))) continue;
      failed.add(element);
      if (element.claim) removed.push({ text: element.line.trim(), reason: "joins a box that was removed or never cited" });
    }
  }

  const claims = elements.filter((e) => e.claim).length;
  const kept = claims - removed.length;
  if (claims === 0 || kept < claims / 2) {
    const reason = claims === 0 ? "no element cites the code" : `only ${kept} of ${claims} elements are supported`;
    return { lines: null, claims: Math.max(claims, 1), removed: [...removed, { text: header, reason: `diagram dropped: ${reason}` }] };
  }
  const lines = [body[start]!];
  for (const element of elements) {
    if (failed.has(element)) continue;
    if (element.cites.length) lines.push(`%% [${element.cites.map(formatCitation).join("; ")}]`);
    lines.push(element.line);
  }
  return { lines, claims, removed };
}

type Parsed = Omit<Element, "line" | "cites">;

function flowchartElement(line: string): Parsed {
  if (STRUCTURE.test(line) || /^\s*click\s/.test(line)) return { claim: false, label: "", defines: [], joins: [] };
  // `A -- calls --> B` is `A -->|calls| B`.
  const labels: string[] = [];
  const plain = line
    .replace(/(--|==)\s+([^>|]+?)\s+(-->|==>|---)/g, (_, _a, text: string, arrow: string) => (labels.push(text), arrow))
    .replace(/\|([^|]*)\|/g, (_, text: string) => (labels.push(text), " "));
  const ends = plain.split(LINK).flatMap((part) => part.split("&")).map((part) => part.trim()).filter(Boolean);
  const defines: string[] = [];
  const joins: string[] = [];
  for (const end of ends) {
    const id = ID.exec(end)?.[1];
    if (!id) continue;
    joins.push(id);
    const box = end.slice(end.indexOf(id) + id.length).trim();
    if (/^[[({>]/.test(box)) {
      defines.push(id);
      labels.push(box.replace(/^[[({>/\\]+|[\])}/\\]+$/g, "").replace(/^"|"$/g, ""));
    }
  }
  const link = ends.length > 1;
  return { claim: defines.length > 0 || (link && labels.length > 0), label: labels.join(" "), defines, joins: link ? joins : [] };
}

function sequenceElement(line: string): Parsed {
  const note = NOTE.exec(line);
  if (note) return { claim: true, label: note[1]!, defines: [], joins: [] };
  if (STRUCTURE.test(line)) return { claim: false, label: "", defines: [], joins: [] };
  const message = MESSAGE.exec(line);
  // A line that is neither is something we can't read, so it must be cited like a message.
  return { claim: true, label: message ? message[3]! : line.trim(), defines: [], joins: [] };
}
