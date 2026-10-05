# brain-concept

Organisation-wide engineering context for coding agents, served over MCP.

The brain indexes the organisation's repositories and answers narrow questions ("what is this
repo?", "who calls this endpoint?") with small, cited answers. Each answer names the commit
it describes, how far behind the tracked branch that is, and how the fact was made. The
Citation delivery harness calls it; it never moves code out of the harness.

Read [`docs/architecture.md`](docs/architecture.md) first. The evidence behind the design is in
[`docs/research.md`](docs/research.md), and dated decisions in [`docs/decisions.md`](docs/decisions.md).

**Status:** phase 1 (seam graph) and phase 3a (richer repo cards) complete. HTTP routes and calls
are extracted from TS/JS and C#/ASP.NET code and from OpenAPI/Swagger specs. Repo cards say how to
build and test a repo, who owns it, what it says it is and which repos it talks to.
`brain_repo_card`, `brain_find_consumers` and `brain_impact` work over MCP, and enrolled repos
re-sync themselves when their branch moves. Phase 2 (harness evals) waits on the integration
decision.

## Requirements

- Node 22.13 or later (uses the built-in `node:sqlite`, so there are no native builds)
- git on `PATH`

```
npm ci
npm run check        # typecheck + tests
```

The npm scripts call `tsc` and `vitest` through `node` rather than through the `node_modules/.bin`
shims, because group policy on Citation laptops blocks those shims.

## Commands

Run from this folder with `npm run brain -- <command>`, or from anywhere with
`node C:\Users\Rafe.Loveday\Repos\brain-concept\bin\brain.mjs <command>`.

| Command | Does |
|---|---|
| `repo add <path> [--name n] [--ref ref]` | Enrol a local clone. The name defaults to the folder; the ref defaults to what `origin/HEAD` points at (usually `origin/main`, i.e. what has been merged), or the checked-out branch if there is no remote. |
| `repo list` | Enrolled repos, the commit each is indexed at, and how far behind it is. |
| `repo set-ref <name> <ref>` | Index a different ref, e.g. move a repo enrolled on `main` to `origin/main`. |
| `repo remove <name>` | Remove a repo, every fact about it, and its hook. |
| `sync [<name>]` | Index the tracked branch's committed tree (not your working copy). All repos if no name. |
| `hooks install [<name>]` | Re-sync automatically whenever the tracked ref moves: pull, merge, rebase or a plain fetch. All repos if no name. |
| `hooks remove [<name>]` / `hooks status` | Stop automatic syncing / see which repos sync automatically. |
| `card <name> [--detailed]` | Print exactly what an agent gets from `brain_repo_card`: what the repo says it is, how to build and test it, who owns it, and which repos it calls and is called by. |
| `consumers "<METHOD /path>" [--detailed]` | Print what an agent gets from `brain_find_consumers`: who serves and who calls an endpoint. |
| `impact <repo> [--path file] [--route "<METHOD /path>"] [--detailed]` | Print what an agent gets from `brain_impact`: the routes a repo or file serves, and who calls each one. |

The store lives at `%USERPROFILE%\.brain\brain.db`. Set `BRAIN_DB` to use a different file,
for example a throwaway one while testing.

## Keeping it fresh

`brain hooks install` puts a git `reference-transaction` hook in each enrolled repo. When the
tracked ref moves (including on a plain `git fetch`, which has no hook of its own) it starts
`brain sync <name>` in the background and returns straight away, so git is never slowed down.
Runs are logged to `%USERPROFILE%\.brain\hooks.log`. With a repo tracking `origin/main`, your
editor's auto-fetch is enough to keep it current; "up to date" always means "as of the last
fetch".

The hook won't be installed if the repo already has its own `reference-transaction` hook, or if
`core.hooksPath` points inside the repo (as husky does), because it would change tracked files.
`hooks status` says why. Run `brain sync <name>` from your own hook manager instead.

## Use it from Claude Code

Register the MCP server once (user scope, so it is available in every repo):

```
claude mcp add --scope user citation-brain -- node C:\Users\Rafe.Loveday\Repos\brain-concept\bin\brain-mcp.mjs
```

Then, in any Claude Code session, ask something like "use brain_repo_card to tell me about
citation-harness-library". Run `/mcp` to check the server is connected.

## Try it (phase 0 test script)

1. Enrol and index the harness repo:
   ```
   npm run brain -- repo add ..\citation-harness-library
   npm run brain -- sync
   npm run brain -- card citation-harness-library
   ```
   Expect `@<sha> · up to date · parser-built` and a language breakdown led by Markdown.
2. Run `npm run brain -- sync` again. Expect `+0 ~0 -0`, because unchanged files are skipped.
3. Clone a repo in another stack and enrol it:
   ```
   mkdir C:\Users\Rafe.Loveday\Repos\brain-test-repos
   git clone https://github.com/gothinkster/node-express-realworld-example-app C:\Users\Rafe.Loveday\Repos\brain-test-repos\realworld-express
   npm run brain -- repo add C:\Users\Rafe.Loveday\Repos\brain-test-repos\realworld-express
   npm run brain -- sync realworld-express
   npm run brain -- repo list
   ```
4. Staleness: make a commit on `main` in any enrolled test repo. `repo list` should say
   `1 commit behind main` until you sync again.
5. Register the MCP server (above) and ask Claude Code for both repo cards.
6. `npm run brain -- card nope` should list only the repos you enrolled.

## Try it (phase 1a test script)

