# Manual testing

`npm run check` proves the code does what the tests say. This guide proves the brain works the
way a person and an agent will use it: real git operations, real repositories, real Claude Code
sessions. Run it before merging anything that changes what the brain extracts or answers.

There are three parts:

- **Part A** builds a playground from real repos, with a local stand-in for GitHub, and drives
  auto-sync, wiki updates, repo cards and neighbours through pushes and fetches.
- **Part B** checks every tool against real open-source repos.
- **Part C** checks Claude Code reaches for the brain on its own.

Run every `npm run brain -- …` command from the brain-concept folder, and stay on one branch
throughout. Background syncs run whatever brain code is checked out.

## Before you start: the test repos

The RealWorld ("Conduit") apps are many frontends and backends built against one API, so they
make ready-made cross-repo test data. eShop is a larger .NET system. Clone them once, into a
folder outside this project:

```
cd C:\Users\<you>\Repos
mkdir brain-test-repos
git clone https://github.com/gothinkster/node-express-realworld-example-app brain-test-repos\node-express-realworld-example-app
git clone https://github.com/gothinkster/react-redux-realworld-example-app brain-test-repos\react-redux-realworld-example-app
git clone https://github.com/gothinkster/aspnetcore-realworld-example-app brain-test-repos\aspnetcore-realworld-example-app
git clone https://github.com/dotnet/eShop brain-test-repos\eShop
git clone https://github.com/gothinkster/laravel-realworld-example-app brain-test-repos\laravel-realworld-example-app
git clone https://github.com/gothinkster/flask-realworld-example-app brain-test-repos\flask-realworld-example-app
```

## Part A: the playground

### Why this works without GitHub

Auto-sync is a git hook, not a GitHub feature. It fires whenever the branch a clone tracks
(`origin/master` here) moves, which a fetch or pull from *any* remote does. A **bare** repo is
exactly what GitHub stores on its side, so a local bare repo can stand in for GitHub. Clones push
to it and fetch from it the same way.

### Build it

The playground lives outside this project and uses its own brain store, so it can't touch your
real one. Keep the same PowerShell window open from here to the end of Part A: the `$env:BRAIN_DB`
setting only lasts for that window. Hooks installed while it is set remember it.

```
$T = "C:\Users\<you>\Repos\brain-test-repos"
$P = "C:\Users\<you>\Repos\brain-playground"
$env:BRAIN_DB = "$env:USERPROFILE\.brain\playground.db"

git clone --bare $T\aspnetcore-realworld-example-app $P\origin\aspnet-api.git
git clone --bare $T\react-redux-realworld-example-app $P\origin\react-web.git

git clone $P\origin\aspnet-api.git $P\aspnet-api
git clone $P\origin\react-web.git $P\react-web
git clone $P\origin\aspnet-api.git $P\teammate\aspnet-api
git clone $P\origin\react-web.git $P\teammate\react-web
```

| Folder | Plays the part of |
|---|---|
| `origin\` | GitHub |
| `aspnet-api\`, `react-web\` | Your clones: the C# API and the React site that calls it |
| `teammate\aspnet-api\`, `teammate\react-web\` | A colleague's clones. Change, commit and push from here |

### A1. Enrol, sync and turn on auto-sync

```
npm run brain -- repo add $P\aspnet-api --name pg-aspnet-api
npm run brain -- repo add $P\react-web --name pg-react-web
npm run brain -- sync
npm run brain -- hooks install
npm run brain -- hooks status
```

**Expect:**
- both repos say `tracking origin/master`. The brain describes what has been merged, not your
  local branch;
- `hooks status` says `syncs automatically` for both.

### A2. Repo cards and the wiki

```
npm run brain -- card pg-aspnet-api
npm run brain -- card pg-react-web
```

**pg-aspnet-api:**

| Line | Shows |
|---|---|
| `Wiki: not generated yet (brain wiki pg-aspnet-api)` | No wiki yet |
| `Seams: 19 routes, 0 calls via cs-routes` | Routes from the controllers |
| `Called by: pg-react-web (22 calls)` | Neighbours, from the seam graph |

**pg-react-web:**
- `Calls: pg-aspnet-api (19 endpoints)`.
- `(+4 with run-time URLs)`: calls inside the superagent wrapper whose URL is only known at run
  time, counted, never guessed.

Now have Claude Code write the API's wiki. It takes 1–3 minutes and uses your Claude Code
allowance, about $0.65:

```
npm run brain -- wiki pg-aspnet-api
npm run brain -- page pg-aspnet-api
npm run brain -- page pg-aspnet-api build-run-test
npm run brain -- card pg-aspnet-api
git -C $P\aspnet-api worktree list
```

**Expect:**
- `pg-aspnet-api: wiki written at @a397d11 · $… · …s`, then one line per page such as
  `build-run-test  19/22 claims kept · published`, with up to three `removed: … ` lines saying
  why. Read the removed claims. Each should be a real problem (the named thing isn't in the
  cited lines, a missing file, an over-broad span), not the checker being too strict;
- the page list stamped `@a397d11 · up to date · llm-generated`;
- each page's header ending `citations checked: N of M claims kept`;
- a build page that names `build/build.csproj`, the Bullseye targets and
  `dotnet build Conduit.slnx`, each with `[path:lines]` citations. Open two or three citations
  and check they say what the sentence claims;
- the card now says `Wiki: 4 pages (…) · read with brain_get`;
- `worktree list` shows one line: the temporary worktree Claude Code ran in was removed.

### A3. A teammate pushes, you fetch, and the brain updates itself

As the teammate, add a new endpoint. Open `$P\teammate\aspnet-api\src\Conduit\Features\Articles\ArticlesController.cs` and add this
just above the final `}`:

```csharp
    [HttpPost("{slug}/archive")]
    public IActionResult Archive(string slug) => NoContent();
