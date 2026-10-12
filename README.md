# brain-concept

**Add a repo, get a wiki.** The brain gives coding agents (Claude Code, through MCP) context about
every repository you add. Claude Code reads each repo, in any language, and writes wiki pages
in which every sentence cites the lines it is based on. It also maps the HTTP routes each repo
serves and calls, so an agent can see which repos depend on each other. A product page in each
wiki, and systems that group the repos making up one product, let a product owner's agent answer
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
2. It has Claude Code map the repo's routes and calls and write about five wiki pages: overview,
   build and test, API, its most important module, and a product page (what it does for its
   users, written for a product owner). Before starting, it prints a rough cost:
   about $0.50–2 for a small repo, up to about $3–8 for a large one, from your Claude Code
   allowance. It takes 3–20 minutes.
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

To see exactly what an agent gets, use the same answers from the command line:
`npm run brain -- card some-repo`, `page some-repo`, `search "tokens"`.

**To stop trialling:** `npm run brain -- repo remove some-repo` removes everything the brain holds
about a repo, and its hook. Delete `%USERPROFILE%\.brain` to remove the whole store. Remove the
MCP server with `claude mcp remove citation-brain -s user`.

> **Shortcut:** to type `brain` instead of `npm run brain --`, add this to your PowerShell
> profile (`notepad $PROFILE`):
> `function brain { node C:\path\to\brain-concept\bin\brain.mjs @args }`

## What agents can ask

The MCP server tells Claude Code when to use it. These are its five tools, all read-only:

