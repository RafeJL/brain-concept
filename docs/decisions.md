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

## 2026-09-29: a trailing run-time path makes the URL run-time

`API + url`, `` `${API}${path}` `` and `$"{Base}/{relativePath}"` used to produce made-up keys
like `/api/{}`. A run-time value at the end of a URL now makes the whole URL "run-time" when it
is glued to text with no separator, or when its name says it holds a URL or path (`url`, `uri`,
`path`, `endpoint`, `route`, `resource`, `href`, `address`), unless it sits in the query
string. `"/orders/" + id` is still an ordinary parameter. TS template substitutions now resolve
same-file constants, as concatenation and C# interpolation already did.

## 2026-09-29: run-time URL notes lead with the repos in the answer

The note still counts every searched repo (any could hold a hidden caller), but files in repos
the answer is about are listed first, so an unrelated repo's run-time URLs don't hide the
wrapper that matters.

## 2026-09-29: repos track origin's default branch by default

The brain describes what has been merged. Tracking the local `main` meant a branch you never
check out never moved, and the index went stale while reporting "up to date", because freshness
was measured against the same stale branch. New enrolments track what `origin/HEAD` points at
(usually `origin/main`), so a fetch brings merges in and "N commits behind" stays honest.
Without a remote, the checked-out branch is used as before. `brain repo set-ref` moves repos
enrolled earlier.

## 2026-09-29: freshness through a git reference-transaction hook

`brain hooks install` adds a `reference-transaction` hook that starts a background
`brain sync <name>` when the tracked ref moves. That catches fetches, which have no hook of
their own, as well as pulls, merges and rebases. The hook returns at once and logs to
`~/.brain/hooks.log`. It is never added to an existing `reference-transaction` hook (the two
would have to share stdin) or to a `core.hooksPath` inside the repo (husky), because that would
change tracked files. SQLite waits up to 10s for a lock, so overlapping syncs queue rather than
fail. Hosted, a GitHub webhook replaces the hook; the sync is the same.

## 2026-09-30: repo cards read what a repo declares, and never run it

*Superseded on 2026-10-05: the wiki's pages replaced the fact readers.*

Build and test commands come from `package.json` scripts (the package manager from the nearest
lockfile) and .NET solutions and projects. Owners come from CODEOWNERS, found the way GitHub
finds it. "About" is the README's first real paragraph. All of it is parser-built and cited to
file and line, and the brain never runs a command to check it works. Curated purposes (phase 4)
will sit alongside these as human-reviewed facts rather than replace them.

## 2026-09-30: facts go through the same pipeline as seams

*Superseded on 2026-10-05: the fact readers and the `facts` table were removed.*

Readers in `src/ingest/facts/` are pure, one file at a time, like extractor plugins. Their facts
go in a `facts` table that cascades from `files`, so only changed blobs are re-read, each fact
names its commit, and a deleted file takes its facts with it. `EXTRACTOR_VERSION` 4 fills them in
for repos indexed earlier. Lockfiles are recognised by name and never read, because they can be
many megabytes.

## 2026-09-30: neighbours are worked out when asked, not stored

"Calls" and "called by" on a repo card come from the seam graph on each request, among the repos
the caller can read, because they change whenever any other repo syncs. `brain_impact` and the
card share one matching function (`linkCalls`).

## 2026-09-30: a key with no literal segment only links within its own repo

`/` and `/{}` don't say which service is meant; every web app serves `/`. Across repos they now
link nothing. Found as express-api's e2e test (`GET /` against its own server) making it look like
a caller of eShop. `brain_find_consumers` still answers an explicit question about `/`.

## 2026-10-05: the wiki is AI-first; deterministic checks verify it

Add a repo, get a wiki, in any language, the way DeepWiki and Google Code Wiki work. Claude Code
reads the code and writes pages in which every sentence cites `[path:lines]`. Teaching the brain
each framework in TypeScript didn't scale to Citation's 20+ languages. AI wikis are known to be
confidently wrong, so the defences are:
- citations on every claim, checked automatically from W2;
- `llm-generated` labels;
- keeping the last good page;
- isolated, read-only runs.

The W0 trial found every RealWorld endpoint in C#, TypeScript, JavaScript, PHP and Python, with
no invented ones, and wrote accurate cited pages. This supersedes "parser-built before LLM-built"
as the ordering. The parser extractors stay only as the answer key until AI-found seams replace
them (W4).

