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

*Superseded on 2026-10-06: Claude Code finds routes and calls; the parsers were removed.*

OpenAPI/AsyncAPI specs cover the serving side of any backend that publishes one. TS/JS covers
both sides (most frontends are the callers). C#/ASP.NET is the backend stack. Other stacks are
added when an enrolled repo needs them, and repo cards list code languages with no extractor.

## 2026-09-29: tree-sitter through `@vscode/tree-sitter-wasm`

*Superseded on 2026-10-06: Claude Code finds routes and calls; the parsers were removed.*

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

*Superseded on 2026-10-06: Claude Code finds routes and calls; the parsers were removed.*

`EXTRACTOR_VERSION` is stored per repo. When a plugin changes, bump it; each repo is fully
re-extracted on its next sync instead of mixing old and new rules. This is also how phase 0
databases gain seams.

## 2026-09-29: numeric and GUID segments are parameters

`/items/1` is served by `/items/{id}`, and callers (tests especially) often use literal ids. So
purely numeric and GUID segments normalise to `{}`. Word segments stay literal, so
`/articles/feed` still never matches `/articles/{slug}`.

## 2026-09-29: conventionally routed C# controllers are skipped

*Superseded on 2026-10-06: Claude Code finds routes and calls; the parsers were removed.*

`[HttpGet]` with no template on the action or the class is a verb constraint on a route table
defined elsewhere (`MapControllerRoute`). The path isn't in the file, so no route is emitted.
Found as false `GET /` routes in eShop's Identity `AccountController`.

## 2026-09-29: one entry per endpoint in answers

When a repo declares the same method and path in code and in OpenAPI specs, answers show one
entry citing the code, with the specs listed as "also declared in". The store keeps every
declaration; only the answers are merged, so callers aren't repeated per spec file.

## 2026-09-29: ambiguous C# method names need a client-like receiver

*Superseded on 2026-10-06: Claude Code finds routes and calls; the parsers were removed.*

`GetAsync`/`PostAsync`/... also exist on caches and repositories. They count as HTTP only when
the receiver's name contains "client" or "http", or the URL contains a "/". HttpClient-only
extensions (`GetFromJsonAsync`, `PostAsJsonAsync`, ...) always count.

## 2026-09-29: extractor tests are annotated fixture files

*Superseded on 2026-10-06: Claude Code finds routes and calls; the parsers were removed.*

Test inputs are real source files in their own language (`test/fixtures/extractors/`), with the
expected seam written as a comment on its line, the convention Semgrep and tree-sitter use for
their own tests. One runner pushes every fixture through the production `extractSource` with all
plugins that want the file, and requires an exact match, so each fixture checks both what must be
found and what must not. C#, TypeScript and YAML samples are no longer written inside TypeScript
strings. Integration tests build their repos from `test/fixtures/repos/`.

## 2026-09-29: TS/JS calls need a client-named receiver

*Superseded on 2026-10-06: Claude Code finds routes and calls; the parsers were removed.*

Running both TS plugins over whole fixture files showed `cache.get("/key", fallback)` counted as
an HTTP call. Member calls now count only when the receiver is named like a client (`api`,
`http`, `requests`, `axios`, `*Client`, `*Api`, ...). `fetch` and `axios(...)` always count.
Seam counts on the RealWorld repos and eShop were unchanged.

## 2026-09-29: a trailing run-time path makes the URL run-time

*Superseded on 2026-10-06: Claude Code finds routes and calls; the parsers were removed.*

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

`src/ai/check.ts` runs on each page in the same worktree, so it reads exactly the commit the
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

The AI's instructions live in `src/ai/prompts/*.md` and are passed straight to `claude -p`.
They aren't skills: a skill is something an agent may choose to load, but here the prompt is the
task. Runs load no skills or settings (`--safe-mode`), so a repo being documented can't inject
its own. The prompts describe what the checker enforces, so they're versioned and reviewed with
the code.

## 2026-10-06: routes and calls come from Claude Code; the parsers are removed

