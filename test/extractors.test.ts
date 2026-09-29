import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { SeamDraft } from "../src/core/seams.js";
import { extractSource } from "../src/ingest/extract.js";
import { openapi } from "../src/ingest/extractors/openapi.js";

/**
 * Every file under test/fixtures/extractors is real source in its own language. Expected seams
 * are written on the line they start at:
 *
 *     [HttpGet("{id}")] // seam: route GET /api/orders/{}
 *
 * Several on one line are separated by ";". A call whose URL is only known at run time is
 * `call GET <run-time>`. Files that can't hold comments (JSON) keep their expectations in a
 * `<file>.seams` file beside them. A fixture with no expectations must produce no seams.
 *
 * Each fixture runs through the same `extractSource` a sync uses, with every plugin that wants
 * the file, and must match its annotations exactly: nothing missed, nothing extra.
 */
const ROOT = fileURLToPath(new URL("./fixtures/extractors/", import.meta.url));
const ANNOTATION = /(?:\/\/|#)\s*seam:\s*(.+?)\s*$/;

function fixtures(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return fixtures(path);
    return entry.name.endsWith(".seams") ? [] : [path];
  });
}

function expected(file: string, source: string): string[] {
  const sidecar = `${file}.seams`;
  if (existsSync(sidecar)) {
    return readFileSync(sidecar, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));
  }
  return source.split(/\r?\n/).flatMap((line, index) => {
    const match = ANNOTATION.exec(line);
    return match ? match[1]!.split(";").map((seam) => `${index + 1}: ${seam.trim()}`) : [];
  });
}

function describeSeam(seam: SeamDraft): string {
  const kind = seam.kind === "http-route" ? "route" : "call";
  return `${seam.startLine}: ${kind} ${seam.method} ${seam.key ?? "<run-time>"}`;
}

const files = fixtures(ROOT);

describe("extractor fixtures", () => {
  it("has fixtures to run", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    const path = relative(ROOT, file).replace(/\\/g, "/");
    it(path, async () => {
      const source = readFileSync(file, "utf8");

      const seams = await extractSource(path, source);

      expect(seams.map(describeSeam).sort()).toEqual(expected(file, source).sort());
    });
  }
});

describe("citations", () => {
  it("cite the whole statement and keep the path as written", async () => {
    const file = join(ROOT, "typescript", "express-routes.ts");
    const [, multiLine] = await extractSource("typescript/express-routes.ts", readFileSync(file, "utf8"));

    expect(multiLine).toMatchObject({ startLine: 7, endLine: 11, rawPath: "/articles/:slug/comments", plugin: "ts-routes" });
  });

  it("cite a C# action from its first attribute to the end of the method", async () => {
    const file = join(ROOT, "csharp", "ControllerRoutes.cs");
    const [, get] = await extractSource("csharp/ControllerRoutes.cs", readFileSync(file, "utf8"));

    expect(get).toMatchObject({ startLine: 13, endLine: 14, rawPath: "/api/orders/{id:int}", plugin: "cs-routes" });
  });
});

describe("file selection", () => {
  it("never reads package manifests as specs", () => {
    expect(openapi.wants("package.json")).toBe(false);
    expect(openapi.wants("package-lock.json")).toBe(false);
    expect(openapi.wants("docs/openapi.json")).toBe(true);
  });
});
