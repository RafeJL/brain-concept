# brain-concept

**Add a repo, get a wiki.** The brain gives coding agents (Claude Code, through MCP) context about
every repository you add. Claude Code reads each repo, in any language, and writes wiki pages
in which every sentence cites the lines it is based on. It also maps the HTTP routes each repo
serves and calls, the events it publishes and handles, its gRPC services and its shared
packages, so an agent can see which repos depend on each other. A product page in each wiki,
and systems that group the repos making up one product, let a product owner's agent answer
"what does it do, who uses it, what are the rules, and what would this work touch?" without
reading code. Everything is checked against the code before an agent sees it.

Agents then ask for exactly what they need instead of cloning and reading whole repos:

```
> How do I run the tests in aspnet-api?

  citation-brain - brain_get (repo: aspnet-api, page: build-run-test)

`dotnet run --project build/build.csproj -- test` formats, builds in Release mode, and runs all
test projects — the standard validation command [readme.md:34-38] [AGENTS.md:21-25] …
```

**Status:** a local proof of concept for the Citation delivery harness. It runs on your machine
against your own clones, and uses your own Claude Code.

## Try it in 10 minutes

**You need:**
- Node 22.13 or later;
- git;
- Claude Code, installed and signed in (run `claude` once).

Then, from this folder:

```
npm ci
npm run brain -- doctor
```

`doctor` checks the three tools and whether Claude Code knows about the brain yet, and says how
to fix anything missing. Run the `claude mcp add …` command it prints. That registers the brain
with Claude Code, once, for every folder.

`npm ci` may warn about install scripts. That's harmless: nothing here needs them.

**Add a repo** (any local git clone):

```
npm run brain -- add C:\path\to\some-repo
```