## 2026-10-05: Claude Code headless is the AI engine

Runs are `claude -p --output-format json --json-schema …` with:
- `--safe-mode --strict-mcp-config`: no user settings, memory, hooks or MCP servers, so a run
  can't call the brain or anything else;
- `--allowedTools Read,Grep,Glob` and `--permission-mode dontAsk`;
- a model per task, defaulting to Sonnet. W0 found it as good as Opus at a quarter of the cost.

Locally it uses the developer's Claude Code login. The same command runs in cloud containers
later. Each run happens in a temporary git worktree at the indexed commit, so pages describe
exactly what every other fact describes (repo @ commit), never uncommitted work.

## 2026-10-05: clean up as we go

Each change deletes the code, tests, fixtures and docs it replaces, and updates the README, the
manual-testing guide and the vault in the same PR. Old code is deleted only once its replacement
is shown to work: W1 removed the fact readers after real wikis for C#, PHP and Python, and a
fresh Claude Code session answering from them. Manual-test scaffolding stays out of the repo.

## 2026-10-05: every wiki citation is checked before an agent sees it

`src/wiki/check.ts` runs on each page in the same worktree, so it reads exactly the commit the
page describes. It uses no AI. Each sentence, list item and table row is a claim. A claim is kept
only if:
- it cites lines that exist;
- no citation spans more than 80 lines;
- every name it puts in backticks appears in the cited lines.

Matching is by the name's most specific word: dashes and underscores count as the same, and a
name also counts when it is a cited file or a file next to one. A route's HTTP method must appear
too. Exact text was too strict, because the AI paraphrases and code is namespaced. Failing claims
are removed. A page where fewer than half pass isn't published, and its previous version stays.

On the trial wikis about 80% of claims were kept, and every removal read was a real problem:
- a name cited to a file that doesn't contain it;
- an inference the code doesn't state;
- invented example values;
- 150-line spans.

The checker can't tell whether a claim reads its lines correctly, so pages stay `llm-generated`.
The rules change only on evidence from real pages, with the case added to the tests.

## 2026-10-06: the wiki updates itself, one affected page at a time

The git hook now runs `brain sync <repo> --wiki`: sync, then update the wiki if the repo has one.
A page is rewritten only if a file it cites changed or was deleted, or a file was added in a
folder it cites. Every other page is re-checked against the new commit, with no AI, and moved to
it. On flask-api a one-line `Procfile` change rewrote one page for $0.22 instead of four for
about $0.70; later small changes cost $0.05.

A page that fails the check is written once more, with the removed claims and reasons in the
prompt, because output varies between runs (W2 saw a laravel run fail and its rerun pass). If it
fails again, the previous version stays and `brain_get` says it was kept from an older commit.
That is derived from the page's commit, so there's no stale flag to keep in step.

One run per repo at a time, across processes: a lock file next to the store. A trigger that
arrives mid-run leaves a marker, and the running process goes round once more, so the newest
commit is always covered without stacking runs. A lock whose process died is taken over.

Not built, for lack of evidence it's needed: re-planning the page set when a repo's structure
changes (`brain wiki --full` does it by hand), and a separate `--status` command (the page list
marks any page kept from an older commit).

## 2026-10-06: a resource declaration implies its CRUD routes

`Route::resource`, `Route::apiResource` and Rails `resources :x` serve GET, POST, PUT, PATCH and
DELETE routes, and the index, store, show, update and destroy actions, without naming them. When
the cited lines contain one, the checker accepts those methods and actions. The method rule also
covers routes written without a leading slash (`GET articles`) and bare methods (`PUT`). On
laravel-api, `GET articles/{article}` and the other resource routes now survive. Claims that cite
only the handler still lose the method check, so the prompt now asks for the route's declaring
line as well as its handler.

## 2026-10-06: prompts are Markdown files, not skills

The AI's instructions live in `src/wiki/prompts/*.md` and are passed straight to `claude -p`.
They aren't skills: a skill is something an agent may choose to load, but here the prompt is the
task. Runs load no skills or settings (`--safe-mode`), so a repo being documented can't inject
its own. The prompts describe what the checker enforces, so they're versioned and reviewed with
the code.
