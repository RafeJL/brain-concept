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
| **human-reviewed** | People, or an agent draft merged through a PR by an owner | Glossary, customers, features, ADRs, repo purposes | Treat as the team's stated intent |
| **llm-generated** | Claude Code (headless, isolated, read-only) from the code at the indexed commit, with a citation on every claim | Wiki pages (W1); routes and calls in any language (W4), from which the seam graph and cross-repo links are built | Every citation is checked automatically (W2, W4); use as a map, and confirm at the citation before relying on a claim |

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
- **Store:** seam graph, symbol maps, repo cards, curated context, wiki pages, search index.
  Every row belongs to one repo at one commit. The repo is the unit of work, of permission and
  of deletion.
- **Serve (reads):** MCP server → query engine → access filter (inside the query) → response
  shaper (pointers, commit, commits behind, tier).

## Freshness on merge

1. A merge to main queues a job for that repo: commit a → b.
2. `git diff a..b` gives the changed files.
3. Claude Code maps routes and calls again in the changed files, and in files whose seams cite a
   changed file (a moved prefix). Each is verified against its cited lines before it replaces the
   old ones; Markdown and other files that can't declare an endpoint cost no run. Cross-repo
   links are worked out at query time, so nothing else is re-linked.
4. Wiki pages that cite a changed file, or a folder a file was added to, are rewritten in one
   Claude Code run and must pass the citation check. Pass → publish tagged with b. Fail → written
   once more with the removed claims as feedback; fail again → keep the old page, which then
   shows it was kept from an older commit. Pages that cite nothing changed are re-checked against
   b without AI and moved to b. One run per repo at a time; a trigger mid-run is folded into one
   more pass. (Built in W3 and W4: the git hook runs `brain sync`.)
5. The search index changes with the pages and seams, in the same transaction, so it never
   describes a different commit from them.
6. Curated facts citing changed lines are never rewritten automatically; the owner gets a draft PR.

## MCP tools

A few broad, read-only tools. Short answers by default, `format: "detailed"` on request,
paginated lists, pointers rather than pasted code. No free-text "ask" tool.

| Tool | Answers | Harness stage | Status |
|---|---|---|---|
| `brain_find_consumers` | Who produces or consumes an endpoint, event or package, across repos | Contract review, technical planning | Built for HTTP endpoints |
| `brain_impact` | What depends on a route, symbol or file, in the repo and across repos | Technical planning, scope drift, maintainability review | Built for routes and files; symbols in phase 3b |
| `brain_repo_card` | What a repo is: freshness, languages, neighbours, seam counts, where its wiki is | Technical planning | Built |
| `brain_search` | Ranked wiki sections and endpoints for keywords, across every readable repo | Any, when you don't know which repo holds the answer | Built over wiki sections and endpoints; curated context in phase 4 |
| `brain_get` | One item in full (page, glossary entry, ADR, symbol map) with citations | Feature planning, development | Built for wiki pages |

A hit looks like: `orders-web · src/api/orders.ts:42-58 · @9f3c1e2 · 2 commits behind · llm-generated`.

### Search

One SQLite FTS5 index with a row per wiki section (pages split at `##`/`###` headings) and per
route or call. Sections are searched on their repo, page title, heading, text (citations taken
out) and the files they cite, with camelCase file names also written apart. Endpoints are
searched on their method and path only. A query's words are OR'd and ranked by bm25 with Porter
stemming, headings weighted most. Rows are added where pages and seams are written and removed
by triggers, so a page rewrite, a deleted file or a removed repo can't leave stale hits.
Keyword search only: embeddings wait until evals show a gain (see "Not in v1").

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

- Agent-facing tools are read-only.
- Repo text, tickets and PR bodies are untrusted; tool output is data, never instructions.
- AI runs are read-only (Read, Grep, Glob), load no MCP servers, settings or skills, and store
  only pointers to the lines they cite.
- Permission filtering happens in the query layer, in one place.
- Removing a repo deletes all its rows and nothing else.

## Not in v1

- Code embeddings (only if evals show a gain, and fused with keyword search).
- A human UI.
- A graph database.
