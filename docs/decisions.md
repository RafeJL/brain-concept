# Decisions

Newest last. Each entry: what was decided, why, and what would change it.

## 2026-09-29: the brain is a separate system

The brain lives in its own repo and runs as its own service. The harness keeps all its skills and
only calls the brain over MCP. `setup-repo` and `add-product` stay in the harness; at most they
gain an optional call to the brain.

## 2026-09-29: MCP is the only agent interface; agents first, UI later

MCP works in Claude Code and Codex and gives one place for auth, token limits and logging. A
human deep-wiki UI can sit on the same store later.

## 2026-09-29: per-repo permissions following GitHub

A caller only sees facts from repos they can read. Locally every enrolled repo is readable;
hosted, the caller's GitHub identity is checked per request. Filtering lives in the query layer.

## 2026-09-29: TypeScript on Node

Matches the harness's evals tooling, has a first-class MCP SDK, and has WASM tree-sitter so
there are no native builds on Windows.

## 2026-09-29: v1 scope

Seam graph, symbol maps, repo cards, curated product context and deep wiki pages. Wiki pages are
advisory and citation-checked. Jira/Confluence are not ingested (Rovo MCP covers them).

## 2026-09-29: facts are tagged repo @ commit, read from the committed tree

Sync reads `git ls-tree` at the tracked ref, not the working copy, so every fact names the exact
commit it describes and staleness is "commits behind the ref".

## 2026-09-29: SQLite via `node:sqlite` for the POC

No native build step. Behind a `Store` interface so Postgres can replace it when hosted.

## 2026-09-29: TypeScript 6, tools run through node

Group policy on Citation laptops blocks native executables and `.cmd` shims under
`node_modules`. TypeScript 7 is a native binary, so we use TypeScript 6. npm scripts call `tsc`
and `vitest` via `node`, and `bin/` launchers load tsx relative to themselves so the CLI and the
MCP server run from any folder. Revisit if the policy changes or when we build to JavaScript for hosting.

## 2026-09-29: phase 1 stacks are OpenAPI, TS/JS and C#/ASP.NET

OpenAPI/AsyncAPI specs cover the serving side of any backend that publishes one. TS/JS covers
both sides (most frontends are the callers). C#/ASP.NET is the backend stack. Other stacks are
added when an enrolled repo needs them, and repo cards list code languages with no extractor.

## 2026-09-29: tree-sitter through `@vscode/tree-sitter-wasm`

One package with the WASM runtime and grammars for TS, TSX, JS, C#, Java, Python, PHP and Go,
built and versioned together by the VS Code team. WASM avoids native builds and group policy.

## 2026-09-29: endpoints match exactly or by suffix at a segment boundary

Mount prefixes (`app.use('/api', router)`) and client base URLs are often configured at run time,
so `/api/articles/{}` must be able to find `/articles/{}`. Suffix matches are labelled in every
answer. Parameters never match literals (`/articles/feed` is not `/articles/{}`), and a key made
only of parameters never suffix-matches, so `/{}` can't match everything.

## 2026-09-29: unresolved calls are counted, never guessed

A call to a known HTTP client whose URL is only known at run time is stored with no key. It never
matches anything, but answers say how many exist so "no callers found" is not read as proof.
Calls on receivers that don't look like HTTP clients are skipped rather than recorded.

## 2026-09-29: extractor version forces a full re-extract

`EXTRACTOR_VERSION` is stored per repo. When a plugin changes, bump it; each repo is fully
re-extracted on its next sync instead of mixing old and new rules. This is also how phase 0
databases gain seams.

## 2026-09-29: numeric and GUID segments are parameters

`/items/1` is served by `/items/{id}`, and callers (tests especially) often use literal ids. So
purely numeric and GUID segments normalise to `{}`. Word segments stay literal, so
`/articles/feed` still never matches `/articles/{slug}`.

## 2026-09-29: conventionally routed C# controllers are skipped

`[HttpGet]` with no template on the action or the class is a verb constraint on a route table
defined elsewhere (`MapControllerRoute`). The path isn't in the file, so no route is emitted.
Found as false `GET /` routes in eShop's Identity `AccountController`.

## 2026-09-29: one entry per endpoint in answers

When a repo declares the same method and path in code and in OpenAPI specs, answers show one
entry citing the code, with the specs listed as "also declared in". The store keeps every
declaration; only the answers are merged, so callers aren't repeated per spec file.

## 2026-09-29: ambiguous C# method names need a client-like receiver

`GetAsync`/`PostAsync`/... also exist on caches and repositories. They count as HTTP only when
the receiver's name contains "client" or "http", or the URL contains a "/". HttpClient-only
extensions (`GetFromJsonAsync`, `PostAsJsonAsync`, ...) always count.

## 2026-09-29: extractor tests are annotated fixture files

Test inputs are real source files in their own language (`test/fixtures/extractors/`), with the
expected seam written as a comment on its line, the convention Semgrep and tree-sitter use for
their own tests. One runner pushes every fixture through the production `extractSource` with all
plugins that want the file, and requires an exact match, so each fixture checks both what must be
found and what must not. C#, TypeScript and YAML samples are no longer written inside TypeScript
strings. Integration tests build their repos from `test/fixtures/repos/`.

## 2026-09-29: TS/JS calls need a client-named receiver

Running both TS plugins over whole fixture files showed `cache.get("/key", fallback)` counted as
an HTTP call. Member calls now count only when the receiver is named like a client (`api`,
`http`, `requests`, `axios`, `*Client`, `*Api`, ...). `fetch` and `axios(...)` always count.
Seam counts on the RealWorld repos and eShop were unchanged.