The RealWorld ("Conduit") apps are many frontends and backends built against one API, so they
make ready-made cross-repo test data.

1. Clone a backend and a frontend and enrol them:
   ```
   git clone https://github.com/gothinkster/node-express-realworld-example-app C:\Users\Rafe.Loveday\Repos\brain-test-repos\node-express-realworld-example-app
   git clone https://github.com/gothinkster/react-redux-realworld-example-app C:\Users\Rafe.Loveday\Repos\brain-test-repos\react-redux-realworld-example-app
   npm run brain -- repo add C:\Users\Rafe.Loveday\Repos\brain-test-repos\node-express-realworld-example-app --name express-api
   npm run brain -- repo add C:\Users\Rafe.Loveday\Repos\brain-test-repos\react-redux-realworld-example-app --name react-web
   npm run brain -- sync
   ```
2. `npm run brain -- card express-api` should say about 20 routes; `card react-web` about 22
   calls, plus 4 with run-time URLs (the superagent wrapper in `src/agent.js`).
3. `npm run brain -- consumers "GET /api/articles/:slug"` should list the Express controller as
   the server and `react-web · src/agent.js:62` as the caller, both marked `suffix` because the
   `/api` base path is not in either repo's route or call.
4. Try a method filter: `consumers "DELETE /profiles/{username}/follow"` should give one server and
   one caller.
5. Start a **new** Claude Code session and ask: *"If I change the GET /articles/:slug endpoint in
   express-api, what else would break?"* It should call `brain_find_consumers`.

## Try it (phase 1b test script: C#)

1. Enrol the ASP.NET RealWorld backend alongside the two repos above:
   ```
   git clone https://github.com/gothinkster/aspnetcore-realworld-example-app C:\Users\Rafe.Loveday\Repos\brain-test-repos\aspnetcore-realworld-example-app
   npm run brain -- repo add C:\Users\Rafe.Loveday\Repos\brain-test-repos\aspnetcore-realworld-example-app --name aspnet-api
   npm run brain -- sync
   ```
   `card aspnet-api` should show 19 routes via cs-routes.
2. `npm run brain -- consumers "GET /api/articles/:slug"` should now list **two** servers
   (the C# `ArticlesController` and the Express controller) for the one React caller. The
   run-time URL note should point at `react-web · src/agent.js:20-26`, the superagent wrapper.
3. `npm run brain -- impact aspnet-api --path src/Conduit/Features/Articles/ArticlesController.cs`
   should list 6 routes and 9 callers, all in `react-web · src/agent.js`.
4. A bigger C# check: clone `https://github.com/dotnet/eShop` into `brain-test-repos`, enrol it
   as `eshop`, sync, and run `impact eshop --route "GET /api/catalog/items/{id}"`. Expect one
   route (from the minimal API, with the two OpenAPI specs listed as "also declared in") and
   the functional tests as callers.
5. In a **new** Claude Code session ask: *"What would break if I removed the DELETE endpoint in
   aspnet-api's ArticlesController?"* It should call `brain_impact` or `brain_find_consumers`.

## Try it (automatic freshness)

1. Repos enrolled before this change track the local branch. Move them to what has been merged:
   ```
   npm run brain -- repo set-ref react-web origin/master
   npm run brain -- repo set-ref express-api origin/master
   npm run brain -- repo set-ref aspnet-api origin/master
   npm run brain -- repo set-ref eshop origin/main
   ```
   (`repo list` shows each repo's branch; RealWorld repos use `master`.)
2. `npm run brain -- hooks install` then `npm run brain -- hooks status`: every repo should say
   `syncs automatically`.
3. Make any commit on a tracked repo's branch, or `git fetch` one that has new commits upstream.
   About a second later `npm run brain -- repo list` shows it at the new commit without a sync,
   and `%USERPROFILE%\.brain\hooks.log` shows the run.
4. A commit on another branch changes nothing.
5. `npm run brain -- hooks remove` takes the hooks out again.

## Try it (phase 3a: richer repo cards)

Run `npm run brain -- sync` first. Existing repos are re-read in full once, because the readers
are new.

1. `npm run brain -- card aspnet-api` should show:
   - `About:` with the README's description;
   - `.NET: dotnet build Conduit.slnx · dotnet test Conduit.slnx · 3 projects (1 web, 1 app, 1 test)`;
   - `Called by: react-web (22 calls)`.
2. `npm run brain -- card eshop` should pick the root `eShop.slnx` over
   `src/ClientApp/ClientApp.sln`, report 9 test projects, and show the root package.json's
   Playwright scripts.
3. `npm run brain -- card react-web` should say `Calls: aspnet-api (19 endpoints) · express-api (19 endpoints)`.
4. `npm run brain -- card citation-harness-library` should show `in evals/: npm run test · npm run typecheck`.
   `--detailed` lists every script with its command and line.
5. `npm run brain -- card express-api` should **not** list eshop as a neighbour. The only link
   between them was both using `/`, which says nothing about which service is meant.
6. In a **new** Claude Code session ask *"how do I run the tests in aspnet-api?"* and *"what
   talks to express-api?"*. Both should call `brain_repo_card`.

## Layout

```
bin/            launchers that run the TypeScript from any folder
src/core/       types, git access, language detection
src/store/      Store interface, SQLite implementation, migrations
src/ingest/     registry, sync, parsing, extractor plugins and fact readers (the write side)
src/serve/      access policy, freshness, tools, MCP server (the read side)
test/           vitest; each test builds its own throwaway git repos
docs/           architecture, research, decisions
```