```

Commit and push as the teammate:

```
git -C $P\teammate\aspnet-api commit -am "Add archive"
git -C $P\teammate\aspnet-api push
npm run brain -- repo list
```

**Expect** pg-aspnet-api still on `@a397d11` and still `up to date`. Your clone hasn't heard
about the push, so "up to date" means "as of your last fetch". An editor's auto-fetch closes the
gap.

Now fetch, and nothing else:

```
git -C $P\aspnet-api fetch
```

Wait two or three seconds:

```
npm run brain -- card pg-aspnet-api
```

**Expect:**
- a new commit;
- `Seams: 20 routes`;
- `Wiki: 4 pages (…) · read with brain_get · written at @a397d11, older than the index`. The sync
  is done; the wiki update is still running in the background.

Now give the wiki update about a minute, then look again:

```
Get-Content $env:USERPROFILE\.brain\hooks.log -Tail 8 -Encoding utf8
npm run brain -- card pg-aspnet-api
npm run brain -- page pg-aspnet-api api
```

**Expect:**
- in the log, `pg-aspnet-api: wiki updated at @… · $… · …s`, one line for each page that cites
  `ArticlesController.cs` (at least `api`), and `unchanged, moved to @…:` listing the rest. Only
  the pages a change affects go back to Claude Code; the others are re-checked and moved forward
  with no AI;
- the card's wiki line without the "older than the index" note;
- the API page mentioning the new `POST …/archive` route, cited to `ArticlesController.cs`.

Nobody ran `sync` or `wiki`.

### A4. A change in one repo updates another repo's card

As the teammate, call the new endpoint from the website. Open `$P\teammate\react-web\src\agent.js`
and find the end of the `Articles` object:

```js
  create: article =>
    requests.post('/articles', { article })
};
```

Change it to:

```js
  create: article =>
    requests.post('/articles', { article }),
  archive: slug =>
    requests.post(`/articles/${slug}/archive`)
};
```

Push it, then fetch the *website* and look at the *API*:

```
git -C $P\teammate\react-web commit -am "Archive button"
git -C $P\teammate\react-web push
git -C $P\react-web fetch
npm run brain -- card pg-aspnet-api
npm run brain -- impact pg-aspnet-api --route "POST /articles/{slug}/archive"
```

**Expect:**
- `Called by: pg-react-web (23 calls)`, up from 22;
- the impact answer lists `← pg-react-web · src/agent.js:70` under the archive route.

Neighbours are worked out on each request, so they follow whichever repo changed.

### A5. Your unpushed work is ignored

```
Add-Content $P\aspnet-api\readme.md 'Local note'
git -C $P\aspnet-api commit -am "local only"
npm run brain -- repo list
```

**Expect** pg-aspnet-api on the same commit as A3: your local `master` moved, `origin/master`
didn't.

### A6. Removed code takes its seams with it

As the teammate, delete the archive endpoint you added in A3, then commit, push and fetch:

```
git -C $P\teammate\aspnet-api commit -am "Remove archive"
git -C $P\teammate\aspnet-api push
git -C $P\aspnet-api fetch
npm run brain -- card pg-aspnet-api
npm run brain -- impact pg-aspnet-api --route "POST /articles/{slug}/archive"
```

**Expect** `Seams: 19 routes` again, and `No matching routes are declared in pg-aspnet-api.`
A minute later, `npm run brain -- page pg-aspnet-api api` no longer mentions the archive route.

### A7. The hook's log

```
Get-Content $env:USERPROFILE\.brain\hooks.log -Tail 6 -Encoding utf8
```

**Expect** two lines per fetch, for example `pg-aspnet-api: refs/remotes/origin/master moved`
and `pg-aspnet-api: a397d11 -> 067d67b (+1 ~1 -0, 113 unchanged; 1 files with seams)`, followed
by the wiki update for repos that have a wiki (pg-react-web has none, so it never calls the AI).
There should be no errors. If two fetches land close together, the second is folded into one
more pass of the run already going. On Windows the log can then miss the second "moved" line,
but the last sync line always shows the newest commit.

### A8. Track another branch

```
git -C $P\aspnet-api push origin master:release
git -C $P\aspnet-api fetch
npm run brain -- repo set-ref pg-aspnet-api origin/release
npm run brain -- sync pg-aspnet-api
```

**Expect** `Its hook now watches origin/release.` The sync picks up the A5 commit, which is now on
`release`.

### A9. Clean up

```
npm run brain -- repo remove pg-aspnet-api
npm run brain -- repo remove pg-react-web
Remove-Item $env:BRAIN_DB
Remove-Item Env:BRAIN_DB
Remove-Item -Recurse -Force $P
```

`repo remove` deletes everything the brain holds about the repo (its wiki included) and its hook. Clearing `BRAIN_DB` points the CLI back at
your real store.

## Part B: real repositories

Use your real store; make sure `$env:BRAIN_DB` isn't set. Enrol the test repos, and the harness
too if you have it:

```
npm run brain -- repo add $T\node-express-realworld-example-app --name express-api
npm run brain -- repo add $T\react-redux-realworld-example-app --name react-web
npm run brain -- repo add $T\aspnetcore-realworld-example-app --name aspnet-api
npm run brain -- repo add $T\eShop --name eshop
npm run brain -- repo add $T\laravel-realworld-example-app --name laravel-api
npm run brain -- repo add $T\flask-realworld-example-app --name flask-api
npm run brain -- repo add ..\citation-harness-library
npm run brain -- sync
npm run brain -- hooks install
```

| Command | Expect |
|---|---|
| `wiki laravel-api`, then `page laravel-api api` | Four pages for a PHP repo the parsers can't read; the API page lists the RealWorld endpoints, each cited to `routes/api.php`, including `GET articles/{article}` and the other routes `Route::resource` declares without naming |
| `wiki flask-api`, then `page flask-api api` | The same for Python: blueprints in `conduit/*/views.py`, `JWT_HEADER_TYPE = 'Token'` cited to `conduit/settings.py` |
| `card aspnet-api` | `Wiki: 4 pages (…)` once generated; `Seams: 19 routes`; `Called by: react-web (22 calls)` |
| `card react-web` | `22 calls (+4 with run-time URLs)`; `Calls: aspnet-api (19 endpoints) · express-api (19 endpoints)` |
| `card express-api` | `Called by: react-web` and **not** eshop. Both serve or call `/`, which says nothing about which service is meant |
| `card eshop` | `dotnet build eShop.slnx` (not the nested `ClientApp.sln`); `28 projects (8 web, 2 app, 9 library, 9 test)`; the root package.json's Playwright scripts |
| `card citation-harness-library` | `Seams: none found · not extracted: Python` |
| `consumers "GET /api/articles/:slug"` | Two servers (the C# `ArticlesController` and the Express controller) and one caller, `react-web · src/agent.js:62`, all marked `suffix` because `/api` is a base path neither declares |
| `consumers "DELETE /profiles/{username}/follow"` | A method filter: two servers, one caller |
| `impact aspnet-api --path src/Conduit/Features/Articles/ArticlesController.cs` | 6 routes and 9 callers, all in `react-web · src/agent.js` |
| `impact eshop --route "GET /api/catalog/items/{id}"` | One route from the minimal API, with the two OpenAPI specs listed as "also declared in", and the functional tests as callers |
| `card nope` | `No readable repo named "nope"`, listing only the repos you enrolled |
| `sync` (run it twice) | The second run says `+0 ~0 -0`: unchanged files are skipped |

## Part C: Claude Code uses the brain on its own

Register the server once (see the README), then start a **new** session. A new one picks up
changes to the server's instructions. Ask in plain words, without naming tools:

| Ask | It should |
|---|---|
| *How do I run the tests in aspnet-api?* | call `brain_repo_card`, then `brain_get` for `build-run-test`, and answer from the page (seen on 2026-10-05, with no file or web searches) |
| *How does laravel-api handle authentication?* | call `brain_get` and answer from the wiki, citing the PHP code |
| *What talks to express-api?* | call `brain_repo_card` and name react-web |
| *If I change GET /articles/:slug in express-api, what else breaks?* | call `brain_find_consumers` or `brain_impact` and point at `react-web · src/agent.js` |
| *What would break if I removed the DELETE endpoint in aspnet-api's ArticlesController?* | call `brain_impact` |

If it searches the web, greps folders or clones instead, note the exact wording. That is how the
server instructions in `src/serve/mcp.ts` get improved.
