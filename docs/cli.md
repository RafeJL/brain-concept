# Commands

You don't need these to use the brain from Claude Code: setup and adding repos are in the
[README](../README.md). They're for adding repos from a terminal, checking what an agent gets,
and tidying up.

## Running them

Run them from the brain-concept folder:

```powershell
npm run brain -- <command>
```

To type `brain <command>` from any folder instead, add this to your PowerShell profile
(`notepad $PROFILE`), with your own path:

```powershell
function brain { node C:\Repos\brain-concept\bin\brain.mjs @args }
```

`search`, `card`, `page`, `consumers` and `impact` print exactly what an agent gets.

## Where things live

| What | Where | Change it with |
|---|---|---|
| The store | `%USERPROFILE%\.brain\brain.db` | `BRAIN_DB` (a path to another file) |
| Repos the brain cloned from GitHub | `repos` beside the store: `%USERPROFILE%\.brain\repos` | `BRAIN_REPOS` |
| The log of background work (hooks, enrolments, fetches) | `hooks.log` beside the store | follows `BRAIN_DB` |
| One lock per repo, so only one sync of it runs at a time | `locks` beside the store | follows `BRAIN_DB` |
| The temporary worktrees Claude Code runs in | the system temp folder | `TMPDIR` (`TEMP` on Windows) |
| The facts each full wiki rewrite dropped, a Markdown file and a JSON copy per rewrite | `reports\<repo>` beside the store | follows `BRAIN_DB` |

In the Docker image all of these sit under one data directory, `BRAIN_DATA` (default `/data`);
see [development.md](development.md#docker-and-aws).

A repo tracks what `origin/HEAD` points at (usually `origin/main`). So it describes what has
been merged, and a fetch is enough to update it.

## Adding and keeping repos

| Command | Does |
|---|---|
| `doctor` | Checks Node, git, Claude Code, the store, the MCP registration, each repo's hook and any enrolment that is running or failed. Says how to fix anything missing. |
| `add <repo> [<repo>...] [--name n] [--ref r] [--note "<focus>"] [--no-hook] [--no-ai] [--model m]` | Adds repos. A repo is a local clone, a GitHub URL (`https://github.com/owner/repo`, with or without `.git`, or `git@github.com:owner/repo.git`), `owner/repo`, or another git URL. Remote ones are cloned into the brain's folder with your git credentials. Then it indexes them, has Claude Code map their links and write their wikis (three repos at a time), and installs their hooks. Each answers as soon as it's indexed. `--ref` tracks a branch other than `origin/HEAD`. `--no-ai` indexes only. Adding a repo whose enrolment failed or stopped finishes it. |
| `sync [<name>] [--full] [--only links\|wiki\|facts] [--no-ai] [--model m]` | Brings repos up to their tracked branch, redoing only what changed: the links, the wiki, and facts from people checked against the code, side by side. All repos if no name is given, three at a time. `--full` redoes everything. `--only` runs one of those steps. This is what the hook runs. |
| `note <name> ["<focus>" \| --clear \| --confirm]` | Shows or sets the note steering a repo's wiki; `--confirm` applies one an agent proposed. |
| `wiki plan <name>` | A large repo's page plan: each page's kind, what it covers, and when it was written. |
| `hooks install\|remove\|status [<name>]` | Turns automatic updates on or off, or shows which repos have them. |
| `repo list` | Lists repos and how up to date each is, and enrolments under way or failed. |
| `repo add <repo> [--name n] [--ref r]` | Enrols a repo only, with no AI, for when you want to sync later. |
| `repo set-ref <name> <ref>` | Tracks a different branch, e.g. `origin/release`. |
| `repo remove <name>` | Removes a repo, everything held about it, its hook, and the brain's clone of it if it made one. Also forgets a failed enrolment. |

## Seeing what an agent gets

| Command | Is |
|---|---|
| `search "<query>" [--repo n]... [--detailed] [--offset n]` | `brain_search`. `--offset` gives the next page of results. |
| `card <name> [--detailed]` | `brain_repo_card`. Given a system's name, it shows that system's overview. While a repo is being enrolled, it says how far it has got. |
| `page <name> [<page>]` | `brain_get`: the page list, or one page (`product` for the product page). |
| `consumers "<METHOD /path>" [--detailed] [--follow]` | `brain_find_consumers`. Takes `:id` and `{id}` style paths, or full URLs; or `"event <name>"`, `"grpc <Service/Method>"`, `"package <name>"`. `--follow` traces what handling it sets off, across repos. |
| `impact <repo> [--path file] [--route "<METHOD /path>"] [--detailed]` | `brain_impact`. `--route` also takes an event, gRPC method or package. |
| `impact --work "<description>"` | `brain_impact` with `work`: which systems, repos and endpoints a piece of work would most likely touch. |

For example, `consumers "GET /api/articles/:slug"` gives:

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

And `impact --work "notify buyers when an order ships"`:

```
"notify buyers when an order ships" would most likely touch:

eShop
  eshop  api › Ordering (`Ordering.API`, group `api/orders`); ordering-api › Aggregate model; …; routes: PUT /api/orders/ship, …

Weaker matches: citation-harness-library
```

## Systems

Systems say which repos make up one product.

| Command | Does |
|---|---|
| `systems` | Lists systems, whether each is suggested or confirmed, and repos in none. |
| `systems suggest [--model m]` | Has Claude Code suggest systems from the repos' cards, product pages and links. Costs cents: it reads no code. Confirmed systems are left alone. |
| `systems show <system>` | `brain_get` with `system`: the system's overview. |
| `systems confirm <system>` or `--all` | Confirms suggested systems. |
| `systems set <system> [<repo>...] [--summary "<line>"]` | Adds or moves repos into a system (creating it if needed), or changes its one-line summary. Either way the system counts as confirmed. |
| `systems rename <system> <new>` / `systems remove <system>` | Tidies up. Removing a system leaves its repos enrolled, and removes the facts on it. |

## Facts from people

Agents record facts with `brain_record_fact` once the person agrees. You can also manage them here.

| Command | Does |
|---|---|
| `facts [<repo or system>] [--all]` | Lists facts from people; proposed and stale ones are marked. `--all` adds retired ones. |
| `facts add <repo or system> --kind <k> --text "<fact>" [--quote ...] [--anchor file:lines]... [--ticket t]` | Records a fact yourself, confirmed. Kinds: rule, term, purpose, decision, answer. |
| `facts confirm <id>` / `facts edit <id> [--text ...] [--anchor ...]` / `facts retire <id>` | Confirms a proposed or stale fact, rewords or re-anchors one, or marks one no longer true. |
| `facts check [<repo or system>] [--full]` | Checks facts against the code now, rather than at the next sync. `--full` checks them again even if nothing changed. |
| `facts export` | Every fact as Markdown, by repo and system. |
| `gaps` | Searches the brain couldn't answer, most asked first. |