Supersedes the 2026-09-29 entries on phase 1 stacks, tree-sitter, the extractor version,
extractor fixtures, client-named receivers (TS/JS and C#), conventionally routed controllers and
trailing run-time paths. Endpoint matching, run-time URLs and one-entry-per-endpoint stand.

One Claude Code run per repo lists every route served and HTTP call made, with the lines that
declare each and the lines its path is built from. Each is verified with no AI before it is
stored: the cited files and lines exist (80-line cap, as for wiki claims), the method appears in
them unless it's GET (a resource declaration implies its CRUD methods; `del(` is DELETE), and
every fixed segment of the path appears in them. That last rule is what proves a prefix three
files away. Failures are dropped and reported.

**The deletion gate** (agreed 2026-10-05: match the parser on every test repo). Measured against
the parsers' stored seams:

| Repo | Parser | Claude Code | Missed | Dropped | Cost |
|---|---|---|---|---|---|
| aspnet-api (C#) | 19 routes | 20 routes, 1 call | 0 | 0 | $0.90 |
| express-api (TS) | 20 routes, 1 call | 20 routes, 1 call | 0 | 0 | $0.49 |
| react-web (JS) | 22 calls, 4 run-time | 22 calls | 0 | 0 | $0.09 |
| eshop (C#, large) | 56 routes, 54 calls, 20 run-time | 77 routes, 57 calls, 2 run-time | 1 duplicate test call | 0 | $3.68 |
| laravel-api (PHP) | none | 22 routes, 78 calls | n/a: all 19 RealWorld endpoints | 0 | $0.22 |
| flask-api (Python) | none | 19 routes, 14 calls | n/a: all 19 RealWorld endpoints | 0 | $0.17 |

- **Every extra was real:** aspnet's Swagger endpoint and a `curl` in its Makefile; eshop's
  health checks, Identity MVC routes and Blazor pages.
- **eshop's one miss:** a v1 call on the line beside a v2 call in one test. Its endpoint is still
  linked from another test.
- **Fewer run-time calls:** the AI resolves wrappers and base URLs. react-web's four "run-time"
  calls were the superagent wrapper itself.
- **Two fixes came from the first run:** `del(` for DELETE (react-web's three DELETEs were
  dropped), and the prompt rule that a variable segment is a parameter, not run-time (Laravel's
  tests went from 13 run-time calls to 0).

**Two matching rules came from real output:**
- A call its own repo serves (its tests, its own front end) links only within that repo. Every
  RealWorld backend serves the same paths, so without this rule Laravel's tests "called" aspnet.
  `consumers` lists such calls last, marked `same repo`.
- A call's location is the cited line, within the file the AI cited first, that holds its path's
  last fixed segment. react-web's calls then point at their call sites rather than the shared
  superagent wrapper the AI sometimes cited first. It stays within that file because a Flask
  test calling `url_for(...)` cites the route it names, and the route isn't where the call is.

**Every repo gets AI seams and a wiki automatically** (Rafe chose this over "only repos with a
wiki", which would have silently lost links to repos like react-web). `brain sync` indexes, then
updates both; `--no-ai` indexes only. After the first full map, an update maps only changed files
plus files whose seams cite a changed file (a moved prefix). Markdown, CSS and files of unknown
type cost no run. The cost per change is cents; a large repo's first map is a few dollars.

Removed: `src/ingest/extractors/`, `parse.ts`, `extract.ts`, the tree-sitter dependency, the
extractor fixtures and tests, `EXTRACTOR_VERSION` (migration 7 drops its column and the parser
seams), the `parser-built` tier and the card's "not extracted" note. Tests now use recorded AI
answers per fixture repo (`test/fixtures/seams/`), with real verification.

## 2026-10-06: dropped seams get a second pass; table headers aren't claims

The first full sync of the real store dropped 12 real eshop calls: `CatalogService.cs` builds
them from `remoteServiceBaseUrl = "api/catalog/"` on line 9, and that run cited only the call
lines, so nothing showed the `api` segment. The gate run and a later scoped run both cited line 9,
so this is variation between runs. As with wiki pages, entries the check drops are now asked for
once more, with each reason, before being given up. It costs nothing when nothing is dropped.

The same sync showed the citation checker removing table header rows (`| Command | Script |`) as
uncited claims, which left tables without headers. The row above a `|---|` line is a header and
is no longer checked.

## 2026-10-07: search is keywords over wiki sections and endpoints

`brain_search` ranks wiki sections and endpoints across every repo the caller can read. It uses
SQLite's FTS5 with Porter stemming ("tests" finds "testing") and bm25 ranking. There are no
embeddings (architecture: "not in v1" unless evals show a gain): the pages are AI-written prose that names the code's own terms,
and every gate question below found a sensible section without them. Revisit if agents miss
answers because the wording differs from the wiki's.

- **Sections, not pages.** Pages are split at `##`/`###` headings, so a hit says where to read.
  Citations are taken out of the text (snippets stay readable). The files a section cites are
  searched separately, with camelCase written apart ("orders controller" finds
  `OrdersController.cs`).
- **Endpoints match on method and path only.** Matching their file paths made every `tests/`
  call match "tests".
- **Words are OR'd, without prefixes.** Stemming covers word forms. Prefix matching made "run"
  find "runtime" and "calls" find `/External/Callback`.
- **Headings weigh most** (repo 1, page title 1, heading 4, body 1, cited files 1). Weighting the
  page title ×5 ranked the shortest section of every "Build, run and test" page first for any
  build question.
- **The index can't drift.** Rows are added where pages and seams are written, and removed by
  triggers, so a deleted file or removed repo takes its rows with it. Migration 8 indexes what is
  already stored, so nobody re-syncs. Migrations can now be code as well as SQL, because sections
  are split in code.
- **Permissions:** rows are filtered to the caller's repos inside the query, like every other
  tool.

**Gate**, on the real store (7 repos): for each of 10 questions, a sensible section in the top 3.

| Question | Top result |
|---|---|
| how do I run the tests | citation-harness-library · build-run-test › Test |
| jwt authentication | react-web · redux-data-flow › localStorageMiddleware |
| basket checkout | eshop · api › Basket (`Basket.API`, gRPC) |
| who calls articles | flask-api · api › Articles |
| database migrations | express-api · build-run-test › Prisma setup |
| skill evaluation cost | citation-harness-library · api › Skill slash-command surface |
| where are orders cancelled | eshop · api › Ordering; endpoint `PUT /api/orders/cancel` |
| redux store setup | react-web · redux-data-flow › localStorageMiddleware |
| favorite an article | aspnet-api · api › Favorites |
| event bus integration events | eshop · ordering-api › Transactional outbox for integration events |

## 2026-10-07: easy to trial locally; parser-era leftovers removed

Colleagues should be able to go from clone to asking Claude about their own repo in about ten
minutes. A fresh-clone walkthrough found:
- the quick start sat about 250 lines into the README;
- a missing git gave "Ref main does not resolve";
- a missing Claude Code showed up only when a sync failed;
- registering the MCP server meant typing your own path.

**What changed:**
- **`brain doctor`** checks Node, git, Claude Code, the store, the MCP registration (that it
  runs *this* checkout and connects) and each repo's hook. Every failure comes with its fix. The
  fix for an unregistered server is the exact `claude mcp add` command for this machine.
- **`brain add <path>`** enrols, syncs and installs the hook in one step. Before the AI runs it
  prints a rough cost and time from the repo's file count, measured on the trial repos.
- **`brain wiki` is gone.** `brain sync` does everything, so there is one command to learn. The
  `--wiki` flag old hooks passed is gone too: `brain doctor` flags those hooks as written by an
  older brain, and `brain hooks install` refreshes them.
- **The README is for trialists;** developer material moved to `docs/development.md`.
- **Removed leftovers:**
  - the `yaml` dependency;
  - three unused functions (`readBlobs`, `CODE_LANGUAGES`, `joinPaths`);
  - the `seams.plugin` column (migration 9);
  - a `.gitignore` rule (and a test-helper skip) for .NET build output: no .NET projects remain in
    the fixtures, and the rule also hid new files in the real `bin/`;
  - the `del`, `all` and `any` verb aliases, which only the Express and Laravel parsers needed.
- **Merged duplicates:** `SeamCite` and `Citation` are one type, there is one `cleanPath`, and
  the `llm-generated` label is a constant ready for `human-reviewed`.

## 2026-10-08: the product layer (B2a): product pages, systems, impact from a description

A PO's agent should answer what a product does, who uses it, its business rules and which
systems a piece of work touches, without reading code.

- **A fifth wiki page, `product`,** written for a PO or a new joiner: who uses it, what they can
  do, business rules, terms, what it depends on (named as products) and what it doesn't do. Its
  text names no code; code names appear only in citations, which point at where each rule is
  enforced. It goes through the same citation check as every page; no new check was added, since
  product sentences rarely use backticks and the check still confirms each citation exists and is
  narrow.
- **Existing wikis gain it on their next sync** in a run of its own: an update writes any page
  listed in `prompts/pages.md` that the wiki lacks, leaving the others alone. This also refills a
  fixed page (overview, build-run-test, api) that failed in a wiki's first run.
- **The card opens with the page's first sentence** (`Product: …`) and names the repo's system.
- **Systems: suggested by AI, confirmed by a person, assembled on request.** `brain systems
  suggest` gives Claude Code a small file (card facts, the opening of each product page, links;
  no code), so it costs cents. A suggestion is kept only if its repos exist and aren't in a
  confirmed system, none appears twice and its name is free. In a system of several repos, each
  must call or be called by another member in the route map: one that isn't is left out (looking
  alike proves nothing), and a system left with fewer than two is dropped. The AI's own reason is
  shown, but nothing rests on it. A person confirms, sets, renames or removes systems; setting a
  suggested system's repos or summary confirms it, since a person has now decided it. Agents see unconfirmed ones labelled
  "suggested", so a fresh install is useful before anyone confirms. Overviews (`brain_get` with
  `system`) are built when asked from the summary, product pages and seams, and never stored.
  System names and summaries have their own FTS5 index (migration 10), kept by triggers.
- **`brain_impact` takes `work`,** a description of a piece of work, instead of adding a sixth
  tool. It searches wiki sections (product sections ×2) and routes, ranks repos by their best five
  sections plus 0.5 per matching route (up to 10), scales that by the square of the share of the
  description's words the repo matches at all, groups by system, and adds the repos calling the
  matching routes. Repos under half the best score are named as weaker matches. No AI at query
  time.

**Why the word-share scaling:** without it, the harness's long product page matched one common
word ("codes", "add") in many sections and came second for "add discount codes to the basket"
(20.9 against eshop's 24). Scaled, it falls to 5.2 and shows only as a weaker match.

**Gate** (snapshot of the real store; product pages written for aspnet-api, react-web and the
harness, $3.93 including an update of three harness pages the branch had moved past; the other
four repos were left for budget):
- Product pages: 35/35, 25/25 and 65/68 claims kept; the three removals were uncited bold
  lead-ins. No backticks or code names in the text. Spot-checked rules match their citations
  (unique username and email, author-only delete, 20 results per page).
- `systems suggest` ($0.08–0.20): RealWorld (four APIs and react-web), eShop alone, the harness
  alone. The first version checked "evidence" items the AI wrote, and a page existing counted as
  support, which every repo passes; review replaced it with the link check above, computed from
  the seam graph rather than taken from the AI. RealWorld passes it: react-web calls all four APIs.
- `impact --work`: "save articles to read later" and "let users delete their account" give
  aspnet-api and react-web (the other APIs, with no product page yet, as weaker matches);
  "add discount codes to the basket" and "notify buyers when an order ships" give eshop (Basket;
  Ordering with `PUT /api/orders/ship`); "add a cost report to skill evals" gives the harness.

**Found on Rafe's first real sync** (all 7 repos, about $6.7): six product pages passed (23/23 to
54/54 claims kept). eShop's failed twice, 12 of 34 claims kept, nearly all removed as "no
citation" although the removed text visibly had brackets. The failed draft isn't stored, so the
exact form is unknown; the checker now also reads several files in one bracket separated by
commas and ranges written with an en or em dash, and a claim whose bracket still can't be read
says so and shows it ("no citation it can read: [...]"). And because a missing page that fails
was retried on every sync (eShop's would have cost about $3.60 each time), a failure is recorded
(`repo_state.pages_failed_at`, migration 11) and the page waits until the code changes or
`--full`. Work descriptions also drop words almost every one uses ("let", "users", "people"),
which had ranked repos by their user routes for "let users save articles to read later".

**The first PO-style question went unanswered by the brain.** A fresh Claude Code session asked
"What can users do in RealWorld, and what rules apply to profiles?" answered from memory of the
public RealWorld spec and called no brain tool. Its brain server was still `main` (no product
pages or systems), but the deeper gap was that nothing told the agent "RealWorld" is a name the
brain holds, and the name matches a famous public project. The server's instructions now end
with a catalogue built when it starts: the systems and repos the caller can read (up to 40
repos, then a pointer to `brain_repo_card`), each with its product sentence, and a line saying
these names are the organisation's own even where one matches a public project. About 850
tokens for the seven trial repos. Product names at Citation ("Atlas", "Lucy") will need the
same, since they mean nothing to a model on their own.

**What would change it:** re-tune the weights when every repo has a product page. Repos that make
up one product but don't call each other over HTTP are left out of suggestions until B2b's
event, gRPC and package links count too; a person can add them with `brain systems set`.

## 2026-10-12: a card asked for a system's name answers with the system

The second PO-style test ("What can users do in RealWorld, and what rules apply to profiles?")
used the brain and answered at product level from three product pages, citing the rules that
differ between implementations. Its one failed call was `brain_repo_card` with "realworld": the
instructions tell agents to call the card with any name, and people name products as often as
repos. `brain_repo_card` (and `brain card`) now answers a system's name with that system's
overview, saying so first; a repo's name still gives its card.

## 2026-10-12: links beyond HTTP: events, gRPC and shared packages

Repos meet over more than HTTP. Mapping a repo now also lists events published and handled
(RabbitMQ, Kafka, Service Bus, SNS/SQS, an event bus between services), gRPC methods served and
called, and packages published and depended on. They come from a second Claude Code run with its
own prompt (`list-links.md`) and schema: each entry has a `name` and cites instead of a method and
path. The HTTP run keeps the prompt it was tuned on (see below for why).

- **Stored in the existing `seams` columns, with no migration.** The kinds are `event-publish` /
  `event-subscribe`, `grpc-serve` / `grpc-call` and `package-publish` / `package-use`; `method`
  holds the family (`event`, `grpc`, `package`), `raw_path` the name as written and `route_key`
  its normalised form. The table is in `architecture.md` ("Seams").
- **Verified like paths.** The cited lines must exist (80-line cap), and the name, or each part of
  it (split at `/`, `.`, `:`), must appear in them. A package's version is ignored. A gRPC name
  must be `Service/Method`. A name only known at run time is kept with no key, counted and
  located, never guessed; served gRPC methods and packages must be named. Dropped entries get the
  existing second pass with their reasons.
- **Matched exactly on the normalised name:** case-insensitive; a gRPC method without its proto
  package (clients rarely spell it); a package without its version. No suffix matching: a name has
  no base path to differ by. When nothing matches, `brain_find_consumers` lists known names
  containing the one asked for, so `event OrderStarted` points at `OrderStartedIntegrationEvent`.
- **The HTTP rules carry over.** A repo handling its own event (or calling its own gRPC service)
  links only within itself, marked `same repo`.
- **Tools:** `brain_find_consumers` takes `event <name>` (or topic, queue, message), `grpc
  <Service/Method>` and `package <name>`; `brain_impact` lists everything a repo or file provides
  with its users, and its `route` filter takes the same forms; cards count every kind on the
  Seams line and in Calls / Called by; search indexes the names.
- **Systems count these links too.** A system's overview, the facts `systems suggest` reads, and
  the check that each member links to another all use every kind, so repos that only share
  events or a package can make up a system.
- **Packages:** only packages the organisation may publish are listed (scoped or company-named,
  private feeds, git references), not well-known public ones, so cards don't fill with `react`.
  References between projects in one repo by path aren't packages.
- **Shared databases are left out.** Table names like `users` repeat across unrelated databases,
  so links would be wrong more often than right. A repo's own database can appear on its
  technical pages without linking repos. Revisit if a real repo shows a clear, identifiable
  shared database.

**Why two runs.** The first version asked for everything in one run. On eshop it listed far
fewer HTTP seams (53 routes and 22 calls, against 82 and 77 stored): no Identity MVC actions,
health checks or functional-test calls. Telling it to be as thorough with routes and calls as if
they were all it was asked for brought that to 63 and 51, still a quarter and a third short. So
HTTP has its run back, unchanged, and the other links have their own. It costs a second run on a
full map (about $3.50 on eshop, cents on a small repo). The two runs only read the worktree and
don't depend on each other, so they run side by side: a full map takes about as long as the
longer of the two, not both. Updates stay incremental: each run maps only the files being redone,
and the HTTP run is skipped when those are all manifests such as `requirements.txt`.

`brain sync <name> --only links` (or `--only wiki`) redoes one step. Checking a change to link
mapping with `--full` had also rewritten eshop's whole wiki ($2.88), which wasn't wanted.

**Gate of the two-run version** (eshop, a snapshot of the real store, `--full` seam re-map):
84 routes and 56 calls (+2 run-time), against the stored map's 97 distinct HTTP seams: 89 match,
3 are new, and 8 are missing (the two OpenAPI documents, and six calls whose URL is a variable
such as `subs.DestUrl`). The other kinds came out the same as the single run: 13 events published,
18 handled, 3 gRPC served, 6 called. 3 entries were retried and none were dropped. It cost $5.91,
against $2.44 for the single run, so a full eshop map costs about $3.50 more. Small repos and
updates cost cents.

**Rafe's sync of the same commit** (`--full`, before the runs went side by side): 76 routes and
105 call sites (48 distinct endpoints; the functional tests call the same ones many times), the
same 31 events and 3 gRPC methods served, in 813s and $5.36. It found only the web app's 3 gRPC
calls, not the mobile app's (`src/ClientApp`) as well. That is run-to-run recall, not something
the check can catch: it proves what is kept is in the code, not that everything was listed.
Updates re-map only changed files, so a miss stays until those files change or `--full`. Worth
watching on real repos (B6), where one missed caller matters.

**The fix for that: a second look.** Rafe's next `--only links` run missed the web app's four
order-status handlers, a Webhooks handler and the mobile app's gRPC calls again: the run stops
before it has looked everywhere, skipping whole files. Now a full map of the links run asks once
more, with the list of what was found, for anything missed in each service and app, and its
additions go through the same check; updates map a few files and don't. The prompt also says to
list each handler and each client's calls separately. Two gated full maps then found all 18
handlers and all 6 gRPC calls, with the second look adding nothing either time: the prompt line
may be what fixed it, and the second look stays as cover since the misses varied between runs.
Each full map cost $4.41–4.65. The time sync prints is now start to finish (682s and 901s here);
it had been the sum of the runs, which go side by side.

**Gate of the single-run version** (a snapshot of the real store, `--full` seam re-maps only):

| Repo | Found | Dropped | Cost |
|---|---|---|---|
| eshop | 13 events published, 18 handled; gRPC 3 served (`Basket/GetBasket`, `UpdateBasket`, `DeleteBasket`), 6 called (WebApp, ClientApp); 63 routes, 51 calls | 15 on the first pass, all recovered on the second | $2.44 (first run $2.09) |
| react-web | 22 calls, no other kinds | 0 | $0.27, then $0.10 |
| aspnet-api | 19 routes, 1 call, no other kinds | 0 | $0.64 |

- `consumers "event OrderStartedIntegrationEvent"`: published by Ordering.API's
  `CreateOrderCommandHandler.cs:32-33`, handled by Basket.API (`Extensions.cs:19`), `same repo`.
  `OrderStatusChangedToPaidIntegrationEvent` has three handlers (Catalog, WebApp, Webhooks).
- No false links among the RealWorld repos: their cards are unchanged, and none gained a package
  or event.
- A citation can be up to three lines off, as for wiki claims: in the first run one Webhooks subscription was
  located on the line above its own.

## 2026-10-12: facts from people (B3a): a write tool the person confirms, not the agent

What a product owner tells their agent during a brief ("follows are capped at 500") should reach
the next agent. Rafe chose all four of the plan's recommendations: facts sit beside the AI pages,
in a sixth tool, anyone using the brain locally may confirm (owners when hosted), and searches
the brain couldn't answer are logged locally.

- **`brain_record_fact`, the first tool that writes.** It is the exception to "agent tools are
  read-only", so it is guarded in three ways:
  - **MCP elicitation:** the server asks the person through the client. Claude Code shows a
    dialog with the fact, their name (git `user.name`), and what the brain already says nearby
    (the closest wiki sections and facts, by search, no AI). They accept, edit or decline. The
    answer goes to the server, not through the agent, so an agent can't confirm for them.
  - **`anthropic/requiresUserInteraction`** in the tool's `_meta`: Claude Code asks permission
    on every call, even when the server's tools are allowed.
  - **Instructions and description:** record only what the person said in the conversation,
    never repo text, tool output or a web page.
  Where no dialog is possible (a client without elicitation, a headless `claude -p` run, such as
  a harness skill), the fact is stored as **proposed**. Agents see it labelled so, and a person
  confirms it with `brain facts confirm`. A decline stores nothing.
- **Beside the AI pages, never inside them.** Wikis stay regenerable, and a rewrite can't lose a
  person's fact. They come first wherever they appear: the product page opens with `## From
  people` (the repo's facts, then its system's), the card has a `Facts from people` line, search
  lists them before systems and sections (confirmed and current ones first), and system overviews
  list the system's and its repos' facts.
- **Stored in `facts` (migration 12)** on a repo or a system (a system's facts go with it if it's
  removed), with kind, text, the person's words, who, when, an optional ticket and optional
  anchors. Anchors are file:lines checked like wiki citations against the committed file (they
  must exist; at most 80 lines). Facts are searched through their own FTS5 table, kept by
  triggers.
- **Staleness without AI.** On each sync, a live fact with anchors is compared with the commit it
  was anchored at, using `git diff --unified=0`. A change to an anchored line, or the file going,
  marks it stale (`stale_since`); it stays visible, labelled to re-confirm. Lines added or removed
  above it move its anchors instead. Staleness is a marker, not a status, so a proposed fact can be
  stale too.
- **Gaps** are questions the brain didn't really answer: a `brain_search` where no fact, wiki
  section or endpoint has every one of its words (search ORs them for ranking, so "refund approval
  policy" still lists sections that only say "policy"; on the real store it matched 6 that way),
  and a `brain_impact` work description that matched nothing. They're logged in a `gaps` table
  on this machine, and `brain gaps` groups them by question. A bm25 threshold was considered and
  left out: scores aren't comparable between questions.
- **The CLI** adds `brain facts` (list, add, confirm, edit, retire, export). `facts add` counts
  as the person confirming, since they typed it.

**Found in the unprompted test.** Stating "users should be capped at 1000 authors" in a plan,
without mentioning the brain, the agent found the recorded 500 fact, pointed out the conflict and
that no API enforces either, and offered to update the rule, but it could only have added a
second fact beside the first. `brain_record_fact` now takes `replaces: <fact number>`: the dialog
shows the fact being replaced, and it is retired when the new one is confirmed (a proposed
replacement leaves it standing until then; `brain facts confirm` retires it). Migration 13 adds
the link. The same test showed the agent listing folders before loading the brain's tools in the
desktop app, so the instructions now say to load them first.

**Not in B3a:** an AI check of a fact against the code it's about (B3b), suggestions from gaps,
and the harness's PO brief skill using the tool (H1).

**Found in Rafe's first test (the desktop app's Code tab):** the permission prompt appeared and
was allowed, but the confirm dialog came back declined both times without being shown. The app
says it supports elicitation, then declines. So a decline that arrives within a second is now
reported to the agent as "most likely never shown", and the agent can call again with `propose`
to store it as proposed (no new risk: clients without the dialog already do that). A decline a
person actually makes still stores nothing.

**What would change it:** POs mostly use the desktop app, where facts can only be proposed today
and confirmed in a terminal. They need a confirm step there before the loop is really theirs:
`brain web` (B5) with a confirm button is the likely place. Hosted, confirmation moves to owners, and facts may export to the curated-content
repo (`brain facts export` gives its shape).

## 2026-10-13: facts from people are checked against the code (B3b)

A confirmed fact says what people agreed, not what the code does. A PO's agent should tell "the
code enforces it" from "agreed but not built" and "the code does otherwise". Rafe chose checks
on every sync, and lines that agree becoming anchors.

- **One Claude Code run per repo** with facts due, all in one prompt (`prompts/check-facts.md`).
  A repo fact is checked in its repo; a system fact in each member repo. Verdicts: **agrees**,
  **contradicts** (the code actively does otherwise), **absent** (no such rule in this repo: not
  built, or not a code matter), each with one sentence.
- **Verified without AI:** agrees and contradicts must cite lines that exist (at most 80, and
  names in backticks must appear there, through the wiki checker's `claimProblem`); absent must
  name files it looked at that exist. A failed answer is stored as **unclear**, with the reason,
  and isn't retried until the fact or the code changes, so a bad answer can't cost money on every
  sync.
- **Checked again** when a fact has never been checked in that repo, its text changed, or a file
  the last check cited or read changed. Stored in `fact_checks` (migration 14).
- **Found anchors:** a repo fact nobody anchored takes the agreeing lines (up to 3) as anchors,
  marked found. A change to them marks it stale as before; the re-check in the same sync clears
  the mark if the code still agrees and moves the anchors. A person's anchors are never changed.
- **Never changes a fact or its status:** people decide what's agreed. The line shows the
  verdict (`code agrees`, `code contradicts it at … : …`, `not in the code of …`), only for repos
  the caller can read.
- **Sync** gains a fourth step (`--only facts`); `brain facts check` runs it now.

**Gate** (a snapshot of the real store, three facts across the five RealWorld repos, $0.36 for
the first pass, about 10s a repo):
- "Only an article's author can delete it" (laravel-api): agrees, citing `DeleteArticle.php` and
  `ArticleController.php`, which became its anchors.
- "Anyone signed in can delete any comment" (aspnet-api): contradicts: "Deleting a comment is
  refused with Forbidden unless the signed-in user is the comment's author" (`Delete.cs:38-41`).
- The 1000-follow cap (RealWorld): absent in four repos, but flask-api said contradicts ("no cap:
  a user can follow any number"). Both readings are defensible, but a PO needs one: the prompt
  now says code that simply lacks a rule is absent, and contradicts means the code actively does
  otherwise. Re-checked, flask-api says absent and the comment rule still contradicts.
- A second `facts check` with nothing changed ran no AI.

## 2026-10-13: wikis that fit the repo, and syncs side by side (B4a)

A technical plan needs the architecture, the key flows, the data model and the integrations
without grepping. Five fixed pages hold that for a small service but not for eShop, whose
ordering page was a few lines for a whole service. Rafe asked that it line up with DeepWiki and
Google Code Wiki without bloat, and without making syncs slower.

- **From DeepWiki:** pages are planned from the code's structure first (DeepWiki clusters files),
  with a cap (theirs is 30, ours 20) and steering by notes. **Not copied:** DeepWiki reads its
  steering from `.devin/wiki.json` in the repo. Ours is set by a person (`brain note`, or
  `brain_set_note` with a confirm dialog), because repo text is untrusted. **Kept, which neither
  of them has:** every claim and diagram box is checked, and updates are incremental.
- **Small or large, without AI:** 200+ source files outside tests, or 4+ projects. On the samples
  that is only eShop (573 files, 20 projects); laravel-api, the largest of the rest, has 96 in
  one. Small repos keep a single run, so they get no slower, and gain data-model and
  integrations pages where they apply.
- **Large repos:**
  - Planned from a free inventory, so the planning run doesn't list folders itself.
  - Written 4 pages to a run, the runs side by side, each starting from its pages' key files.
  - Planned again only for a new project, enough new code outside every page, or a changed note.
    Even then, only new pages are written; a note shapes existing pages as they're next rewritten.
- **Updates do less:** citations move through the diff when only the lines around them changed,
  using the same code as fact anchors. A page is rewritten only when its cited lines change, its
  cited file grows by ten lines or more, or a file is added beside one it cites.
- **Diagrams** are on the overview and flow pages only. A `%% [path:lines]` comment cites each
  element, and each is checked like a sentence. Agents get pages without them by default: the
  text says the same, and it saves tokens.
- **Speed:** a sync's links, wiki and fact checks share one worktree and run at once. `add` and
  `sync` do three repos at a time, under one cap of four Claude Code runs per command.

**Gate** (a snapshot of the real store):
- **eShop, as its next sync will run it** (it has five pages and no plan):
  - Planned 18 pages around the five: 10 areas matching its real services and apps, place-order
    and sign-in flows, data model and integrations.
  - Wrote the 13 new pages in 273s for $2.78. The plan was the first run, then the batches side by
    side. All were published, keeping 73–96% of their claims.
  - The five old pages were kept, not rewritten.
  - The place-order flow has 15 numbered, cited steps from checkout to stock removal, and a
    sequence diagram that passed the check. Five spot-checked citations were all right.
- **laravel-api, small** (`--only wiki --full`): one run with no planning, 90s for $0.45. Seven
  pages: the five plus data-model and integrations. Its overview flowchart has six cited boxes,
  all kept.
- **Updates, in a scratch clone of eShop:**
  - A comment line added above cited lines: no AI run; 18 pages carried, with their citations
    one line lower.
  - A new `Loyalty.API` project (csproj and three files): planned again ("a new project at
    src/Loyalty.API"), one page written for $0.29 in 81s, and the other 18 carried.
  - A steering note: planned again, with no pages added or dropped.
- **Technical-plan questions** from headless Claude Code sessions, with the brain and file tools,
  working in the eShop clone:
  - "plan a delivery date on orders": brain_impact with work, then overview, data-model,
    ordering and webapp;
  - "how does checkout work end to end": the place-order-flow page;
  - "plan 'save for later' in laravel-api": overview, data-model, brain_impact.

  None read or grepped any code. Each cost $0.07–0.11, and the plans named the right services,
  files and migrations.

**Found and fixed at the gate:** pages pointed to each other in sentences of their own ("See
the api page"), which the check removes as uncited. Page runs now put the pointer inside a cited
sentence. And sync said "no AI run" after a planning run; it now gives the planning cost.

**After the gate, the paths that hadn't run for real:**
- **A full sync of laravel-api, all three steps at once** in one shared worktree: 100s wall
  (fact checks 12s, links 32s, wiki 96s) against 140s in turn, and the worktree was cleaned up.
- **`brain add` of flask-api and react-web together** into an empty store: both in 91s.
- **A bad run, recovered:** in that add, react-web's single page run came back with only two
  pages (one slugged `x`, one citing a made-up path alongside a real one). Until now a full run
  took whatever it returned and marked the missing required pages as failed until the code
  changed. A full run now asks again, on its own, for any required page it left out, as updates
  already did. Re-run, react-web wrote six good pages ($0.22, 57s), correctly with no data-model
  page for a frontend.

**Still open:**
- **Core pages and new projects:** when a new project arrives, the core pages (api, overview)
  are rewritten only when their own cited lines change. So the API page doesn't list a new
  service's routes, though `brain_find_consumers` and the new area page do.
- **Flows across repos:** B4b.

## 2026-10-13: two checker and prompt fixes

- **A cited file's folder counts as named.** "The routes live in `src` [src/articles.ts:3]" was
  removed because `src` isn't text in the cited lines, though the citation's own path shows it.
  Seen on eShop's new Loyalty page at the B4a gate. A backticked term that is the folder of a
  cited file is now supported, like the cited file itself.
- **Prompts are read with `\n` line endings.** A Windows checkout gives the prompt files CRLF
  endings (seen after pulling B4a), so prompts differed by machine and the steering-note test
  failed on `main`.

(Found while building journey pages across repos, which were dropped: see the B4b plan. Tracing
flows from the link map on demand replaces them.)

## 2026-10-13: following a flow across repos (B4b)

**Why:** a planner asking "what does changing this set off?" asks a downstream question. The
link map knew who serves and calls an endpoint, not which calls, events and tables a handler
goes on to reach.

**Rejected first:** five pre-written journey pages per system. A web UI has many flows, each
hitting several APIs that run their own logic against their own databases, so five pages cover a
small slice, and nothing shows what's missing. Neither DeepWiki nor Google Code Wiki writes
journeys across repos; tools that handle flows across services map the links and trace them when
asked.

**What was built:**
- A third run in the links step. For each entry point (route, event handler, gRPC method served),
  and each job or UI action it finds, it answers what handling reaches: exit points, tables read
  or written, or nothing. Each answer is a chain of steps, checked without AI.
- The trace is worked out when asked (`follow`), with no AI: exits to whoever serves or handles
  them, and table writes to the same repo's jobs that poll the table.
- Exit points nothing reaches are counted on every sync, as a measure of what the run may have
  missed.

**Design calls, from evidence:**
- **No depth limit.** A visited set stops loops. Alibaba's production traces peak at depth 3,
  with more than 4% of call graphs deeper than 10. On eShop the order flow is 9 deep, so a limit
  of 8 would have cut off the most important flow in the repo.
- **Width is folded in the output instead:** up to 5 things per step in concise answers. Fan-out
  measured median 2, 90th percentile 5 on eShop (the production median is 4).
- **A table write continues only to jobs** that poll the table. A route reading the same table is
  set off by its own callers. The first version continued to every reader, and the trace became
  noise.
- **Tables are matched within a repo** whatever their schema, quotes or case (`ordering.orders`
  is `Orders`), and are named but not linked between repos (B2b).

**Gate** (a snapshot of the real store; about $9 in all, more than the $5 estimate, because eShop
was traced twice while the check was fixed):
- **eShop:** 189 checked chains, 3 dropped, and no exit point left without a trigger ($2.89,
  280s). The first run left 8 without one: the grace-period job was dropped for a line a few off,
  and UI actions were named by description. A found job is now taken at the line naming it, names
  must be code names, and a second look asks about any exit point nothing reaches.
- **The order trace** (`POST /api/orders --follow`), reading each hop's cited lines:
  - the order is saved to `orders`;
  - the grace-period job polls it and publishes `GracePeriodConfirmed`;
  - Ordering sets awaiting validation;
  - Catalog confirms or rejects stock;
  - payment succeeds or fails;
  - the order is paid and Catalog removes stock, or it is cancelled.

  That matches the place-order page a person checked. Nine hops were spot-checked against the
  code, all right. "Started from" names the web and mobile checkouts.
- **RealWorld:** `POST /api/articles` shows all four APIs with the tables each writes, started
  from react-web's `Editor`. laravel-api first kept 1 chain of 22: its routes are declared in
  `routes/api.php` and handled in controllers, and the check required the chain to start in the
  declaring file. A chain may now start in a file the declaration names (`'AuthController@login'`).
  23 chains after the fix.
- **An entry point no chain holds for** was asked again on every sync ($0.22 a time on eShop). It
  is now recorded with why, and asked again only when its code changes.
- **A fresh session** asked what changing order creation would set off. It called
  `brain_find_consumers` with follow, read no code, cost $0.09, and named the databases touched.
  It started from the `OrderStarted` event rather than the endpoint, so it missed the chain behind
  the orders table. Agents choosing where to start is a matter for H1.

**From Rafe's run on the real store** (about $4 for all seven repos; the order trace and a fresh
session matched the gate): laravel-api dropped 8 table chains, because Eloquent writes `users`
through the `User` model, so the table's name never appears. The singular now counts too, as in
Rails and Django. react-web listed 11 components that call nothing; a found UI action that reaches
nothing is now skipped quietly.

**Still open:**
- Chains through a mediator or service are dropped when the run skips the step that defines the
  linking name (aspnet-api 27 of 103, express-api 4).
- Calls whose URL is only known at run time can't be linked.

## 2026-10-13: everything a person does, through MCP (B5)

**Why:** the brain is used through the harness, and a PO shapes the brief with an agent in Claude
Code's desktop app. Three things worked only in a terminal:
- **Confirming a fact or note.** That needed an elicitation dialog, which the desktop app declines
  without showing it.
- **Confirming, rewording or retiring a fact** after it was recorded.
- **Confirming or changing systems.**

The gaps list was terminal-only too. `brain web` (a local view with a confirm button) was the old
B5; Rafe dropped it, since everything should be a tool call. Setup (add, sync, remove, hooks,
doctor, set-ref) stays in the terminal.

**What:**
- **The person confirms in the conversation.** The agent shows the fact; when the person agrees,
  the call carries their words (`confirmed_with`), stored on the fact (migration 17) and on a
  note. Without them a fact or note is proposed, and other changes are refused.
- **The permission prompt is the second gate.** Each write tool sets
  `anthropic/requiresUserInteraction`, so Claude Code asks the person to allow every call,
  showing what will be stored.
- **The dialog is gone,** with its fast-decline handling and `propose`. Keeping two ways to
  confirm would double the instructions, tests and failure modes.
- **New tools:**
  - `brain_review` (reads): what's waiting for a person (proposed or stale facts, suggested
    systems, proposed notes) and gaps;
  - `brain_facts` (writes): confirm, edit, retire;
  - `brain_systems` (writes): confirm, set, rename.
- **Other changes:**
  - `brain_set_note` can confirm a proposed note;
  - rewording a confirmed fact without the person's words makes it proposed again;
  - gaps from a search limited to a repo the caller can't read are left out;
  - answers no longer tell people to run a command.

**Design calls:**
- **Reads and writes in separate tools.** At first `brain_facts` and `brain_systems` also listed.
  A headless check showed the cost: a write tool prompts on every call, so a list prompted too,
  and a headless run couldn't list at all. That makes ten tools, not nine, and no read ever
  prompts.
- **Actions over tools.** One tool per terminal command would have made about twenty. Every
  description sits in every session's context, and agents choose worse from long lists.
- **Names are frozen.** H1's skills will name these tools and their parameters.
- **Left out:**
  - deleting a system (a deletion, like `repo remove`);
  - suggesting systems and checking facts (AI runs that sync already does);
  - export (H2).

**Gate:**
- 231 tests pass.
- **Headless `claude -p`** on a copy of the real store, with `mcp__citation-brain__*` allowed:
  - `brain_record_fact` and `brain_facts` were refused before reaching the server ("MCPTool
    requires permission"), and no fact was written;
  - `brain_review` and `brain_repo_card` answered.

  So the technical-planning stage can read headless, and only a person can write.
- The desktop walkthrough is manual-testing Part G (Rafe).

**What would change it:** hosted (H2), confirmed facts may go to owners for review. The export
shape exists, and `confirmed_with` shows what each person agreed to.

## 2026-10-13: adding a repo from Claude Code, and a README for setting up (B7)

**Why:**
- Only a terminal could add a repo. People use the brain through the harness in Claude Code,
  often the desktop app, and should be able to say "add github.com/… to the brain".
- Enrolling takes minutes for a small repo and up to half an hour for a large one. A tool call
  can't wait that long, and MCP shows no progress between calls.
- While a repo enrols, nobody should plan from it, and people need a way to tell when it's done.
- The README walked a harness user through terminal commands they don't need.

**What:**
- **`brain_add_repo`**, the eleventh tool: `source` (a local path, a GitHub URL or
  `owner/repo`), `name`, `note`. It answers at once with an estimate and starts the ordinary
  `brain add` as a detached process, which outlives the session. It asks the person to allow every
  call, and its description says it costs time and money.
- **GitHub sources** are cloned with plain `git clone` and the person's own credentials into
  `~/.brain/repos/<name>` (`BRAIN_REPOS`). `brain add` and `brain repo add` take the same sources
  through the same code (`src/ingest/enrol.ts`). A local path is enrolled in place, as before.
- **Status** is recorded step by step (migration 18, `enrolments`): cloning, indexing, mapping
  links, tracing, writing the wiki (k of n pages once the number is known), the hook. The card
  shows it with the estimate. Read tools that reach a repo not yet indexed say it instead of "Run:
  brain sync". A failure says what failed and that adding again finishes it. The catalogue marks a
  repo being enrolled; `doctor` and `repo list` show running and failed ones.
- **Instructions:** offer `brain_add_repo` for a repo the brain lacks, saying how long it takes;
  don't plan from a repo being enrolled; the catalogue is per session, but the card finds a new
  repo at once.
- **The README** is now for someone setting up: what it is, setup as numbered commands, adding
  repos and telling when they're ready, what to ask by harness stage, updates, troubleshooting,
  removing. Every command moved to `docs/cli.md`; trust, facts, the wiki, links and limits to
  `docs/how-it-works.md`.

**Design calls:**
- **One new tool, not an action on an existing one.** Reads and writes stay apart (B5): adding
  prompts on every call, so it can't sit on the card, which must not prompt. Status needs no tool
  of its own: it's on the card, which agents already call first.
- **The background process is the CLI.** The same pipeline, log, lock and hook as a terminal
  `brain add`, so there is one enrolment path. A sync or hook firing during an enrolment is folded
  into one more pass by the existing per-repo lock.
- **Status in the store, not a file next to the lock.**
  - Both processes already share the store: hooks' background syncs write it while the server
    reads it (WAL, with a busy timeout).
  - It keeps the history the estimate needs. A file would need its own format, its own history
    and a second read path.
  - It goes through `Store`, so hosted Postgres carries it; a file wouldn't reach other workers.
  - Tests read it from `:memory:`. The cost is one table and four `Store` methods.
- **Liveness from the pid,** with the same check locks use (`processAlive`, shared with the
  queue). A running row whose process is gone reads as stopped, so a crash or a closed terminal
  never looks like progress.
- **Estimates:** the store kept page costs but no durations, so past syncs couldn't be timed.
  Enrolments now record time, files and cost. The estimate goes by the nearest earlier enrolments
  within three times the size that ran Claude Code; until there are some, the size bands from
  2026-10-07, labelled rough. A GitHub repo is sized once it's cloned, so its card has the
  estimate, not the first answer.
- **Retry is the same call.** A failed or stopped enrolment, or a repo enrolled but never indexed,
  is taken as it stands, and the sync redoes only what's missing.
- **Clones nobody pulls.** A hook fires on a fetch, but nobody fetches the brain's own clones. So
  the MCP server fetches them in the background when a session starts, at most hourly, with
  credential prompts off; their hooks do the rest. `repo remove` deletes a clone only inside the
  brain's clone folder.
- **No `confirmed_with`.** The person asks for the repo and allows the call, which shows the
  source. There is no wording of theirs to keep.
- **Wider than asked:** any git URL is accepted, not only GitHub (Azure DevOps, say). It costs
  nothing: the name is the last part of the path, and git does the rest.

**Gate:**
- 250 tests pass (231 before). New: source parsing (https, `.git`, browser URLs, `owner/repo`,
  SSH); a background enrolment through the MCP tool, the card going from being enrolled to done;
  a failed clone, with git's reason and how to retry; read tools on a repo being enrolled;
  `brain add <GitHub URL>`, cloned from a local bare repo through git's `insteadOf`; the tool list
  (11, `brain_add_repo` asking); estimates from history; wiki progress; fetching clones.
- **End to end, on a copy of the real store:** a stdio MCP session against this checkout called
  `brain_add_repo` with `gothinkster/flask-realworld-example-app` (named flask-gate). It answered
  in 27 ms, and the session closed straight away, taking its server with it. Fresh sessions then
  read the card every 15 seconds:
  - `being enrolled · not ready yet`, then `mapping its links; writing the wiki`, with
    `Wiki: being written` and `Seams: being mapped`;
  - `tracing what each entry point leads to` once the 19 routes were in;
  - `Enrolled just now, in 1 min for $0.49: ready.`, with 7 pages and `Called by: react-web`,
    about 90 seconds after the call.
  The clone came from GitHub with plain git, its hook points at the copy, and the next session
  start fetched it. `repo remove` deleted the clone.

**What would change it:**
- Hosted (phase 6): enrolment becomes a queued job on a worker. The table stays; the detached
  process goes.
- If Claude Code shows progress for long-running MCP tasks, the card could give way to it.
- If people enrol many large repos at once from several sessions, a cap on Claude Code runs across
  processes (today it's per command).

## 2026-10-14: planning depth (B8)

Tests of the harness against the brain showed three gaps. An agent called `brain_get` with a `pages`
list; the schema silently dropped the unknown key, the agent got the page index back and gave up
on the wiki. Plans needed where an area's tests live and the repo-wide conventions, which the wiki
lacked. And when the checker removed a step from a numbered list, the numbering kept a gap.

**What it does:**
- **Tool inputs are strict.** All 11 tools refuse a parameter they don't have, with the SDK's
  message (`Unrecognized key: "pages"`), so an agent learns at once what it got wrong.
- **`brain_get` takes up to five pages.** `page` is a name or a list. Each page is shown as it is
  alone, with `---` between them; a name that isn't a page is named in its place, and the call is
  an error only when none is.
- **A `conventions` core page,** and build-run-test says where each part's tests live. Conventions
  are patterns to follow (logging, errors and user-facing messages, validation, configuration),
  at most four bullets a heading, each with a cited example. An existing wiki gains the page on its
  next update; a large repo's stored plan gains it without planning again, keeping its plan date.
- **The checker tidies what removals leave.** Steps are counted again from the list's first number
  (a removed first step still starts the count at its own number), and a heading whose section is
  empty goes, never the title.

**Design calls:**
- **Strict, not lenient.** Ignoring an unknown key is what hid the mistake. A refusal costs one
  retry; a silent drop cost the whole wiki.
- **Pages joined, not a new answer shape.** Each page is rendered by the code that renders one, so
  a list of one equals a string and nothing else changed.
- **Core, not area, for conventions.** Every repo has them, and a planner reads them for any work.
  Cost: one more page per wiki.
- **Tombstones for removed steps,** so the count doesn't depend on which step survived.

**What would change it:** if agents often want more than five pages, raise the cap; if conventions
pages come out as inventories, tighten the prompt rather than add more headings.
