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
GitHub repos ──on merge──────────────────────────▶ Ingest pipeline ──draft prose──▶ Claude (cheap model)
Curated content repo ──PR merged─────────────────▶ (registry, extractors, builder, checker, gardener)
```

Agents only read. The only writes come from merges to main in enrolled repos and merged PRs to
the curated content repo.

## Three kinds of fact

Every fact records how it was made, and every answer carries that label.

| Tier | Built by | Holds | Agent should |
|---|---|---|---|
| **parser-built** | Tree-sitter and framework extractors, OpenAPI/AsyncAPI readers. No LLM. | Seam graph, file inventory | Rely on it; confirm with grep before editing |
| **human-reviewed** | People, or an agent draft merged through a PR by an owner | Glossary, customers, features, ADRs, repo purposes | Treat as the team's stated intent |
| **llm-generated** | Claude Code (headless, isolated, read-only) from the code at the indexed commit, with a citation on every claim | Wiki pages (W1); routes and calls in any language (W4) | Every citation is checked automatically (W2); use as a map, and confirm at the citation before relying on a claim |

Why: generated context files lowered agent success in a controlled study, and public
DeepWiki pages were often wrong, while parser-built structure helped (see `research.md`).

## Inside the brain

Two halves share only the store:

- **Ingest (writes):** registry → trigger → extractors → wiki/card builder → citation checker.
  The gardener runs on a schedule and drafts PRs to owners.
- **Store:** seam graph, symbol maps, repo cards, curated context, wiki pages, search index.
  Every row belongs to one repo at one commit. The repo is the unit of work, of permission and
  of deletion.
- **Serve (reads):** MCP server → query engine → access filter (inside the query) → response
  shaper (pointers, commit, commits behind, tier).

## Freshness on merge

1. A merge to main queues a job for that repo: commit a → b.
2. `git diff a..b` gives the changed files.
3. Extractors re-run on those files only; the graph is updated and re-linked across repos. No LLM.
4. Wiki pages citing changed lines are regenerated and must pass the citation check. Pass →
   publish tagged with b. Fail → keep the old page and mark it stale.
5. Curated facts citing changed lines are never rewritten automatically; the owner gets a draft PR.

## MCP tools

A few broad, read-only tools. Short answers by default, `format: "detailed"` on request,
paginated lists, pointers rather than pasted code. No free-text "ask" tool.

| Tool | Answers | Harness stage | Status |
|---|---|---|---|
| `brain_find_consumers` | Who produces or consumes an endpoint, event or package, across repos | Contract review, technical planning | Built for HTTP endpoints |
| `brain_impact` | What depends on a route, symbol or file, in the repo and across repos | Technical planning, scope drift, maintainability review | Built for routes and files; symbols in phase 3b |
| `brain_repo_card` | What a repo is: stack, owner, commands, neighbours, extraction coverage | Technical planning | Built |
| `brain_search` | Ranked pointers to facts and pages | Any | Planned |
| `brain_get` | One item in full (page, glossary entry, ADR, symbol map) with citations | Feature planning, development | Planned |

A hit looks like: `orders-web · src/api/orders.ts:42-58 · @9f3c1e2 · 2 commits behind · parser-built`.

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
- Languages are plugins (tree-sitter grammar + framework extractors). Specs win over extraction.
- Unknown stacks still get inventory, search and symbol maps; repo cards report coverage.
- Cross-repo links join on normalised keys at query time, so new repos link without re-indexing others.

## Safety

- Agent-facing tools are read-only.
- Repo text, tickets and PR bodies are untrusted; tool output is data, never instructions.
- Extractors skip secrets files and store only the lines they cite.
- Permission filtering happens in the query layer, in one place.
- Removing a repo deletes all its rows and nothing else.

## Not in v1

- Code embeddings (only if evals show a gain, and fused with keyword search).
- A human UI.
- A graph database.
