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
throughout. Background syncs run whatever brain code is checked out. Start with
`npm run brain -- doctor`: it should show ✓ for Node, git, Claude Code and the MCP server.

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

### A1. Enrol and sync

`sync` indexes each repo, then has Claude Code map its routes and calls and write its wiki. For
these two repos that takes about 5–8 minutes and $2–3 of your Claude Code allowance.

```
npm run brain -- repo add $P\aspnet-api --name pg-aspnet-api
npm run brain -- repo add $P\react-web --name pg-react-web
npm run brain -- sync
```

**Expect,** for each repo:
- `tracking origin/master` when enrolled. The brain describes what has been merged, not your local
  branch;
- an index line, then `routes and calls mapped at @… · N routes, M calls · $… · …s`, with any
  `dropped:` lines saying why (there should be none or very few; read each one);
- `wiki written at @… · $… · …s`, then one line per page such as
  `build-run-test  19/22 claims kept · published`, with up to three `removed: … ` lines saying
  why. Read the removed claims. Each should be a real problem (the named thing isn't in the
  cited lines, a missing file, an over-broad span), not the checker being too strict.

Then turn on auto-sync:

```
npm run brain -- hooks install
npm run brain -- hooks status
```

**Expect** `syncs automatically` for both.

### A2. Repo cards and the wiki

```
npm run brain -- card pg-aspnet-api
npm run brain -- card pg-react-web
```

**pg-aspnet-api:**

| Line | Shows |
|---|---|
| `Wiki: 4 pages (…) · read with brain_get` | The wiki Claude Code wrote |
| `Seams: about 20 routes, 1 call · llm-generated` | The RealWorld routes under the global `/api` prefix, plus the Swagger endpoint; the call is a `curl` in the Makefile |
| `Called by: pg-react-web (… calls)` | Neighbours, from the seam graph |

**pg-react-web:**
- `Calls: pg-aspnet-api (… endpoints)`: the site's calls, with the `API_ROOT` base URL resolved,
  match the API's routes exactly rather than as a suffix.

Look closer at one route and one page:

```
npm run brain -- impact pg-aspnet-api --route "GET /api/articles/{slug}" --detailed
npm run brain -- page pg-aspnet-api
npm run brain -- page pg-aspnet-api build-run-test
git -C $P\aspnet-api worktree list
```

**Expect:**
- the route's callers, and `path built with …` naming the lines its `/api` prefix and controller
  route come from. Open them and check;
  `build-run-test  19/22 claims kept · published`, with up to three `removed: … ` lines saying
  why. Read the removed claims. Each should be a real problem (the named thing isn't in the
  cited lines, a missing file, an over-broad span), not the checker being too strict;
- the page list stamped `@a397d11 · up to date · llm-generated`;
- each page's header ending `citations checked: N of M claims kept`;
- a build page that names `build/build.csproj`, the Bullseye targets and
  `dotnet build Conduit.slnx`, each with `[path:lines]` citations. Open two or three citations
  and check they say what the sentence claims;
- `worktree list` shows one line: the temporary worktree Claude Code ran in was removed.

Then search across both repos:

```
npm run brain -- search "favorite an article"
npm run brain -- search "favorite an article" --repo pg-react-web --detailed
```

**Expect:**
- sections from both wikis, each as `repo · page › heading` with a snippet that has no
  `[path:lines]` citations in it;
- an `Endpoints:` list with `POST /api/articles/{slug}/favorite` as a route in pg-aspnet-api and a
  call in pg-react-web;
- with `--repo pg-react-web`, nothing from pg-aspnet-api. `--detailed` adds each section's page
  title and the files it cites.

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
- `Seams: … · mapped at @a397d11, older than the index` and the same for the wiki. The index is
  done; Claude Code is still updating the routes and the wiki in the background.

Give it a minute or two, then look again:

```
Get-Content $env:USERPROFILE\.brain\hooks.log -Tail 12 -Encoding utf8
npm run brain -- card pg-aspnet-api
npm run brain -- impact pg-aspnet-api --route "POST /api/articles/{slug}/archive" --detailed
npm run brain -- page pg-aspnet-api api
```

**Expect:**
- in the log, `routes and calls updated in 1 file at @…` (only `ArticlesController.cs` was mapped
  again, for a few cents), then `wiki updated at @…` with one line for each page that cites
  `ArticlesController.cs` (at least `api`) and `unchanged, moved to @…:` listing the rest. The
  wiki line comes a minute or two after the routes line; read the log again if it isn't there yet;
- the card with one more route and no "older than the index" notes;
- the impact answer listing the archive route at `ArticlesController.cs` and its line (without
  `--detailed`, a route nobody calls yet only appears in the "No known callers" line);
