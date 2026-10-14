import { cleanPath } from "../core/citations.js";
import type { InheritedRoutes, LinkSurvey, SeamCite } from "../core/seams.js";
import { citationProblem, loose, spanText } from "./check.js";
import { prompt } from "./prompts.js";
import type { Runner } from "./runner.js";

/**
 * Before a repo's links are mapped a few files at a time, one run finds what applies everywhere:
 * convention route templates, base classes whose public methods every derived class serves, and
 * where settings live. Each mapping run is given it; inherited routes are worked out from it by
 * the brain, since mapping runs told about a base class still left those routes out (21 of 35
 * CRUD controllers on atlas, 2026-10-14 spike).
 */

const CITE = { type: "object", properties: { file: { type: "string" }, start: { type: "integer" }, end: { type: "integer" } }, required: ["file", "start", "end"] };
const CITES = { type: "array", items: CITE };
const SCHEMA = {
  type: "object",
  properties: {
    templates: { type: "array", items: { type: "object", properties: { template: { type: "string" }, cites: CITES }, required: ["template", "cites"] } },
    inherited: {
      type: "array",
      items: {
        type: "object",
        properties: {
          base: { type: "string" },
          suffix: { type: "string" },
          cites: CITES,
          routes: { type: "array", items: { type: "object", properties: { method: { type: "string" }, path: { type: "string" }, cites: CITES }, required: ["method", "path", "cites"] } },
        },
        required: ["base", "suffix", "cites", "routes"],
      },
    },
    config_files: { type: "array", items: { type: "string" } },
  },
  required: ["templates", "inherited", "config_files"],
};

export const EMPTY_SURVEY: LinkSurvey = { templates: [], inherited: [], configFiles: [] };

/** Runs the survey and keeps what its cited lines support. A failed run gives an empty survey: mapping goes on without it. */
export async function surveyLinks(runner: Runner, cwd: string, linesOf: (path: string) => string[] | null, model: string): Promise<{ survey: LinkSurvey; costUsd: number }> {
  try {
    const run = await runner.run<unknown>({ cwd, prompt: prompt("survey-links"), schema: SCHEMA, model });
    return { survey: checkSurvey(run.output, linesOf), costUsd: run.costUsd };
  } catch {
    return { survey: EMPTY_SURVEY, costUsd: 0 };
  }
}

/**
 * What of a survey answer its cited lines support: a template written in its lines, a base class
 * named in its declaration, a route whose method (unless GET) and fixed path parts other than
 * `{controller}` are in its lines. Config files that don't exist are dropped.
 */
export function checkSurvey(raw: unknown, linesOf: (path: string) => string[] | null): LinkSurvey {
  const answer = (raw ?? {}) as Partial<{ templates: unknown[]; inherited: unknown[]; config_files: unknown[] }>;
  const spans = (cites: unknown): string[] | null => {
    if (!Array.isArray(cites) || cites.length === 0) return null;
    const out: string[] = [];
    for (const c of cites as Partial<{ file: string; start: number; end: number }>[]) {
      if (typeof c?.file !== "string") return null;
      const cite = { path: cleanPath(c.file), start: Number(c.start), end: Number(c.end) };
      const lines = linesOf(cite.path);
      if (citationProblem(cite, lines)) return null;
      out.push(spanText(lines!, cite));
    }
    return out;
  };
  const cites = (raw: unknown): SeamCite[] => (raw as { file: string; start: number; end: number }[]).map((c) => ({ path: cleanPath(c.file), start: c.start, end: c.end }));
  const shows = (texts: readonly string[], part: string) => texts.some((t) => t.includes(part.toLowerCase()) || loose(t).includes(loose(part)));

  const templates = (Array.isArray(answer.templates) ? answer.templates : []).flatMap((t) => {
    const item = t as Partial<{ template: string; cites: unknown }>;
    const texts = spans(item?.cites);
    const template = typeof item?.template === "string" ? item.template.trim() : "";
    // The template's fixed words must be in its lines; placeholders are written many ways.
    const words = template.split(/[^A-Za-z0-9]+/).filter((w) => w && !/^(controller|action|id)$/i.test(w));
    return texts && template && words.every((w) => shows(texts, w)) ? [{ template, cites: cites(item.cites) }] : [];
  });

  const inherited = (Array.isArray(answer.inherited) ? answer.inherited : []).flatMap((b): InheritedRoutes[] => {
    const item = b as Partial<{ base: string; suffix: string; cites: unknown; routes: unknown[] }>;
    const base = typeof item?.base === "string" ? item.base.replace(/<.*$/, "").trim() : "";
    const texts = spans(item?.cites);
    if (!base || !/^\w+$/.test(base) || !texts || !shows(texts, base)) return [];
    const routes = (Array.isArray(item.routes) ? item.routes : []).flatMap((r) => {
      const route = r as Partial<{ method: string; path: string; cites: unknown }>;
      const method = typeof route?.method === "string" ? route.method.toUpperCase() : "";
      const path = typeof route?.path === "string" ? route.path.trim() : "";
      const lines = spans(route?.cites);
      if (!lines || !/^(GET|POST|PUT|PATCH|DELETE)$/.test(method) || !path.includes("{controller}")) return [];
      if (method !== "GET" && !shows(lines, method)) return [];
      const fixed = path.split("/").filter((s) => s && !s.startsWith("{"));
      return fixed.every((s) => shows(lines, s)) ? [{ method, path, cites: cites(route.cites) }] : [];
    });
    return routes.length ? [{ base, suffix: typeof item.suffix === "string" ? item.suffix.trim() : "", routes, cites: cites(item.cites) }] : [];
  });

  const configFiles = (Array.isArray(answer.config_files) ? answer.config_files : []).flatMap((f) => (typeof f === "string" && linesOf(cleanPath(f)) ? [cleanPath(f)] : []));
  return { templates, inherited, configFiles: [...new Set(configFiles)] };
}

