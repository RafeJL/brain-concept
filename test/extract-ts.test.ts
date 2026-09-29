import { describe, expect, it } from "vitest";
import type { SeamDraft } from "../src/core/seams.js";
import { tsCalls } from "../src/ingest/extractors/ts-calls.js";
import { tsRoutes } from "../src/ingest/extractors/ts-routes.js";
import type { ExtractorPlugin } from "../src/ingest/extractors/plugin.js";
import { grammarFor, parse } from "../src/ingest/parse.js";

async function run(plugin: ExtractorPlugin, source: string, path = "src/file.ts"): Promise<SeamDraft[]> {
  const tree = await parse(grammarFor(path)!, source);
  try {
    return plugin.extract({ path, source, tree });
  } finally {
    tree?.delete();
  }
}

const brief = (seams: SeamDraft[]) => seams.map((s) => `${s.method} ${s.key}`);

describe("ts-routes", () => {
  it("finds Express routes with middleware and inline handlers, with line numbers", async () => {
    const seams = await run(
      tsRoutes,
      [
        "router.get('/articles', auth.optional, async (req, res) => {});",
        "router.post(",
        "  '/articles/:slug/comments',",
        "  auth.required,",
        "  handler,",
        ");",
        "app.delete('/users/:id', (req, res) => res.end());",
      ].join("\n"),
    );

    expect(brief(seams)).toEqual(["GET /articles", "POST /articles/{}/comments", "DELETE /users/{}"]);
    expect(seams[1]).toMatchObject({ startLine: 2, endLine: 6, rawPath: "/articles/:slug/comments" });
  });

  it("finds route chains and Fastify route objects", async () => {
    const seams = await run(
      tsRoutes,
      "router.route('/books/:id').get(getBook).put(updateBook);\nfastify.route({ method: ['GET', 'HEAD'], url: '/health', handler });",
    );

    expect(brief(seams).sort()).toEqual(["GET /books/{}", "GET /health", "HEAD /health", "PUT /books/{}"]);
  });

  it("combines NestJS controller and method decorators", async () => {
    const seams = await run(
      tsRoutes,
      "@Controller('cats')\nexport class CatsController {\n  @Get(':id')\n  findOne() {}\n\n  @Post()\n  create() {}\n}",
    );

    expect(brief(seams)).toEqual(["GET /cats/{}", "POST /cats"]);
    expect(seams[0]).toMatchObject({ startLine: 4 });
  });

  it("does not mistake client calls or map lookups for routes", async () => {
    const seams = await run(
      tsRoutes,
      "axios.post('/articles', data);\napi.get('/x', config);\nsettings.get('title');\ncache.get('/key', fallback);",
    );

    expect(seams).toEqual([]);
  });
});

describe("ts-calls", () => {
  it("resolves literal, template and concatenated URLs, dropping a base URL", async () => {
    const seams = await run(
      tsCalls,
      [
        "const API = 'https://api.example.com/v1';",
        "requests.get('/user');",
        "requests.del(`/articles/${slug}/comments/${id}`);",
        "axios.post(API + '/orders/' + id, body);",
        "fetch(`${API_ROOT}/tags?limit=${n}`);",
        "fetch('/login', { method: 'POST' });",
        "this.http.put(`/profiles/${name}`, body);",
        "axios({ url: '/items', method: 'patch' });",
      ].join("\n"),
    );

    expect(brief(seams)).toEqual([
      "GET /user",
      "DELETE /articles/{}/comments/{}",
      "POST /v1/orders/{}",
      "GET /tags",
      "POST /login",
      "PUT /profiles/{}",
      "PATCH /items",
    ]);
  });

  it("records clients with run-time URLs as unresolved, and ignores unknown receivers", async () => {
    const seams = await run(tsCalls, "superagent.get(`${API_ROOT}${url}`);\nfetch(url);\nstore.get(key);\nmap.get('user');");

    expect(seams.map((s) => [s.method, s.key, s.rawPath])).toEqual([
      ["GET", null, "`${API_ROOT}${url}`"],
      ["GET", null, "url"],
    ]);
  });

  it("does not count route registrations as calls", async () => {
    const seams = await run(tsCalls, "router.get('/articles', auth, handler);\nrouter.route('/b').get(h);");

    expect(seams).toEqual([]);
  });

  it("parses plain JavaScript and JSX", async () => {
    const seams = await run(tsCalls, "export const A = () => <b onClick={() => fetch('/ping')} />;", "src/a.jsx");

    expect(brief(seams)).toEqual(["GET /ping"]);
  });
});