Here is what that does:
1. It indexes the committed code on the repo's main branch. Your uncommitted work is never read.
2. It has Claude Code map the repo's routes and calls and write its wiki. A small repo gets
   about five to seven pages: overview, build and test, API, its most important module, a
   product page (what it does for its users, written for a product owner), and data-model and
   integrations pages where they apply. A large repo gets up to 20, a page per area (see "For
   technical plans"). Before starting, it prints a rough cost from your Claude Code allowance:
   about $0.50–2 for a small repo, up to about $8–12 for one as large as eShop. It takes 2–25
   minutes. Add several at once (`add <path> <path> …`) and they go three at a time.
3. It installs a git hook, so the repo updates itself whenever its branch moves (a pull or a
   fetch). Updates cost cents, and nothing when nothing relevant changed.

**Ask Claude Code.** Start a new session anywhere and ask in plain words. You don't need to name
the brain:
- *What does some-repo do?*
- *How do I run its tests?*
- *Which repos call its endpoints?* (needs two or more repos added)
- *Where do we validate login tokens?* (searches every repo you've added)
- *What can users do in some-repo, and what rules apply?* (answered from its product page)
- *Which repos would "let users save articles to read later" touch?*
- *Users can follow at most 500 authors: record that.* (you confirm it in a dialog; later sessions
  answer with it)

To see exactly what an agent gets, use the same answers from the command line:
`npm run brain -- card some-repo`, `page some-repo`, `search "tokens"`.

**To stop trialling:** `npm run brain -- repo remove some-repo` removes everything the brain holds
about a repo, and its hook. Delete `%USERPROFILE%\.brain` to remove the whole store. Remove the
MCP server with `claude mcp remove citation-brain -s user`.

> **Shortcut:** to type `brain` instead of `npm run brain --`, add this to your PowerShell
> profile (`notepad $PROFILE`):
> `function brain { node C:\path\to\brain-concept\bin\brain.mjs @args }`

## What agents can ask

The MCP server tells Claude Code when to use it. These are its seven tools. Five only read; the
other two record what a person tells them, and only once that person confirms:

| Tool | Answers | From |
|---|---|---|
| `brain_repo_card` | What is this repo for, which system is it part of, which repos does it call and which call it, is there a wiki? | The index, the product page, systems and the link map |
| `brain_get` | What it is, who uses it and its business rules, how to build and test it, what API it serves, how its key modules work; or an overview of a whole system | The repo's wiki pages; for a system, its repos' product pages and the links between them |
| `brain_search` | Where is this handled? (when you don't know which repo or page) | Every repo's wiki sections, endpoints and other links, and system names |
| `brain_find_consumers` | Who serves this endpoint, and who calls it? Who publishes this event and who handles it? The same for a gRPC method or a shared package | Routes, calls, events, gRPC and packages across every repo |
| `brain_impact` | What breaks if I change this repo, file or endpoint? Or: which systems, repos and endpoints would this piece of work touch? | What it serves or publishes, and everyone who uses each; for work, the wiki and route map |
| `brain_record_fact` | Records a rule, term, purpose, decision or answer a person has just stated, on a repo or a system | The person, who confirms it in a dialog |
| `brain_set_note` | Sets what a repo's wiki should focus on, when a person says so | The person, who confirms it in a dialog |

For example, `npm run brain -- consumers "GET /api/articles/:slug"` gives:

```
GET /api/articles/{} · 4 servers, 6 callers in 5 repos · llm-generated

Served by
  aspnet-api · src/Conduit/Features/Articles/ArticlesController.cs:39 · GET /api/articles/{slug}
  express-api · src/app/routes/article/article.controller.ts:87-90 · GET /api/articles/{slug}
  flask-api · conduit/articles/views.py:78 · GET /api/articles/{slug}
  laravel-api · routes/api.php:30-34 · GET /api/articles/{article}

Called by
  react-web · src/agent.js:61-62 · GET /api/articles/{slug}
  …
```

These are C#, TypeScript, Python and PHP servers side by side, each with its full path. No
language needs any setup.

Links that aren't HTTP work the same way: `consumers "event OrderStartedIntegrationEvent"` lists
who publishes an event and who handles it, `consumers "grpc Basket/GetBasket"` a gRPC method's
server and callers, and `consumers "package @citation/ui"` the repo that publishes a package and
the repos that depend on it. Names match exactly, ignoring case and package versions. Shared
databases aren't linked: table names like `users` repeat across unrelated databases.

### For product owners

Every wiki has a **product page** in product language: who uses it, what they can do, its
business rules (each cited to the line that enforces it), its terms, what it depends on and what
it doesn't do. Code names appear only in citations. The repo card opens with its first sentence:

```
react-web  @ee72eba · up to date
Product: Lets readers browse, write and discuss short-form articles, organise them by topic, and follow the authors they want to keep up with. · read with brain_get (page "product")
System: RealWorld (with aspnet-api, express-api, flask-api, laravel-api) · overview with brain_get (system "RealWorld")
```

**Systems** say which repos make up one product. Claude Code suggests them and a person confirms
them:

```
npm run brain -- systems suggest          # cents: it reads the repos' cards and links, not their code
npm run brain -- systems                  # what it suggested, and why
npm run brain -- systems confirm --all    # or confirm one, or fix with: systems set <system> <repo>...
```

Agents see suggested systems labelled "suggested" until someone confirms them. A system's overview
(`systems show <system>`, or `brain_get` with `system`) lists its repos, what each is for and how
they connect. It is put together when asked, so it is never out of date.

**Which repos would a piece of work touch?** `brain_impact` with `work` searches the wikis
(product pages first) and the route map, and groups what it finds by system:

```
npm run brain -- impact --work "notify buyers when an order ships"
```

```
"notify buyers when an order ships" would most likely touch:

eShop
  eshop  api › Ordering (`Ordering.API`, group `api/orders`); ordering-api › Aggregate model; …; routes: PUT /api/orders/ship, …

Weaker matches: citation-harness-library
```

It also names the repos that call the matching endpoints. No AI runs, so it is instant and free;
the calling agent does the reasoning.

### For technical plans

A **small repo** (most services and libraries) gets the fixed pages above in one run, plus a
data-model page and an integrations page when it has them.

A **large repo** gets a wiki that fits it. A large repo has 200 or more source files outside
tests, or four or more projects, such as eShop's twenty. First, a free count of its folders,
projects and entry points (no AI) is handed to a planning run, which picks its pages:
- the core pages: overview, build and test, API, and product;
- a page per area a developer would work in on its own, such as Basket, Ordering or Identity;
- up to three **flow** pages, a journey such as checkout as numbered, cited steps;
- a **data-model** page and an **integrations** page.

There are at most 20 pages. They're written four to a run, side by side, each run starting from
its pages' key files. `brain wiki plan <repo>` shows the plan.

The overview and each flow page carry a Mermaid diagram. A comment above each box and message
cites the code, and every element is checked like a sentence. Agents get the text without the
diagrams unless they ask, since the text says the same.

The wiki follows the code:
- **Lines shift:** when a commit only shifts the lines a page cites, the citations move with
  them and no AI runs.
- **A new project or area:** it's planned again, adding pages only for what's new.
- **A steering note:** you set one with `brain note <repo> "Ordering matters most"`, or an agent
  sets it with `brain_set_note` once you confirm it in a dialog. It re-plans the wiki at the next
  sync, and each page follows it when it's next rewritten (`sync <repo> --only wiki --full`
  rewrites them all now). It can't switch off a check.

`brain_impact` with `work` names the area and flow pages to read for a piece of work.

### Facts from people

The code can't say everything: "follows are capped at 500 because people bulk-followed" lives in
someone's head. When a person tells their agent something like that, the agent offers to record
it with `brain_record_fact`. The brain then asks the person directly, in a dialog the agent can't
answer for them, showing the fact and what the wiki already says nearby, so a contradiction shows
before anyone accepts. Accepted facts are stored as `human-reviewed`, with who and when, and come
first: at the top of the product page, on the card, in search and in system overviews.

```
## From people

- Users can follow at most 500 authors. (rule · human-reviewed · Rafe Loveday, 2026-10-12 · enforced at src/follow.ts:2 · fact #1)
```

- **Where no dialog is possible** (a headless `claude -p` run, an older client, and Claude Code's
  desktop app, which declines the dialog without showing it), the fact is stored as *proposed*,
  and agents see it labelled so until someone runs `brain facts confirm`.
- **A changed rule replaces the old one.** If the person changes something already recorded
  ("the cap is now 1000"), the agent offers to replace that fact. The old one is retired when the
  new one is confirmed, so the two never both stand.
- **Anchored facts go stale.** A fact can point at the lines that enforce it. When those lines
  change, the next sync marks it stale ("re-confirm before relying on it"); lines moving around
  it don't.
- **Checked against the code.** On the next sync, Claude Code reads each new or changed fact
  against the code of the repo it's about (or each repo of its system) and says whether the code
  **agrees**, **contradicts** it, or has **nothing for it** (agreed but not built, or not a code
  matter). The answer must cite lines that pass the usual check, and it never changes the fact:
  `(… · code agrees (checked @e45c37c) · fact #4)`, or `not in the code of aspnet-api,
  express-api, …`. Where the code agrees with a fact nobody anchored, those lines become its
  anchors, so it goes stale when they change. Checks run again only when the fact or the code
  they read changes: cents each, nothing otherwise.
- **Gaps:** searches the brain couldn't answer are logged on your machine. `brain gaps` lists
  the most asked, which is what is worth writing down.

You can also add facts yourself: `npm run brain -- facts add <repo or system> --kind rule --text "..."`.

## How far to trust an answer

- **Every claim is checked before it's stored, with no AI involved.**
  - Each sentence in a wiki page must cite lines that exist, at most 80 of them, and the names it
    mentions must appear there.
  - Each route or call must have its HTTP method and every fixed part of its path in the lines it
    cites. Each event, gRPC method or package must have its name, or each part of it, there.
  - Anything that fails is removed, and `brain sync` says what and why. On the trial repos about
    80% of wiki claims were kept, and the removals were real problems.
- **Every answer says when it's from:** the commit it describes, and how far behind the tracked
  branch that is (`@a397d11 · up to date`, or `2 commits behind origin/main`).
- **Systems are suggested by Claude Code and confirmed by a person.** A suggestion is stored only
  if its repos exist, none is in two systems, and each repo in it calls or is called by another
  member in the route map. Agents
  see unconfirmed systems labelled "suggested".
- **Everything Claude Code wrote is labelled `llm-generated`.** The check confirms the cited
  lines say what the claim names, not that the claim reads them correctly. So agents are told to
  confirm at the citation before relying on it.
- **Facts from people are labelled `human-reviewed`** once the person confirms them, with who and
  when, or "proposed" until then. Only the person can confirm through the dialog; text in a repo
  can't plant one, since agents are told to record only what the person said.
- **Answers give file and line pointers, never pasted code.**
- **Gaps are stated, not hidden.** For example, calls whose URL (or events whose name) is only
  known at run time are counted and located.
- **Your code stays on your machine.** It is read only by your own Claude Code, in a temporary
  read-only copy at the indexed commit. That run has no other tools or MCP servers.

## Commands

Run them with `npm run brain -- <command>` from this folder (or `brain <command>` with the
shortcut above). `search`, `card`, `page`, `consumers` and `impact` print exactly what an agent
gets.

| Command | Does |
|---|---|
| `doctor` | Checks Node, git, Claude Code, the store, the MCP registration and each repo's hook, and says how to fix anything missing. |
| `add <path> [<path>...] [--name n] [--note "<focus>"] [--no-hook] [--no-ai]` | Adds repos: indexes them, has Claude Code map them and write their wikis (three repos at a time), and installs their hooks. Each answers questions as soon as it's indexed. `--no-ai` indexes only. |
| `sync [<name>] [--full] [--only links\|wiki\|facts] [--no-ai] [--model m]` | Brings repos up to their tracked branch, redoing only what changed: the links, the wiki, and facts from people checked against the code, side by side. All repos if no name is given, three at a time. `--full` redoes everything. `--only` runs one of those steps. This is what the hook runs. |
| `note <name> ["<focus>" \| --clear \| --confirm]` | Shows or sets the note steering a repo's wiki; `--confirm` applies one an agent proposed. |
| `wiki plan <name>` | A large repo's page plan: each page's kind, what it covers, and when it was written. |
| `hooks install\|remove\|status [<name>]` | Turns automatic updates on or off, or shows which repos have them. |
| `repo list` | Lists repos and how up to date each is. |
| `repo add <path> [--name n] [--ref r]` | Enrols a repo only, with no AI, for when you want to sync later. |
| `repo set-ref <name> <ref>` | Tracks a different branch, e.g. `origin/release`. |
| `repo remove <name>` | Removes a repo, everything held about it, and its hook. |
| `search "<query>" [--repo n]... [--detailed]` | `brain_search`. |
| `card <name> [--detailed]` | `brain_repo_card`. Given a system's name, it shows that system's overview. |
| `page <name> [<page>]` | `brain_get`: the page list, or one page (`product` for the product page). |
| `consumers "<METHOD /path>" [--detailed]` | `brain_find_consumers`. Takes `:id` and `{id}` style paths, or full URLs; or `"event <name>"`, `"grpc <Service/Method>"`, `"package <name>"`. |
| `impact <repo> [--path file] [--route "<METHOD /path>"]` | `brain_impact`. `--route` also takes an event, gRPC method or package. |
| `impact --work "<description>"` | `brain_impact` with `work`: which systems, repos and endpoints a piece of work would most likely touch. |
| `systems` | Lists systems, whether each is suggested or confirmed, and repos in none. |
| `systems suggest [--model m]` | Has Claude Code suggest systems from the repos' cards, product pages and links. Costs cents. Confirmed systems are left alone. |
| `systems show <system>` | `brain_get` with `system`: the system's overview. |
| `systems confirm <system>` or `--all` | Confirms suggested systems. |
| `systems set <system> <repo>... [--summary "<line>"]` | Adds or moves repos into a system (creating it if needed), or changes its one-line summary. Either way the system counts as confirmed. |
| `systems rename <system> <new>` / `systems remove <system>` | Tidies up. Removing a system leaves its repos enrolled, and removes the facts on it. |
| `facts [<repo or system>] [--all]` | Lists facts from people; proposed and stale ones are marked. `--all` adds retired ones. |
| `facts add <repo or system> --kind <k> --text "<fact>" [--quote ...] [--anchor file:lines]... [--ticket t]` | Records a fact yourself, confirmed. Kinds: rule, term, purpose, decision, answer. |
| `facts confirm <id>` / `facts edit <id> [--text ...] [--anchor ...]` / `facts retire <id>` | Confirms a proposed or stale fact, rewords or re-anchors one, or marks one no longer true. |
| `facts check [<repo or system>] [--full]` | Checks facts against the code now rather than at the next sync. `--full` checks them again even if nothing changed. |
| `facts export` | Every fact as Markdown, by repo and system. |
| `gaps` | Searches the brain couldn't answer, most asked first. |

A repo tracks what `origin/HEAD` points at (usually `origin/main`), so it describes what has been
merged, and a fetch is enough to update it. The store is `%USERPROFILE%\.brain\brain.db`. Set
`BRAIN_DB` to use another file.

## Troubleshooting

- **Something's not working:** run `npm run brain -- doctor` first.
- **Claude Code didn't use the brain:**
  - Start a *new* session; sessions pick up MCP servers when they start.
  - Check `/mcp` shows `citation-brain` as connected.
  - Ask about the repo or system by name. The brain tells each new session which systems and
    repos it holds, so a name that matches a public project (like RealWorld) still goes to the
    brain. A repo added after the session started is only listed in the next one.
- **A repo isn't updating:** `npm run brain -- hooks status`. Background syncs log to
  `%USERPROFILE%\.brain\hooks.log` (read it with `Get-Content -Encoding utf8` in Windows
  PowerShell). A repo that uses husky or its own `reference-transaction` hook can't take the
  brain's hook. Run `brain sync <name>` from your own hook instead.
- **A wiki page says "kept from @…":** its rewrite failed the check twice, so the last good
  version is shown. `brain sync <name> --full --only wiki` rewrites the wiki without
  re-mapping the links.
- **Group policy blocks `node_modules\.bin`:** that's why every command here runs through `node`.
  Use the npm scripts or the shortcut, not `npx`.

## What it can't do yet

- **Search by meaning:** `brain_search` matches words, not synonyms. Search "auth" rather than
  "login security".
- **Flows across repos:** a flow page covers one repo, and names the link where a step crosses
  into another. Pages that follow a journey through several repos are planned (B4b).
- **Hosting:** today it runs on your machine. A hosted version with GitHub permissions is phase 6.

## Working on the brain

See [docs/development.md](docs/development.md) for tests, layout and design docs. The
[manual testing guide](docs/manual-testing.md) covers checking changes against real repos.
