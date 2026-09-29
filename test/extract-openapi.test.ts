import { describe, expect, it } from "vitest";
import { openapi } from "../src/ingest/extractors/openapi.js";

const extract = (source: string) => openapi.extract({ path: "api/openapi.yaml", source, tree: null });

describe("openapi", () => {
  it("reads OpenAPI 3 paths and methods under the server's base path, with lines", () => {
    const seams = extract(
      [
        "openapi: 3.0.1",
        "servers:",
        "  - url: https://api.example.com/api",
        "paths:",
        "  /articles/{slug}:",
        "    parameters: []",
        "    get:",
        "      summary: Get an article",
        "    delete:",
        "      summary: Delete it",
        "  /tags:",
        "    get: {}",
      ].join("\n"),
    );

    expect(seams.map((s) => `${s.method} ${s.key} ${s.startLine}`)).toEqual([
      "GET /api/articles/{} 7",
      "DELETE /api/articles/{} 9",
      "GET /api/tags 12",
    ]);
    expect(seams[0]).toMatchObject({ kind: "http-route", rawPath: "/api/articles/{slug}", plugin: "openapi" });
  });

  it("reads Swagger 2 JSON with basePath", () => {
    const seams = extract(JSON.stringify({ swagger: "2.0", basePath: "/v2", paths: { "/pets/{id}": { get: {}, put: {} } } }));

    expect(seams.map((s) => `${s.method} ${s.key}`)).toEqual(["GET /v2/pets/{}", "PUT /v2/pets/{}"]);
  });

  it("ignores YAML that is not a spec, and skips package manifests entirely", () => {
    expect(extract("name: ci\non: push\npaths:\n  /x:\n    get: {}")).toEqual([]);
    expect(openapi.wants("package.json")).toBe(false);
    expect(openapi.wants("docs/openapi.json")).toBe(true);
  });
});
