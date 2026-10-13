# Architecture

The brain is a separate service that holds the organisation's engineering context and answers
narrow questions over MCP. The delivery harness (`citation-harness-library`) keeps all of its
skills and only *calls* the brain: when an agent needs context it asks for exactly that and gets
a small, cited answer back instead of reading whole repositories.

Rendered version with diagrams: https://claude.ai/artifact/HNRKf4rtHYs25psQwSMNmW (private).

## Decisions at a glance

| Topic | Decision |
|---|---|
| Relationship to the harness | Separate repo and service. Nothing moves out of the harness. |
| Interface | MCP. Agents first; a human deep-wiki UI can come later on the same store. |
| Access | Per repo, following the caller's GitHub permissions. |
| Stack | TypeScript on Node. |
| Runs | Local POC first, then hosted on Azure. |
| Freshness | Rebuilt on every merge to main (git hook locally, webhook hosted). |
| Scale | Unknown and growing number of repos, mixed languages and frameworks. |

## Where it sits

```
Harness skills (Claude Code, Codex) ──tool calls──▶ MCP server ─┐
        │                                                       │  citation-brain
        └──direct──▶ Atlassian Rovo MCP (Jira, Confluence)      │  (own repo + service)
                     never copied into the brain                │
                                                   Query engine ──check caller──▶ GitHub permissions
                                                        │ reads
                                                      Store  (every fact tagged repo @ commit)
                                                        ▲ writes
GitHub repos ──on merge──────────────────────────▶ Ingest pipeline ──pages, seams──▶ Claude Code (headless)
Curated content repo ──PR merged─────────────────▶ (registry, index, AI runs, checks, gardener)
```

Agents only read. The only writes come from merges to main in enrolled repos and merged PRs to
the curated content repo.

## Three kinds of fact

Every fact records how it was made, and every answer carries that label.

| Tier | Built by | Holds | Agent should |
|---|---|---|---|
| **index** | git only: the committed tree at the tracked ref. No LLM. | File inventory, languages, freshness | Rely on it |
| **human-reviewed** | People: a fact a person stated and confirmed in their agent's dialog, or with `brain facts` (B3a); hosted, also curated content merged through a PR | Business rules, terms, purposes, decisions and answers, on a repo or a system | Treat as the team's stated intent; check the code when one matters, and re-confirm a stale one |
| **llm-generated** | Claude Code (headless, isolated, read-only) from the code at the indexed commit, with a citation on every claim | Wiki pages (W1), including a product page (B2a); routes and calls in any language (W4), and events, gRPC methods and shared packages (B2b), from which the seam graph and cross-repo links are built; suggested systems (B2a); checks of facts from people against the code (B3b) | Every citation is checked automatically (W2, W4); use as a map, and confirm at the citation before relying on a claim |

Why: generated context files lowered agent success in a controlled study, and public
DeepWiki pages were often wrong, while code-derived structure helped (see `research.md`). The
brain started with parsers for that structure; W0 and W4 showed Claude Code finds every route
and call the parsers did, in any language, so the parsers were removed and every AI fact is
verified against the lines it cites instead (`decisions.md`, 2026-10-06).

## Inside the brain

Two halves share only the store:

- **Ingest (writes):** registry → trigger → git index → Claude Code (seams, wiki pages) →
  deterministic checks (seam verification, citation checker).
  The gardener runs on a schedule and drafts PRs to owners.
- **Store:** seam graph, symbol maps, repo cards, curated context, wiki pages, systems, search index.
  Every row belongs to one repo at one commit. The repo is the unit of work, of permission and
  of deletion.
- **Serve (reads):** MCP server → query engine → access filter (inside the query) → response
  shaper (pointers, commit, commits behind, tier). When a session connects, the server's
  instructions name the systems and repos the caller can read, each with its one-line product
  summary, so an agent knows which names are the organisation's own.

## Freshness on merge

1. A merge to main queues a job for that repo: commit a → b.
2. `git diff a..b` gives the changed files.
3. Claude Code maps routes and calls, and in a second run alongside it (with a second look on a full map) the other links (events,
   gRPC, packages), again in the changed files, and in files whose seams cite a changed file (a moved
   prefix). Each is verified against its cited lines before it replaces the
   old ones; Markdown and other files that can't declare an endpoint cost no run. Cross-repo
   links are worked out at query time, so nothing else is re-linked.
