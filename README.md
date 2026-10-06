# brain-concept

Organisation-wide engineering context for coding agents, served over MCP.

**Add a repo, get a wiki.** The brain has Claude Code read each enrolled repository, in any
language, and write wiki pages in which every sentence cites the lines it is based on. Agents ask
for exactly what they need (*what is this repo, how do I build and test it, how does this module
work, who calls this endpoint, what breaks if I change this file?*) instead of cloning and
reading whole repositories. Every answer says which commit it describes, how far behind the
tracked branch that is, and how it was made, so the agent knows how far to trust it.

It is a separate service. The Citation delivery harness (`citation-harness-library`) calls it
over MCP and keeps all of its own skills.

**Status:** local proof of concept, part-way through the switch to AI-written wikis (W3 of W0–W5:
pages are generated, every citation is checked before an agent sees it, and the wiki updates
itself when the code changes, rewriting only the pages affected; routes and calls in any language
are next). See [Where it's going](#where-its-going).

## What it can do today

| Question | Tool | What answers it |
|---|---|---|
| What is this repo, how do I build and test it, what API does it serve, how do its key modules work? | `brain_get` | The repo's AI-written wiki pages, each sentence cited to code |
| What repos does it talk to, and is there a wiki? | `brain_repo_card` | The index: freshness, languages, the seam graph, the wiki's pages |
| Who serves this endpoint, and who calls it? | `brain_find_consumers` | HTTP routes and calls in every enrolled repo |
| What would break if I changed this repo, file or endpoint? | `brain_impact` | The routes declared there, and every caller of each one across repos |

All four are read-only. The examples below are real output from the
[RealWorld](https://github.com/gothinkster/realworld) example apps.

### "How do I build and test it?": `brain_get`

`brain wiki <repo>` has Claude Code write four pages (overview, build-run-test, api, and one on
the most important module). `brain_get` with no page lists them; with a page, it returns it:

```
aspnet-api · build-run-test · @a397d11 · up to date · llm-generated · citations checked: 19 of 22 claims kept (3 removed)

# Build, Run & Test

## Build driver (Bullseye)

The build is itself a C# console program, `build/build.csproj`, using Bullseye targets rather than
shell scripts [build/Program.cs:1-7][readme.md:23]. It defines five targets: `clean` …
[build/Program.cs:14-35], `format` (`dotnet tool restore` then `dotnet csharpier format .`)
[build/Program.cs:37-44], `build` (`dotnet build Conduit.slnx -c Release`, depends on `format`)
[build/Program.cs:46], `test` (runs `dotnet test` against every `tests/**/*.csproj`, depends on
`build`) [build/Program.cs:48-60] …

AI-written (llm-generated). Every claim kept here cites lines that exist and contain what it names; whether it reads them correctly isn't checked, so confirm at the citation before relying on it.
```

- **Every citation is checked** before a page is stored, with no AI involved. Each sentence, list
  item and table row must cite lines that exist at the commit, no citation may span more than 80
  lines, and the names it puts in backticks must appear in the cited lines (allowing for
  paraphrase and namespaces; a route's HTTP method must be there too). Claims that fail are
  removed. A page where fewer than half pass is written once more, with the AI told what was
  removed and why; if it fails again it isn't published, and its previous version stays (marked
  as kept from an older commit). `brain wiki` lists what it removed and why. A resource
  declaration (`Route::resource`, Rails `resources`) counts as declaring its CRUD methods and
  actions. On the trial repos about 80% of claims were kept;
  the removals were real problems, such as `net10.0` cited to a file that doesn't contain it, a
  `FLASK_DEBUG` the code never mentions, or citations spanning 150 lines.
- **Any language:** the trial generated correct wikis for C#, PHP (Laravel) and Python (Flask)
  repos. No per-language setup is needed.
- **Commit-exact:** Claude Code runs in a temporary git worktree at the commit the brain indexed,
  so pages never describe uncommitted work. The worktree is removed afterwards.
- **Isolated and read-only:** each run uses `--safe-mode --strict-mcp-config`, with Read, Grep
  and Glob only. No MCP servers, user settings or memory, so it can't call the brain or anything
  else.
- **Cost:** about $0.60–1.00 and 1–4 minutes per repo with Sonnet for a full write. An update
  after a change rewrites only the affected pages, typically $0.05–0.25 in under 30 seconds, and
  costs nothing when no cited file changed. Locally it uses your Claude Code allowance. The cost
  of each run is reported.
- **Prompts are Markdown** in [`src/wiki/prompts/`](src/wiki/prompts/), passed straight to each
  run. They aren't skills: the task is fixed, and runs load no skills or settings, so a repo being
  documented can't add its own.

### "What is this repo?": `brain_repo_card`

```
aspnet-api  @a397d11 · up to date · parser-built
Remote: https://github.com/gothinkster/aspnetcore-realworld-example-app.git
Wiki: 4 pages (overview, build-run-test, api, articles) · read with brain_get
Files: 114 on origin/master
Languages: C# 78 · Other 9 · Markdown 8 · JSON 6 · MSBuild 5 (+5 more)
Seams: 19 routes, 0 calls via cs-routes
Called by: react-web (22 calls)

brain_impact and brain_find_consumers give the endpoints and file:line pointers.
```

- **Wiki:** its pages, or `not generated yet (brain wiki <repo>)`. If the wiki is older than the
  index, it says so.
- **Calls / Called by:** the repos this one calls and the repos that call it, among the repos you
  can read, worked out on each request.
- **Unknown names:** an unknown name returns the list of enrolled repos, which is how an agent
  finds out what exists.

### "Who serves and who calls this endpoint?": `brain_find_consumers`

```
GET /api/articles/{} · 2 servers, 1 caller in 3 repos · parser-built

Served by
  aspnet-api · src/Conduit/Features/Articles/ArticlesController.cs:39-41 · GET /articles/{slug} · suffix
  express-api · src/app/routes/article/article.controller.ts:87-98 · GET /articles/:slug · suffix

Called by
  react-web · src/agent.js:62 · GET `/articles/${slug}` · suffix

suffix = matched ignoring a base path such as /api.
Indexed: aspnet-api @a397d11 · up to date; express-api @30b68e1 · up to date; react-web @ee72eba · up to date
24 calls use URLs only known at run time (react-web · src/agent.js:20-26, …), so a missing caller isn't proof there is none.
```

- **Path styles:** `GET /api/articles/:slug`, `/articles/{slug}` or a full URL all work.
  `:slug`, `{slug}`, `${slug}`, numbers and GUIDs all count as parameters.
- **Base paths:** matches can ignore a base path such as `/api`, and are labelled `suffix` when
  they do.
- **Duplicates:** an endpoint declared in code and in an OpenAPI spec is shown once, citing the
  code.

### "What breaks if I change this?": `brain_impact`

```
aspnet-api · src/Conduit/Features/Articles/ArticlesController.cs · 6 routes, 9 callers in 1 repo · parser-built

GET /articles  (14-22)
  ← react-web · src/agent.js:48
  ← react-web · src/agent.js:50
  …
DELETE /articles/{slug}  (58-64)
  ← react-web · src/agent.js:54
```

Pass a repo, a file in it (`--path`) or one endpoint (`--route`). Routes with the most callers
come first, and callers in the same repo (its own tests) are marked `same repo`.

### Every answer says how far to trust it

- **`@a397d11 · up to date`**: the commit the answer describes, and how many commits behind the
  tracked branch that is (`2 commits behind origin/main`).
- **`parser-built`**: made by parsers, with no AI involved.
- **`llm-generated`**: written by Claude Code, with a citation on every sentence, each one
  checked automatically. The header says how many claims were kept. A check confirms the cited
  lines exist and contain what the claim names, not that the claim reads them correctly, so
  confirm at the citation before relying on it.
- **File and line pointers**, never pasted code.
- **Gaps are stated:** calls whose URL is only known at run time are counted and located, never
  guessed.
- **Permissions:** an answer only includes repos the caller may read. Locally that is every repo
  you enrolled; hosted, it will follow GitHub permissions.

### It keeps itself up to date

`brain hooks install` adds a git hook to each enrolled repo. Whenever the branch it tracks moves
(a fetch, pull, merge or rebase), the brain re-syncs that repo in the background and, if it has a
wiki, updates it. Only pages that cite a changed file (or a folder a file was added to) go back
to Claude Code; the rest are re-checked against the new commit and moved forward. Repos track
what has been merged (`origin/main`), so your editor's auto-fetch is enough, and your own
unpushed commits never leak into answers. See [Keeping it fresh](#keeping-it-fresh).

```
2026-10-06 09:28:32 flask: refs/heads/master moved
flask: 4b95fb2 -> 3d2889b (+0 ~1 -0, 44 unchanged; 0 files with seams)
flask: wiki updated at @3d2889b · $0.22 · 22s
  build-run-test           8/8 claims kept · published
  unchanged, moved to @3d2889b: overview, api, articles
```

## What it reads

- **Wiki pages:** any language. Claude Code reads the repo itself.
- **Routes and calls** (for `brain_find_consumers`, `brain_impact` and card neighbours) are still
  parser-built during the switch:

| | Routes (served) | Calls (made) |
|---|---|---|
| **TypeScript / JavaScript** | Express, Fastify, NestJS | `fetch`, `axios`, and `<client>.get/post/…` on receivers named like clients (`api`, `http`, `ordersClient`, …) |
| **C# / ASP.NET** | Attribute-routed controllers, minimal APIs (including `MapGroup`) | `HttpClient` (and its JSON extensions), `HttpRequestMessage`, RestSharp, Refit |
| **Any language** | OpenAPI 3 and Swagger 2 specs | |

In W4 Claude Code takes these over for every language. The trial found every RealWorld endpoint
in C#, TypeScript, JavaScript, PHP and Python.

## What it can't do yet

- **Re-planning the page set:** an update keeps the same pages. If a repo's structure changes a
  lot, run `brain wiki <repo> --full`.
- **Routes and calls outside TS/JS, C# and OpenAPI:** W4, by Claude Code.
- **Search across wikis:** `brain_search`, in W5.
- **Curated knowledge** (people correcting and confirming facts): phase 4.
- **Hosting:** today it runs on your machine against your local clones. Hosted (Azure, cloud
  containers for the runs, GitHub-backed permissions) is phase 6.

## Quick start

Requires Node 22.13 or later (for the built-in `node:sqlite`, so there are no native builds), git
on `PATH`, and Claude Code (`claude`) on `PATH` for wiki pages.

```
npm ci
npm run check                                        # typecheck + tests
npm run brain -- repo add ..\some-repo               # enrol a local clone
npm run brain -- sync                                # index it
npm run brain -- wiki some-repo                      # have Claude Code write its wiki
npm run brain -- hooks install                       # keep it fresh from now on
npm run brain -- card some-repo                      # what an agent will see
```

The npm scripts call `tsc` and `vitest` through `node` rather than the `node_modules/.bin` shims,
because group policy on Citation laptops blocks those shims.

## Use it from Claude Code

Register the MCP server once, at user scope, so every session in every folder has it:

```
claude mcp add --scope user citation-brain -- node C:\Users\<you>\Repos\brain-concept\bin\brain-mcp.mjs
```

Run `/mcp` in a session to check it is connected. The server tells Claude when to use it, so you
don't need to name the tools. Questions like these go to the brain:

- *How do I run the tests in aspnet-api?* A fresh session answered this from `brain_repo_card`
  then `brain_get`, with no file or web searches.
- *How does laravel-api handle authentication?*
- *If I change `GET /articles/:slug` in express-api, what else breaks?*
- *What would break if I removed the DELETE endpoint in ArticlesController?*

Start a new session after the brain changes, so it picks up new tool descriptions.

## Commands

Run from this folder with `npm run brain -- <command>`, or from anywhere with
`node <path-to>\brain-concept\bin\brain.mjs <command>`. The `page`, `card`, `consumers` and
`impact` commands print exactly what an agent gets over MCP.

| Command | Does |
|---|---|
| `repo add <path> [--name n] [--ref ref]` | Enrol a local clone. The name defaults to the folder; the ref defaults to what `origin/HEAD` points at (usually `origin/main`), or the checked-out branch if there is no remote. |
| `repo list` | Enrolled repos, the commit each is indexed at, and how far behind it is. |
| `repo set-ref <name> <ref>` | Index a different branch, e.g. `origin/release`. Updates the repo's hook if it has one. |
| `repo remove <name>` | Remove a repo, everything the brain holds about it, and its hook. |
| `sync [<name>] [--wiki]` | Index the tracked branch's committed tree (never your working copy). All repos if no name. `--wiki` also updates the wiki of each repo that has one (what the hook runs). |
| `wiki <name> [--full] [--model m]` | Sync, then bring the repo's wiki up to that commit: written in full the first time (or with `--full`), afterwards only the pages a change affects. Every citation is checked and only what passes is stored. It prints each page's kept/total claims and the first few removed, with reasons. Default model `sonnet`. |
| `page <name> [<page>]` | `brain_get`: the page list, or one page. |
| `hooks install [<name>]` | Re-sync automatically whenever the tracked branch moves. All repos if no name. |
| `hooks remove [<name>]` / `hooks status` | Stop automatic syncing / see which repos sync automatically, or why one can't. |
| `card <name> [--detailed]` | `brain_repo_card`. `--detailed` adds the full commit and a language table. |
| `consumers "<METHOD /path>" [--detailed]` | `brain_find_consumers`. |
| `impact <repo> [--path file] [--route "<METHOD /path>"] [--detailed]` | `brain_impact`. |

The store lives at `%USERPROFILE%\.brain\brain.db`. Set `BRAIN_DB` to use a different file, for
example a throwaway one while testing.

## Keeping it fresh

`brain hooks install` puts a git `reference-transaction` hook in each enrolled repo. When the
tracked ref moves, including on a plain `git fetch`, which has no hook of its own, it starts
`brain sync <name> --wiki` in the background and returns at once, so git is never slowed down.
That syncs the repo and, if it has a wiki, updates it. Repos without a wiki never call the AI.
Runs are logged to `%USERPROFILE%\.brain\hooks.log`. Read it with `-Encoding utf8` in Windows
PowerShell.

Only one sync per repo runs at a time. If the branch moves again mid-run, that run goes round
once more when it finishes, so the latest commit is always covered. A lock left by a crashed run
is taken over. Hooks installed before W3 only sync: run `brain hooks install` again to update
them.

This works with any remote, not just GitHub. "Up to date" means "as of the last fetch". The card
and every page say when the wiki is older than the index, and a page kept after a failed rewrite
says so.

The hook won't be installed if the repo already has its own `reference-transaction` hook, or if
`core.hooksPath` points inside the repo (as husky does), because that would change tracked files.
`hooks status` says why. In that case, run `brain sync <name>` from your own hook manager.

Hooks run whichever brain code is checked out in this folder.

## Testing

- `npm run check`: typecheck and the full test suite. Each test builds its own throwaway git
  repos from `test/fixtures/`. Wiki tests use a recorded Claude Code result, so they never call
  the AI.
- [`docs/manual-testing.md`](docs/manual-testing.md): try every feature by hand. It covers
  generating and reading real wikis, a playground built from real repos with a local stand-in for
  GitHub (git commands only, nothing added to this project), real open-source repos, and checks
  that Claude Code uses the brain unprompted. Run it before merging changes to what the brain
  extracts or answers.

## Where it's going

| Phase | | Status |
|---|---|---|
| 0, 1, 3a | Index, seam graph, `brain_find_consumers`, `brain_impact`, repo cards, auto-sync | ✅ |
| W0 | Trial: Claude Code finds every RealWorld endpoint in 5 repos and 5 languages; pages accurate | ✅ |
| W1 | Wiki pages: `brain wiki`, `brain_get`; the old fact readers removed | ✅ |
| W2 | Every citation checked automatically; unsupported claims removed; a failing page keeps its previous version | ✅ |
| W3 | The wiki updates itself from the hooks, rewriting only affected pages; a failing page is retried once | ✅ (this branch) |
| W4 | Routes and calls in any language by Claude Code; the parsers removed | Next |
| W5 | `brain_search` across wikis; final docs | Planned |
| 2, 4, 6 | Harness evals, curated context, hosting | After the switch |

Read [`docs/architecture.md`](docs/architecture.md) for the design,
[`docs/research.md`](docs/research.md) for the evidence behind it, and
[`docs/decisions.md`](docs/decisions.md) for every dated decision.

## Layout

```
bin/            launchers that run the TypeScript from any folder
src/core/       types, git access, language detection, HTTP path matching, the per-repo run queue
src/store/      Store interface, SQLite implementation, migrations
src/ingest/     registry, sync, hooks, extractor plugins (the write side)
src/wiki/       Claude Code runner, prompts (Markdown), wiki generation and updates, citation checker
src/serve/      access policy, freshness, tools, MCP server (the read side)
test/           vitest; fixtures are real files in their own languages
docs/           architecture, research, decisions, manual testing
```