| Tool | Answers | From |
|---|---|---|
| `brain_repo_card` | What is this repo for, which system is it part of, which repos does it call and which call it, is there a wiki? | The index, the product page, systems and the route map |
| `brain_get` | What it is, who uses it and its business rules, how to build and test it, what API it serves, how its key modules work; or an overview of a whole system | The repo's wiki pages; for a system, its repos' product pages and the links between them |
| `brain_search` | Where is this handled? (when you don't know which repo or page) | Every repo's wiki sections and endpoints, and system names |
| `brain_find_consumers` | Who serves this endpoint, and who calls it? | Routes and calls across every repo |
| `brain_impact` | What breaks if I change this repo, file or endpoint? Or: which systems, repos and endpoints would this piece of work touch? | Its routes and every caller of each; for work, the wiki and route map |

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

## How far to trust an answer

- **Every claim is checked before it's stored, with no AI involved.**
  - Each sentence in a wiki page must cite lines that exist, at most 80 of them, and the names it
    mentions must appear there.
  - Each route or call must have its HTTP method and every fixed part of its path in the lines it
    cites.
  - Anything that fails is removed, and `brain sync` says what and why. On the trial repos about
    80% of wiki claims were kept, and the removals were real problems.
- **Every answer says when it's from:** the commit it describes, and how far behind the tracked
  branch that is (`@a397d11 · up to date`, or `2 commits behind origin/main`).
- **Systems are suggested by Claude Code and confirmed by a person.** A suggestion is stored only
  if its repos exist, none is in two systems, and each repo in it calls or is called by another
  member in the route map. Agents
  see unconfirmed systems labelled "suggested".
- **Every answer is labelled `llm-generated`.** The check confirms the cited lines say what the
  claim names, not that the claim reads them correctly. So agents are told to confirm at the
  citation before relying on it.
- **Answers give file and line pointers, never pasted code.**
- **Gaps are stated, not hidden.** For example, calls whose URL is only known at run time are
  counted and located.
- **Your code stays on your machine.** It is read only by your own Claude Code, in a temporary
  read-only copy at the indexed commit. That run has no other tools or MCP servers.

## Commands

Run them with `npm run brain -- <command>` from this folder (or `brain <command>` with the
shortcut above). `search`, `card`, `page`, `consumers` and `impact` print exactly what an agent
gets.

| Command | Does |
|---|---|
| `doctor` | Checks Node, git, Claude Code, the store, the MCP registration and each repo's hook, and says how to fix anything missing. |
| `add <path> [--name n] [--no-hook] [--no-ai]` | Adds a repo: indexes it, has Claude Code map it and write its wiki, and installs its hook. `--no-ai` indexes only. |
| `sync [<name>] [--full] [--no-ai] [--model m]` | Brings repos up to their tracked branch, redoing only what changed. All repos if no name is given. `--full` redoes everything. This is what the hook runs. |
| `hooks install\|remove\|status [<name>]` | Turns automatic updates on or off, or shows which repos have them. |
| `repo list` | Lists repos and how up to date each is. |
| `repo add <path> [--name n] [--ref r]` | Enrols a repo only, with no AI, for when you want to sync later. |
| `repo set-ref <name> <ref>` | Tracks a different branch, e.g. `origin/release`. |
| `repo remove <name>` | Removes a repo, everything held about it, and its hook. |
| `search "<query>" [--repo n]... [--detailed]` | `brain_search`. |
| `card <name> [--detailed]` | `brain_repo_card`. |
| `page <name> [<page>]` | `brain_get`: the page list, or one page (`product` for the product page). |
| `consumers "<METHOD /path>" [--detailed]` | `brain_find_consumers`. Takes `:id` and `{id}` style paths, or full URLs. |
| `impact <repo> [--path file] [--route "<METHOD /path>"]` | `brain_impact`. |
| `impact --work "<description>"` | `brain_impact` with `work`: which systems, repos and endpoints a piece of work would most likely touch. |
| `systems` | Lists systems, whether each is suggested or confirmed, and repos in none. |
| `systems suggest [--model m]` | Has Claude Code suggest systems from the repos' cards, product pages and links. Costs cents. Confirmed systems are left alone. |
| `systems show <system>` | `brain_get` with `system`: the system's overview. |
| `systems confirm <system>` or `--all` | Confirms suggested systems. |
| `systems set <system> <repo>... [--summary "<line>"]` | Adds or moves repos into a system (creating it if needed), or changes its one-line summary. Either way the system counts as confirmed. |
| `systems rename <system> <new>` / `systems remove <system>` | Tidies up. Removing a system leaves its repos enrolled. |

A repo tracks what `origin/HEAD` points at (usually `origin/main`), so it describes what has been
merged, and a fetch is enough to update it. The store is `%USERPROFILE%\.brain\brain.db`. Set
`BRAIN_DB` to use another file.

## Troubleshooting

- **Something's not working:** run `npm run brain -- doctor` first.
- **Claude Code didn't use the brain:**
  - Start a *new* session; sessions pick up MCP servers when they start.
  - Check `/mcp` shows `citation-brain` as connected.
  - Ask about the repo by name.
- **A repo isn't updating:** `npm run brain -- hooks status`. Background syncs log to
  `%USERPROFILE%\.brain\hooks.log` (read it with `Get-Content -Encoding utf8` in Windows
  PowerShell). A repo that uses husky or its own `reference-transaction` hook can't take the
  brain's hook. Run `brain sync <name>` from your own hook instead.
- **A wiki page says "kept from @…":** its rewrite failed the check twice, so the last good
  version is shown. `brain sync <name> --full` rewrites everything.
- **Group policy blocks `node_modules\.bin`:** that's why every command here runs through `node`.
  Use the npm scripts or the shortcut, not `npx`.

## What it can't do yet

- **Search by meaning:** `brain_search` matches words, not synonyms. Search "auth" rather than
  "login security".
- **Re-planning a wiki:** updates keep the same pages. After a big restructure, run
  `brain sync <name> --full`.
- **Corrections from people:** curated, human-reviewed facts are planned (phase 4).
- **Hosting:** today it runs on your machine. A hosted version with GitHub permissions is phase 6.

## Working on the brain

See [docs/development.md](docs/development.md) for tests, layout and design docs. The
[manual testing guide](docs/manual-testing.md) covers checking changes against real repos.