4. Wiki pages whose cited lines changed, whose cited file grew by ten lines or more, or whose
   cited folder gained a file, are rewritten, four pages to a Claude Code run with the runs side by
   side, and must pass the citation check. A page whose cited file changed only around the cited
   lines has its citations moved through the diff, as fact anchors are, and is carried with no AI
   run. A large repo is planned again only when a new project or enough new code lands outside
   every page, or its steering note changes; then only its new pages are written. Pass → publish tagged with b. Fail → written
   once more with the removed claims as feedback; fail again → keep the old page, which then
   shows it was kept from an older commit. Pages that cite nothing changed are re-checked against
   b without AI and moved to b. One run per repo at a time; a trigger mid-run is folded into one
   more pass. (Built in W3 and W4: the git hook runs `brain sync`.)
5. The search index changes with the pages and seams, in the same transaction, so it never
   describes a different commit from them.
6. Facts from people anchored to changed lines are marked stale, never rewritten; lines moving
   around them move their anchors. A person re-confirms a stale fact (`brain facts confirm`).
7. Facts that are new, edited, or whose last check read a changed file are checked against the
   code in one Claude Code run per repo: agrees, contradicts, or absent, verified against the
   lines cited. A re-check that still agrees clears the stale mark on anchors it found itself;
   it never touches a fact's text or status.

## Wikis that fit the repo (B4a)

A planner needs the architecture, the flows, the data model and the integrations without
grepping, and five fixed pages can't hold that for a repo of twenty projects.

- **Small or large, decided without AI.** `src/ai/inventory.ts` counts the indexed files: a repo
  with 200 or more source files outside tests and vendored folders, or four or more projects
  (folders with a manifest), is large. On the samples only eShop is (573 files, 20 projects).
- **Small repos** keep one run writing the fixed pages, plus `data-model` and `integrations`
  pages when the repo has them.
- **Large repos are planned.** The planning run gets the inventory (folders and their file
  counts, projects, likely entry points) rather than listing folders itself, and returns up to 20
  pages: the four core pages, a page per area, up to three flow pages, data model and
  integrations, each with the folders it covers and its key files. The plan is checked without AI
  (folders and files exist, unique slugs, core pages present, within the caps) and retried once;
  a plan that still fails leaves the repo with what it had. Pages are written four to a run, the
  runs side by side, each given the whole plan so pages refer to each other rather than repeat.
  A run that fails costs only its own pages.
- **Steering note.** A person sets what the wiki should stress (`brain note`, or
  `brain_set_note` with a confirm dialog; a proposed note steers nothing). It goes to the
  planning run and every page run as guidance under the checking rules. It is never read from
  the repo, whose text is untrusted.
- **Diagrams.** The overview has a Mermaid flowchart and each flow page a sequence diagram. A
  `%% [path:lines]` comment above each box, labelled link and message cites it, and the checker
  (`src/ai/diagrams.ts`) checks each like a sentence: removed when it fails, with links to removed
  boxes; the diagram is dropped when more than half fails or it isn't a flowchart or sequence
  diagram. Agents get pages without diagrams unless they ask, and search skips them.
- **Serving.** `brain_get` lists pages by kind with each page's first sentence; the card counts a
  large wiki's pages by kind; the integrations page gains the enrolled repos it talks to from the
  link map when read; `brain_impact` with `work` names the area and flow pages to read.
- **Side by side.** A sync's three steps (links, wiki, fact checks) share one worktree and run at
  once; `brain add` and `brain sync` take three repos at a time; one cap of four Claude Code runs
  covers everything a command does.

## Following a flow (B4b)

A planner's question "what does changing this set off?" is downstream: the link map knew who
serves and calls an endpoint, but not which calls or events a handler goes on to make.

- **A third run in the links step** (`src/ai/traces.ts`, `prompts/list-traces.md`) gets the
  repo's entry points (routes, event handlers, gRPC methods served) and exit points (calls, events
  published, gRPC calls), all already verified. For each entry point, and each job or UI action it
  finds, it answers what handling reaches: exit points, tables read or written, or nothing.
