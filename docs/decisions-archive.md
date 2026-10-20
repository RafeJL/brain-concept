# Decisions archive

Superseded decisions, and the long evidence behind some current ones, moved from
[decisions.md](decisions.md) so it lists only what stands. Nothing is deleted. An entry here
is current only where decisions.md says so. Newest last.

## 2026-09-29: phase 1 stacks are OpenAPI, TS/JS and C#/ASP.NET

*Superseded on 2026-10-06: Claude Code finds routes and calls; the parsers were removed.*

OpenAPI/AsyncAPI specs cover the serving side of any backend that publishes one. TS/JS covers
both sides (most frontends are the callers). C#/ASP.NET is the backend stack. Other stacks are
added when an enrolled repo needs them, and repo cards list code languages with no extractor.

## 2026-09-29: tree-sitter through `@vscode/tree-sitter-wasm`

*Superseded on 2026-10-06: Claude Code finds routes and calls; the parsers were removed.*

One package with the WASM runtime and grammars for TS, TSX, JS, C#, Java, Python, PHP and Go,
built and versioned together by the VS Code team. WASM avoids native builds and group policy.

## 2026-09-29: extractor version forces a full re-extract

*Superseded on 2026-10-06: Claude Code finds routes and calls; the parsers were removed.*

`EXTRACTOR_VERSION` is stored per repo. When a plugin changes, bump it; each repo is fully
re-extracted on its next sync instead of mixing old and new rules. This is also how phase 0
databases gain seams.

## 2026-09-29: conventionally routed C# controllers are skipped

*Superseded on 2026-10-06: Claude Code finds routes and calls; the parsers were removed.*

`[HttpGet]` with no template on the action or the class is a verb constraint on a route table
defined elsewhere (`MapControllerRoute`). The path isn't in the file, so no route is emitted.
Found as false `GET /` routes in eShop's Identity `AccountController`.

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

## 2026-10-06: the wiki updates itself, one affected page at a time: superseded parts

Not built, for lack of evidence it's needed: re-planning the page set when a repo's structure
changes (`brain wiki --full` does it by hand), and a separate `--status` command (the page list
marks any page kept from an older commit).

## 2026-10-06: routes and calls come from Claude Code; the parsers are removed: evidence

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

## 2026-10-07: search is keywords over wiki sections and endpoints: evidence

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

## 2026-10-08: the product layer (B2a): product pages, systems, impact from a description: evidence

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

## 2026-10-12: links beyond HTTP: events, gRPC and shared packages: evidence

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

## 2026-10-12: facts from people (B3a): a write tool the person confirms, not the agent: superseded parts

  - **MCP elicitation:** the server asks the person through the client. Claude Code shows a
    dialog with the fact, their name (git `user.name`), and what the brain already says nearby
    (the closest wiki sections and facts, by search, no AI). They accept, edit or decline. The
    answer goes to the server, not through the agent, so an agent can't confirm for them.

  Where no dialog is possible (a client without elicitation, a headless `claude -p` run, such as
  a harness skill), the fact is stored as **proposed**. Agents see it labelled so, and a person
  confirms it with `brain facts confirm`. A decline stores nothing.

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

## 2026-10-13: facts from people are checked against the code (B3b): evidence

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

## 2026-10-13: wikis that fit the repo, and syncs side by side (B4a): evidence

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

## 2026-10-13: following a flow across repos (B4b): evidence

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

## 2026-10-13: everything a person does, through MCP (B5): evidence

**Gate:**
- 231 tests pass.
- **Headless `claude -p`** on a copy of the real store, with `mcp__citation-brain__*` allowed:
  - `brain_record_fact` and `brain_facts` were refused before reaching the server ("MCPTool
    requires permission"), and no fact was written;
  - `brain_review` and `brain_repo_card` answered.

  So the technical-planning stage can read headless, and only a person can write.
- The desktop walkthrough is manual-testing Part G (Rafe).

## 2026-10-13: adding a repo from Claude Code, and a README for setting up (B7): evidence

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