/** The survey as told to each mapping run. Inherited routes are left to the brain, so runs don't list them twice. */
export function surveyText(survey: LinkSurvey): string {
  const at = (cites: readonly SeamCite[]) => cites.map((c) => `${c.path}:${c.start}`).join(", ");
  return [
    ...(survey.templates.length
      ? [
          "Convention route templates in this repository. A public action method with no route attribute of its own is still a route: the template with its placeholders filled in, {controller} by the class name without its suffix and {action} by the method name. For example `[HttpGet] public QueryResult GetList(...)` in `OrdersController`, under `api/{controller}/{action}/{id}`, is GET /api/Orders/GetList. List every one, citing the template line, the class line and the method line:",
          ...survey.templates.map((t) => `- ${t.template} (${at(t.cites)})`),
        ]
      : []),
    ...(survey.inherited.length
      ? [
          "These base classes' methods, named below, are routes of every class derived from them; those routes are added automatically, so leave out only them. Every other public action a derived class declares is its own: list it, whether it has a route attribute or is routed by convention:",
          ...survey.inherited.map((b) => `- ${b.base} (${at(b.cites)}): ${b.routes.map((r) => `${r.method} ${r.path}`).join(", ")}`),
        ]
      : []),
    ...(survey.configFiles.length
      ? [
          `Settings such as base URLs, hostnames and queue or topic names live in: ${survey.configFiles.join(", ")}. When a URL or name comes from a setting, read it there: if the value is in the repository, use it and cite the setting's line too; if not, set runtime true and give it as config:<the setting's key>.`,
        ]
      : []),
  ].join("\n");
}

/** A route a derived class gets from its base, before the usual check: cites the class, then the base's route lines. */
export interface InheritedFound {
  kind: "route";
  method: string;
  path: string;
  runtime: false;
  cites: { file: string; start: number; end: number }[];
}

const CLASS = /\bclass\s+(\w+)\b([^{\r\n]*)/;

/**
 * Every route the survey's base classes give their derived classes, in `paths` (the repo's own
 * source). A derived class is found by its declaration naming the base, repeated until no new one
 * appears, so a class deriving from a class that derives from the base counts too. An abstract
 * class, or one whose name lacks the suffix (not a controller to the framework), passes the routes
 * on but serves none itself. Each route is the base's path with `{controller}` filled in, citing
 * the derived class's line and the base's route lines.
 */
export function inheritedRoutes(survey: LinkSurvey, paths: readonly string[], linesOf: (path: string) => string[] | null): InheritedFound[] {
  if (survey.inherited.length === 0) return [];
  const declarations: { name: string; parents: string[]; path: string; line: number; abstract: boolean }[] = [];
  for (const path of paths) {
    (linesOf(path) ?? []).forEach((text, i) => {
      const match = CLASS.exec(text);
      // The names after the class's own: what it derives from or implements, and their type arguments.
      if (match) declarations.push({ name: match[1]!, parents: match[2]!.match(/\w+/g) ?? [], path, line: i + 1, abstract: /\babstract\b/.test(text.slice(0, match.index)) });
    });
  }
  // Which base each class serves the routes of, found by repeating until nothing new derives.
  const from = new Map<string, InheritedRoutes>(survey.inherited.map((b) => [b.base, b]));
  const served = new Map<string, { base: InheritedRoutes; name: string; path: string; line: number }>();
  for (let changed = true; changed; ) {
    changed = false;
    for (const d of declarations) {
      if (from.has(d.name) && served.has(`${d.path}:${d.line}`)) continue;
      const parent = d.parents.find((name) => name !== d.name && from.has(name));
      if (!parent) continue;
      const base = from.get(parent)!;
      if (!from.has(d.name)) {
        from.set(d.name, base);
        changed = true;
      }
      const isController = !base.suffix || d.name.endsWith(base.suffix);
      if (!d.abstract && isController && !served.has(`${d.path}:${d.line}`)) served.set(`${d.path}:${d.line}`, { base, name: d.name, path: d.path, line: d.line });
    }
  }
  return [...served.values()].flatMap(({ base, name, path, line }) => {
    const routeName = base.suffix && name.endsWith(base.suffix) ? name.slice(0, -base.suffix.length) : name;
    return base.routes.map((route) => ({
      kind: "route" as const,
      method: route.method,
      path: `/${route.path.replace(/^\/+/, "").replace("{controller}", routeName)}`,
      runtime: false as const,
      cites: [{ file: path, start: line, end: line }, ...route.cites.map((c) => ({ file: c.path, start: c.start, end: c.end }))],
    }));
  });
}