- **Each answer is a chain of steps, checked without AI** (`chainProblem`):
  - every step's lines exist, at most 80;
  - the first is in the entry point's file;
  - each step's linking name (the function called, or the command or type a mediator or bus
    dispatches) appears in it and in the next;
  - the last covers the exit point's own line, or names the table.

  A chain that fails is dropped, and an entry point left with none is asked once more. An entry
  point that reaches nothing is stored as a cited fact, so "ends here" is never a guess.
- **Stored** in `trace_links` (migration 16) by refs, not row ids, so re-mapping links doesn't
  orphan them. Updates move chains through diffs when only lines around them changed; an entry
  point is followed again only when lines its chains cite change; jobs and UI actions are looked
  for in added files and in files whose jobs changed. Exit points no chain reaches are reported.
- **The trace** (`src/serve/trace.ts`) is built when asked, with no AI:
  - an exit point leads to whoever serves or handles it, in any readable repo or the same one;
  - a table write in a repo leads to that repo's entry points that read the table;
  - tables aren't followed between repos.

  There's no depth limit: a visited set stops loops, and loops show as loops. Concise output shows
  up to five things reached per step (the median fan-out in Alibaba's and Meta's production traces
  is four) and counts the rest; detailed shows all. Repos the caller can't read are counted, not
  named.

## MCP tools

A few broad tools, all read-only but `brain_record_fact`. Short answers by default, `format: "detailed"` on request,
paginated lists, pointers rather than pasted code. No free-text "ask" tool.

| Tool | Answers | Harness stage | Status |
|---|---|---|---|
| `brain_find_consumers` | Who produces or consumes an endpoint, event, gRPC method or package, across repos | Contract review, technical planning | Built |
| `brain_impact` | What depends on a route, published event, gRPC method, package, symbol or file, in the repo and across repos; or, given a description of work, which systems, repos and endpoints it would most likely touch | Product brief, technical planning, scope drift, maintainability review | Built for everything a repo or file provides, and work descriptions; symbols in phase 3b |
| `brain_repo_card` | What a repo is: what it is for (product line), its system, freshness, languages, neighbours, seam counts, where its wiki is | Product brief, technical planning | Built |
| `brain_search` | Facts from people, systems, then ranked wiki sections and endpoints for keywords, across every readable repo | Any, when you don't know which repo holds the answer | Built; logs searches that find nothing as gaps |
| `brain_get` | One item in full (page, system overview, glossary entry, ADR, symbol map) with citations | Product brief, feature planning, development | Built for wiki pages and system overviews; the product page and overviews open with facts from people |
| `brain_record_fact` | Records a fact a person stated, after they confirm it in an elicitation dialog | Product brief (the loop back from the PO) | Built (B3a) |

A hit looks like: `orders-web · src/api/orders.ts:42-58 · @9f3c1e2 · 2 commits behind · llm-generated`.

### Search

One SQLite FTS5 index with a row per wiki section (pages split at `##`/`###` headings) and per
seam (route, call, event, gRPC method or package). Sections are searched on their repo, page title, heading, text (citations taken
out) and the files they cite, with camelCase file names also written apart. Endpoints are
searched on their method and path only. A query's words are OR'd and ranked by bm25 with Porter
stemming, headings weighted most. Rows are added where pages and seams are written and removed
by triggers, so a page rewrite, a deleted file or a removed repo can't leave stale hits.
Keyword search only: embeddings wait until evals show a gain (see "Not in v1"). System names
and summaries have their own small FTS5 index, kept in step by triggers, and matching systems are
listed first.

### The product layer

A PO's agent should answer what a product does, who uses it, its business rules and which
systems a piece of work touches, without reading code or technical pages.

- **The product page.** Every wiki has a page with slug `product`, in product language: who uses
  it, what they can do, business rules, terms, what it depends on (named as products) and what it
  doesn't do. Its text names no code: code names appear only in its citations, which point at
  where each rule is enforced. It goes through the same citation check as every page. Wikis
  written before it existed gain it on their next sync, in a run of its own, without rewriting the
  other pages (an update writes any page every wiki should have but this one lacks). The repo
  card opens with the page's first sentence.