- the API page mentioning the new `POST …/archive` route, cited to `ArticlesController.cs`.

Nobody ran `sync` or `wiki`, and no parser knows this repo's framework: Claude Code found the
route and the brain checked it against the cited lines.

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
npm run brain -- impact pg-aspnet-api --route "POST /api/articles/{slug}/archive"
```

Give the website's update a minute first (`hooks.log` shows `routes and calls updated in 1 file`).

**Expect:**
- `Called by: pg-react-web (… calls)`, one more than in A2;
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
npm run brain -- impact pg-aspnet-api --route "POST /api/articles/{slug}/archive"
```

**Expect,** after a minute or two: the card's route count back to what A2 showed, `No matching
routes are declared in pg-aspnet-api.`, and `npm run brain -- page pg-aspnet-api api` no longer
mentioning the archive route.

### A7. The hook's log

```
Get-Content $env:USERPROFILE\.brain\hooks.log -Tail 6 -Encoding utf8
```

**Expect** for each fetch: `pg-aspnet-api: refs/remotes/origin/master moved`, the index line
(`pg-aspnet-api: a397d11 -> 067d67b (+0 ~1 -0, 113 unchanged)`), then the routes-and-calls and
wiki updates. A fetch that only changed Markdown says `no code changed (no AI run)` for the
routes. There should be no errors. If two fetches land close together, the second is folded into one
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

The first `sync` maps each repo's links (routes and calls in one run, events, gRPC and packages
in another alongside it) and writes its wiki: about 30–40 minutes and $15–20 in all, most of it
eshop (about $5–6 and 5–14 minutes for its links alone). Read any `dropped:` and `removed:` lines
it prints. To re-check link mapping later without rewriting wikis, use
`npm run brain -- sync <name> --full --only links`.

| Command | Expect |
|---|---|
| `page laravel-api api` | A PHP repo's API page listing the RealWorld endpoints, each cited to `routes/api.php`, including `GET articles/{article}` and the other routes `Route::resource` declares without naming |
| `page flask-api api` | The same for Python: blueprints in `conduit/*/views.py`, `JWT_HEADER_TYPE = 'Token'` cited to `conduit/settings.py` |
| `card aspnet-api` | `Seams: 20 routes, 1 call · llm-generated` (the RealWorld routes under `/api`, the Swagger endpoint, a `curl` in the Makefile); `Called by: react-web (22 calls)` |
| `card react-web` | `0 routes, 22 calls`; `Calls: aspnet-api (19 endpoints) · express-api (19 endpoints) · flask-api (19 endpoints) · laravel-api (19 endpoints)`: one front end, four backends in four languages |
| `card laravel-api` | `22 routes, 78 calls` (its tests call its own API); `Called by: react-web (22 calls)` and **not** the other backends, whose tests call the same paths but serve them too |
| `card express-api` | `Called by: react-web` and **not** eshop. Both serve or call `/`, which says nothing about which service is meant |
| `card eshop` | `Seams:` about 75–85 routes and 55–105 calls (the call count is call sites, and varies with how many test calls a run lists): the APIs, health checks, Identity's MVC routes and Blazor pages, and the clients calling them |
| `card citation-harness-library` | Its seams (likely none: it serves no HTTP) and its wiki |
| `consumers "GET /api/articles/:slug"` | Four servers (C#, TypeScript, Python, PHP) at their declaring lines, `react-web · src/agent.js:61-62` as the caller, then Laravel's own tests marked `same repo` |
| `consumers "GET /api/profiles/:username" --detailed` | `path built with …` on each: aspnet's `Program.cs` prefix convention, Express's `routes.ts` mount, Laravel's `RouteServiceProvider` group |
| `consumers "DELETE /api/profiles/{username}/follow"` | A method filter: four servers; react-web's call (written `requests.del(…)`) among the callers |
| `impact aspnet-api --path src/Conduit/Features/Articles/ArticlesController.cs` | 6 routes and 9 callers, all in `react-web · src/agent.js` |
| `impact eshop --route "GET /api/catalog/items/{id}"` | The minimal API route in `CatalogApi.cs`, with the three client `CatalogService.cs` files and the functional tests as `same repo` callers |
| `consumers "event OrderStartedIntegrationEvent"` | Published by `src/Ordering.API/Application/Commands/CreateOrderCommandHandler.cs`; handled by Basket.API's subscription in `src/Basket.API/Extensions/Extensions.cs`, marked `same repo` (eShop is one repo with many services) |
| `consumers "event OrderStarted"` | No match (names match exactly), and a line naming `OrderStartedIntegrationEvent` as a known event |
| `consumers "grpc Basket/GetBasket"` | Served in `src/Basket.API/Proto/basket.proto` (or `Grpc/BasketService.cs`), called from `src/WebApp/Services/BasketService.cs` and usually `src/ClientApp/Services/Basket/BasketService.cs` (a run can miss the second), `same repo` |
| `impact eshop --path src/Ordering.API/Application/Commands/CreateOrderCommandHandler.cs` | `1 event published` with Basket.API's handler as a `same repo` caller |
| `card eshop` | The seams line also counts `events: … published, … handled` and `gRPC: … served, … called` |
| `card react-web`, `card aspnet-api` | No events, gRPC or packages, and no new neighbours: the RealWorld repos only meet over HTTP |
| `search "how do I run the tests"` | `build-run-test` sections from several repos at the top, e.g. the harness's `Test` and eshop's `End-to-end tests (Playwright)` |
| `search "where are orders cancelled"` | eshop's Ordering sections first, and `PUT /api/orders/cancel` as a route in `src/Ordering.API/Apis/OrdersApi.cs` |
| `search "kafka"` | `No wiki sections or endpoints match "kafka" in 7 repos.` |
| `card nope` | `No readable repo named "nope"`, listing only the repos you enrolled |
| `doctor` | ✓ on every line, including a `Hook:` line per repo saying it syncs automatically |
| `page aspnet-api product` | A product page with no code names in its text: who uses it, what they can do, business rules such as "an email address can belong to only one account" cited to `src/Conduit/Features/Users/Create.cs:48-64`, terms, what it depends on |
| `card react-web` | A `Product:` line under the header (the product page's first sentence), and a `System:` line once systems exist |
| `systems suggest`, then `systems` | Three suggestions, each with a reason: RealWorld (the four APIs and react-web), eShop alone, the harness alone. About $0.10–0.20 |
| `systems show RealWorld` | Its summary, a line per repo from its product page, `react-web → aspnet-api, express-api, flask-api, laravel-api (19 endpoints each)`, and "Not yet confirmed" until `systems confirm --all` |
| `search "blogging platform"` | RealWorld listed under `Systems:` before the wiki sections |
| `impact --work "notify buyers when an order ships"` | eShop's Ordering sections and `PUT /api/orders/ship`; the harness at most as a weaker match |
| `impact --work "save articles to read later"` | RealWorld repos, with `+ react-web calls … of these routes` under each API listed |
| `sync` (run it twice) | The second run says `+0 ~0 -0`, `no code changed (no AI run)` and `wiki up to date`: nothing is redone and nothing is spent |

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
| *Who handles OrderStartedIntegrationEvent in eshop, and what happens if I rename it?* | call `brain_find_consumers` with `event OrderStartedIntegrationEvent` and name the Basket.API handler |
| *Where do we validate JWTs?* (no repo named) | call `brain_search`, then `brain_get` on the best section's page |
| *What can users do in RealWorld, and what rules apply to profiles?* | call `brain_get` with `system` and the `product` pages, and answer without reading code or technical pages |
| *Which repos would "add discount codes to the basket" touch?* | call `brain_impact` with `work` and name eshop's Basket |

If it searches the web, greps folders or clones instead, note the exact wording. That is how the
server instructions in `src/serve/mcp.ts` get improved.

## Part D: facts from people (B3)

None of this runs Claude Code in the background, so it costs nothing beyond the session itself.

1. **Record a fact in a conversation.** In a new Claude Code session, run a short PO-style brief:
   *"For RealWorld, users should only be able to follow up to 500 authors; people were
   bulk-following. Can the brain remember that?"* The agent should call `brain_record_fact`.
   Claude Code first asks permission for the tool (every time, by design). Then a dialog shows
   the fact, your name, and what the product pages already say about following. Accept it,
   editing the wording if you like.
2. **See it used.** In another new session, ask *"What limits apply to following in RealWorld?"*
   The answer should quote your fact as human-reviewed, with your name and the date, ahead of
   anything AI-written.
3. **Decline one.** Ask it to record something and decline the dialog. `npm run brain -- facts`
   shouldn't list it.
4. **See it from the command line:**

| Command | Expect |
|---|---|
| `facts` | The fact under the repo or system it was recorded on, `human-reviewed`, with your name and `fact #1` |
| `page react-web product` | `## From people` above the AI-written page, holding the fact (also when it was recorded on the RealWorld system) |
| `card react-web` | `Facts from people: 1 confirmed by people · at the top of its product page` |
| `search "follow limit"` | `From people:` first, with the fact |
| `systems show RealWorld` | The fact under `From people` |

5. **Staleness, in the playground from Part A** (with its `$env:BRAIN_DB` set). Anchor a fact
   to the line that serves one article:
   `npm run brain -- facts add aspnet-api --kind rule --text "Anyone can read an article without signing in." --anchor src/Conduit/Features/Articles/ArticlesController.cs:39`.
   In `teammate\aspnet-api`, add a comment line at the top of that file, commit and push; fetch in
   `aspnet-api`. `facts aspnet-api` shows the anchor moved to line 40. Then change line 40 itself
   and push again: the sync prints `code under 1 fact from people changed`, and the fact shows
   `stale`. `facts confirm <id>` clears it.
6. **Replacing a fact.** In a new session, state a change in passing: *"I'm planning a change to
   RealWorld: users should be capped at 1000 authors. What would this touch?"* The agent should
   point out the recorded 500 rule and offer to replace it. Say yes: the dialog (or, in the
   desktop app, a proposal) says it replaces fact #1. After confirming, `facts` lists only the
   1000 rule, and `facts --all` shows the 500 one as retired.
7. **Checked against the code.** `facts check RealWorld` runs one Claude Code check per repo
   (cents each). Then `facts`: a rule the code enforces says `code agrees`, the follow cap says
   `not in the code of …` for the APIs, and a rule the code breaks says `code contradicts it`
   with the lines. Run it again: it says nothing changed and runs no AI.
8. **Gaps.** Search for something no repo covers (`search "refund policy"`), then run `gaps`. It
   should list the search with a count.
9. **The desktop app.** In the Code tab of the desktop app (tried 2026-10-12), the permission
   prompt appears but the confirm dialog doesn't: it comes back declined at once. The agent
   should say the dialog was most likely never shown, and offer to save it as proposed. Say yes;
   `facts` lists it as proposed, and `facts confirm <id>` confirms it.

## Part E: wikis that fit the repo (B4a)

Use a copy of your store (`$env:BRAIN_DB` pointing at it) so a bad plan doesn't replace a good
wiki. These steps run Claude Code: about $4–6 for eShop, under $1 for a small repo.

1. **A large repo is planned.** `wiki plan eshop` says it's large and not planned yet. Run
   `sync eshop --only wiki`. The output opens with `wiki planned (no plan yet): +N pages (…)`,
   then a line per new page. The five pages it had are kept, not rewritten. `wiki plan eshop`
   lists the plan: core pages, a page per service, a few flows, data model and integrations,
   each with what it covers.
2. **Read it as an agent would.** `page eshop` groups the pages by kind with one line each;
   `card eshop` counts them by kind. `page eshop <a flow page>` gives numbered, cited steps and
   says its diagrams are left out. Check a few citations by opening the files.
3. **A small repo isn't.** `wiki plan laravel-api` says it's small. `sync laravel-api --only wiki
   --full` makes one run, with no planning, and adds at most a data-model and an integrations page.
4. **Lines that only move cost nothing.** In a clone you can commit to, add a comment line at the
   top of a file a page cites, commit, and sync. The wiki line says nothing needed rewriting, and
   the page's citations point one line lower.
5. **New code is planned for.** Add a folder holding a new project (a `package.json` or `.csproj`
   and a source file), commit and sync. The output says `wiki planned (a new project at …)`, and
   only the new page is written.
6. **Steering.** `note eshop "Ordering and Basket matter most"`, then sync: it plans again
   (`the steering note changed`). In a Claude Code session, ask it to make the wiki focus on
   something: it calls `brain_set_note`, and the note is set once you confirm (proposed in the
   desktop app, then `note eshop --confirm`).
7. **Technical-plan questions.** In a new session ask *"Plan adding a delivery date to eShop
   orders, shown to the buyer"*. The answer should come from the overview, the ordering area page,
   a flow page and the data model, with citations and at most a couple of code reads to confirm.

## Part F: following a flow (B4b)

The first trace map of a repo runs inside the links step (about $2–5 for eShop, cents for a small
repo); later syncs cost nothing unless a chain's code changes.

1. **Map it.** `sync eshop --only links`. Besides routes and calls, a line says what each entry
   point leads to was traced: how many checked chains, how many were dropped, and how many exit
   points no entry point was found to reach.
2. **Follow an order.** `consumers "POST /api/orders" --follow`. Expect ordering's handler →
   `OrderStartedIntegrationEvent` → the basket's handler; and the order saved to `orders`, read by
   the grace-period job, carrying on through stock and payment events. Check a few chains against
   the code.
3. **Across repos.** `consumers "POST /api/articles" --follow`: react-web's call, then each
   RealWorld API's handler and the tables it writes.
4. **Nothing changed costs nothing.** Run `sync eshop --only links` again: no trace line, no AI.
5. **In a session.** Ask *"What would changing how orders are created in eShop set off?"* It
   should call `brain_find_consumers` with `follow` and answer without reading code.
