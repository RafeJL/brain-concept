# brain-concept

Organisation-wide engineering context for coding agents, served over MCP.

The brain indexes the organisation's repositories and answers narrow questions with small, cited
answers: *what is this repo, how do I build it, who owns it, who calls this endpoint, what breaks
if I change this file?* An agent asks for exactly what it needs instead of cloning and reading
whole repositories. Every answer says which commit it describes, how far behind the tracked
branch that is, and how the fact was made, so the agent knows how far to trust it.

It is a separate service. The Citation delivery harness (`citation-harness-library`) calls it
over MCP and keeps all of its own skills.

**Status:** local proof of concept. Three MCP tools work, and enrolled repos keep themselves up
to date. See [Where it's going](#where-its-going).

## What it can do today

| Question | Tool | What answers it |
|---|---|---|
| What is this repo, how do I build and test it, who owns it, what does it talk to? | `brain_repo_card` | README, package.json scripts and lockfiles, .NET solutions and projects, CODEOWNERS, the seam graph |
| Who serves this endpoint, and who calls it? | `brain_find_consumers` | HTTP routes and calls extracted from code and OpenAPI specs in every enrolled repo |
| What would break if I changed this repo, file or endpoint? | `brain_impact` | The routes declared there, and every caller of each one across repos |

All three are read-only. They answer in a few lines by default, and `format: "detailed"` (or
`--detailed` on the CLI) gives more. The examples below are real output from the
[RealWorld](https://github.com/gothinkster/realworld) example apps.

### "What is this repo?": `brain_repo_card`

```
aspnet-api  @a397d11 · up to date · parser-built
Remote: https://github.com/gothinkster/aspnetcore-realworld-example-app.git
About: ASP.NET Core codebase containing real world examples (CRUD, auth, advanced patterns, etc.) that adheres to the RealWorld spec and API.
Files: 114 on origin/master
Languages: C# 78 · Other 9 · Markdown 8 · JSON 6 · MSBuild 5 (+5 more)
.NET: dotnet build Conduit.slnx · dotnet test Conduit.slnx · 3 projects (1 web, 1 app, 1 test)
Owners: not declared (no CODEOWNERS)
Seams: 19 routes, 0 calls via cs-routes
Called by: react-web (22 calls)

brain_impact and brain_find_consumers give the endpoints and file:line pointers.
Commands are as the repo declares them; the brain never runs them.
```

| Line | Where it comes from |
|---|---|
| **About** | The README's first real paragraph. Badges, headings, code and "Run this:" lead-ins are skipped. |
| **.NET** | The shallowest `.sln`/`.slnx`. `dotnet test` only appears when a test project exists. Projects are counted as web, app, library or test. |
| **Scripts** | `package.json` scripts (build, test, lint, typecheck, start, dev first), run with the package manager of the nearest lockfile: `npm run`, `pnpm run`, `yarn run` or `bun run`. A script in a subfolder shows as `in evals/: npm run test`. |
| **Owners** | CODEOWNERS, found the way GitHub finds it (`.github/`, the root, then `docs/`). Shows the owners of `*` and how many path rules there are. |
| **Seams** | How many HTTP routes and calls were found, and by which extractors. Code languages with no extractor yet show as `not extracted: Python`. |
| **Calls / Called by** | Repos this one calls and repos that call it, among the repos you can read. Worked out on each request, so always current. |

An unknown name returns the list of enrolled repos, which is how an agent finds out what exists.

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
- **Base paths:** matches can ignore a base path such as `/api`, which is often added at run time,
  and are labelled `suffix` when they do.
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
- **`parser-built`**: made by parsers, with no LLM involved. Later phases add `human-reviewed`
  and `llm-generated` facts, each labelled.
- **File and line pointers**, never pasted code. Confirm in the repo before editing.
- **Gaps are stated:** calls whose URL is only known at run time are counted and located, never
  guessed, so "no callers found" is never taken as proof.
- **Permissions:** an answer only includes repos the caller may read. Locally that is every
  repo you enrolled; hosted, it will follow GitHub permissions.

### It keeps itself up to date

`brain hooks install` adds a git hook to each enrolled repo. Whenever the branch it tracks moves
(a fetch, pull, merge or rebase), the brain re-syncs that repo in the background. Repos track
what has been merged (`origin/main`), so your editor's auto-fetch is enough, and your own
unpushed commits never leak into answers. Only files that changed are re-read. See
[Keeping it fresh](#keeping-it-fresh).

## What it reads

| | Routes (served) | Calls (made) |
|---|---|---|
| **TypeScript / JavaScript** | Express, Fastify, NestJS | `fetch`, `axios`, and `<client>.get/post/…` on receivers named like clients (`api`, `http`, `ordersClient`, …) |
| **C# / ASP.NET** | Attribute-routed controllers, minimal APIs (including `MapGroup`) | `HttpClient` (and its JSON extensions), `HttpRequestMessage`, RestSharp, Refit |
| **Any language** | OpenAPI 3 and Swagger 2 specs | |

| Repo facts | From |
|---|---|
| Build and test | `package.json`, `package-lock.json` / `pnpm-lock.yaml` / `yarn.lock` / `bun.lock`, `.sln`, `.slnx`, `.csproj` |
| Owners | `CODEOWNERS` |
| Summary | Root `README.md` |

Every other file still counts towards the repo's file and language inventory. Files under
`node_modules`, `vendor` and test-fixture folders are not treated as the repo's own manifests.

## What it can't do yet

- **Other languages' seams:** Python, Java, Go and PHP are inventoried and flagged as
  `not extracted`, but their routes and calls aren't read yet.
- **Other kinds of link:** only HTTP. Message queues, events and gRPC are not linked.
- **Symbol-level questions** ("who calls this method?"): phase 3b, symbol maps.
- **Search and full documents:** `brain_search` and `brain_get` are planned.
- **Curated knowledge:** glossary, ADRs, confirmed owners and purposes come in phase 4.
- **Generated wiki pages:** phase 5.
- **Running anything:** commands are reported as the repo declares them and never run.
- **Some routes are skipped on purpose:** conventionally routed MVC actions (the route table
  isn't in the file), and calls whose URL is built at run time (counted instead).
- **Hosting:** today it runs on your machine against your local clones. Hosted (Azure,
  GitHub-backed permissions, webhooks) is phase 6.

## Quick start

Requires Node 22.13 or later (for the built-in `node:sqlite`, so there are no native builds) and
git on `PATH`.

```
npm ci
npm run check                                        # typecheck + tests
npm run brain -- repo add ..\some-repo               # enrol a local clone
npm run brain -- sync                                # index it
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

- *How do I run the tests in aspnet-api?*
- *Who owns orders-api, and what calls it?*
- *If I change `GET /articles/:slug` in express-api, what else breaks?*
- *What would break if I removed the DELETE endpoint in ArticlesController?*

Start a new session after the brain changes, so it picks up new tool descriptions.

## Commands

Run from this folder with `npm run brain -- <command>`, or from anywhere with
`node <path-to>\brain-concept\bin\brain.mjs <command>`. The `card`, `consumers` and `impact`
commands print exactly what an agent gets over MCP.

| Command | Does |
|---|---|
| `repo add <path> [--name n] [--ref ref]` | Enrol a local clone. The name defaults to the folder; the ref defaults to what `origin/HEAD` points at (usually `origin/main`), or the checked-out branch if there is no remote. |
| `repo list` | Enrolled repos, the commit each is indexed at, and how far behind it is. |
| `repo set-ref <name> <ref>` | Index a different branch, e.g. `origin/release`. Updates the repo's hook if it has one. |
| `repo remove <name>` | Remove a repo, every fact about it, and its hook. |
| `sync [<name>]` | Index the tracked branch's committed tree (never your working copy). All repos if no name. |
| `hooks install [<name>]` | Re-sync automatically whenever the tracked branch moves. All repos if no name. |
| `hooks remove [<name>]` / `hooks status` | Stop automatic syncing / see which repos sync automatically, or why one can't. |
| `card <name> [--detailed]` | `brain_repo_card`. `--detailed` adds every script with its command and line, and a language table. |
| `consumers "<METHOD /path>" [--detailed]` | `brain_find_consumers`. |
| `impact <repo> [--path file] [--route "<METHOD /path>"] [--detailed]` | `brain_impact`. |

The store lives at `%USERPROFILE%\.brain\brain.db`. Set `BRAIN_DB` to use a different file, for
example a throwaway one while testing.

## Keeping it fresh

`brain hooks install` puts a git `reference-transaction` hook in each enrolled repo. When the
tracked ref moves, including on a plain `git fetch`, which has no hook of its own, it starts
`brain sync <name>` in the background and returns at once, so git is never slowed down. Runs are
logged to `%USERPROFILE%\.brain\hooks.log`. Read it with `-Encoding utf8` in Windows PowerShell.

This works with any remote, not just GitHub. "Up to date" means "as of the last fetch".

The hook won't be installed if the repo already has its own `reference-transaction` hook, or if
`core.hooksPath` points inside the repo (as husky does), because that would change tracked files.
`hooks status` says why. In that case, run `brain sync <name>` from your own hook manager.

Hooks run whichever brain code is checked out in this folder.

## Testing

- `npm run check`: typecheck and the full test suite. Each test builds its own throwaway git
  repos from `test/fixtures/`.
- [`docs/manual-testing.md`](docs/manual-testing.md): try every feature by hand. It covers a
  playground built from real repos with a local stand-in for GitHub (git commands only, nothing
  added to this project), real open-source repos, and checks that Claude Code uses the brain
  unprompted. Run it before merging changes to what the brain extracts or answers.

## Where it's going

| Phase | | Status |
|---|---|---|
| 0 | Walking skeleton: enrol, sync, repo card over MCP | ✅ |
| 1 | Seam graph: HTTP routes and calls in TS/JS, C# and OpenAPI; `brain_find_consumers`, `brain_impact` | ✅ |
| | Auto-sync through a git hook | ✅ |
| 3a | Richer repo cards: build, test, owners, summary, neighbours | ✅ |
| 2 | Evals proving the harness does better with the brain | Waiting on the decision to integrate with the harness |
| 3b | Symbol maps: symbol-level impact, `brain_get` | Next |
| 4 | Curated context: glossary, ADRs, confirmed owners and purposes (human-reviewed) | Planned |
| 5 | Deep wiki pages: generated, cited and checked (llm-generated) | Planned |
| 6 | Hosted on Azure: Postgres, GitHub App webhooks, per-user permissions | Planned |

Read [`docs/architecture.md`](docs/architecture.md) for the design,
[`docs/research.md`](docs/research.md) for the evidence behind it, and
[`docs/decisions.md`](docs/decisions.md) for every dated decision.

## Layout

```
bin/            launchers that run the TypeScript from any folder
src/core/       types, git access, language detection, HTTP path matching
src/store/      Store interface, SQLite implementation, migrations
src/ingest/     registry, sync, hooks, extractor plugins and fact readers (the write side)
src/serve/      access policy, freshness, tools, MCP server (the read side)
test/           vitest; fixtures are real files in their own languages
docs/           architecture, research, decisions, manual testing
```