- **Systems** are the repos that make up one product. `brain systems suggest` gives Claude Code a
  small file holding each repo's card facts, the opening of its product page and its links, and
  no code. Each suggestion is checked against the facts (its repos exist, none is in two systems,
  the name is free, and in a system of several repos each one calls or is called by another
  member in the route map; one that isn't is left out) and stored as `suggested`. A person
  confirms, edits or removes them, and editing one confirms it; a repo belongs to at most one. Repos in confirmed systems are left out of
  later suggestions. After `brain add`, a new repo that calls or is called by a repo in a
  confirmed system gets a suggestion to join it, worked out from the seam graph with no AI.
- **A system overview** (`brain_get` with `system`) is assembled when asked, like neighbours: the
  summary from the suggestion or a person, each repo's product sentence, and the links within and
  outside the system from the seams. Nothing in it is unchecked, and nothing is stored, so it is
  never stale. Agents see confirmed systems as facts and suggested ones labelled "suggested".
- **`brain_impact` with `work`** searches wiki sections (product sections count double) and
  endpoints for the description, ranks repos by their best few matching sections plus a little per
  matching route, scaled by the square of the share of the description's words the repo matches
  at all, groups them by system, and adds the repos that call the matching routes. Repos under
  half the best score are only named as weaker matches. No AI
  runs at query time; the calling agent does the reasoning. It keeps the tool set at five.

## Seams

Every link is a pair: something a repo provides, and something that uses it. All kinds live in the
one `seams` table, each in its existing columns. HTTP is mapped in one Claude Code run
(`prompts/list-seams.md`) and the rest in another (`prompts/list-links.md`): asked for in one run,
HTTP coverage fell (decisions, 2026-10-12).

| Family | Provides (kind) | Uses (kind) | `method` | `raw_path` | `route_key` (what must match) |
|---|---|---|---|---|---|
| HTTP | `http-route` | `http-call` | GET, POST, … or `*` | the full path | normalised path; exact, or suffix at a segment boundary |
| Events and queues | `event-publish` | `event-subscribe` | `event` | the topic, queue or event name | the name, lower-cased |
| gRPC | `grpc-serve` | `grpc-call` | `grpc` | `Service/Method` | `service/method`, lower-cased, without the proto package |
| Shared packages | `package-publish` | `package-use` | `package` | the package name | the name, lower-cased, without a version |

A name only known at run time is stored with no key, like a run-time URL: counted and located,
never matched. The same rules apply to every family: a use its own repo provides (tests calling
their own API, a service handling its own event) links only within that repo and is marked
"same repo". Shared databases are not linked (`decisions.md`, 2026-10-08).

## Local POC vs hosted

| Part | Local POC | Hosted |
|---|---|---|
| Store | SQLite (`node:sqlite`) | Azure Database for PostgreSQL |
| Trigger | `reference-transaction` git hook (fires on fetch, pull, merge) or `brain sync` | GitHub App webhook → Azure Service Bus |
| Workers | In the CLI process | Azure Container Apps jobs |
| MCP transport | stdio | Streamable HTTP behind Entra ID |
| Source code | Existing local clones | Shallow clones cached per repo |
| Permissions | Local policy: every enrolled repo | GitHub App + caller identity per request |
| Curated content | Local folder | GitHub repo, changed through PRs |

## Scaling

- Repos join by registry entry, with no code change.
- One repo at one commit is the unit of work; repos sync in parallel; only changed blobs are re-read.
- Any language works with no code change: Claude Code reads the repo. Routes in OpenAPI specs
  count, and code is cited before a spec that declares the same endpoint.
- Cross-repo links join on normalised keys at query time, so new repos link without re-indexing others.

## Safety

- Agent-facing tools are read-only, except `brain_record_fact`. It asks the person through MCP
  elicitation, so the agent can't confirm for them; without a dialog the fact is only proposed.
  It is marked `requiresUserInteraction`, so Claude Code prompts for every call. Agents are told
  to record only what the person said, never repo text or tool output.
- Repo text, tickets and PR bodies are untrusted; tool output is data, never instructions.
- AI runs are read-only (Read, Grep, Glob), load no MCP servers, settings or skills, and store
  only pointers to the lines they cite.
- Permission filtering happens in the query layer, in one place.
- Removing a repo deletes all its rows and nothing else.

## Not in v1

- Code embeddings (only if evals show a gain, and fused with keyword search).
- A human UI.
- A graph database.
