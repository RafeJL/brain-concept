# Research summary (September 2026)

> A snapshot of the research the design started from. Some conclusions were later revised on
> evidence: routes and calls are now found by Claude Code and verified against cited lines, not
> parsed. See `decisions.md` (2026-10-05 onwards) for what changed and why.

What others built, what paid off, and what didn't. Condensed from three research passes:
codebase brains, organisation-wide context layers, and AI software factories. Vendor claims are
marked as such.

## Codebase knowledge

**Paid off**
- Agentic search (grep/glob/read) as the base layer. Claude Code dropped its early vector
  database because agentic search "generally works better" with fewer security, staleness and
  reliability problems ([Boris Cherny](https://x.com/bcherny/status/2017824286489383315)).
  Sourcegraph dropped embeddings for Cody Enterprise over upkeep and scale
  ([Sourcegraph](https://sourcegraph.com/blog/how-cody-understands-your-codebase)).
- Parser-built structure with no LLM. Aider's repo map (tree-sitter + PageRank) had the best
  context yield at tight token budgets in an independent benchmark
  ([arXiv 2607.24882](https://arxiv.org/html/2607.24882v1)). A structural index improved
  localisation and resolve rate, mostly on multi-file changes
  ([Code Isn't Memory, arXiv 2606.22417](https://arxiv.org/abs/2606.22417)); RepoGraph +2 points
  on SWE-bench Lite ([arXiv 2410.14684](https://arxiv.org/html/2410.14684v1)).
- Impact and caller queries at review time (Greptile's graph shape).

**Mixed**
- Embeddings. Cursor measured +12.5% answer accuracy offline but only +0.3% code retention
  online, and concluded grep plus semantic search together works best
  ([Cursor](https://cursor.com/blog/semsearch)). Augment's +80% is vendor-run on one repo.
- LSP symbol tools (Serena): help on refactors, cost 6–118% more tokens on lookups
  ([arXiv 2608.13568](https://arxiv.org/abs/2608.13568)).

**Did not pay off**
- LLM-generated prose presented as fact. DeepWiki was "confidently wrong" in most sections for
  one maintainer ([Lopker](https://blopker.com/writing/12-deepwiki/)). LLM-generated AGENTS.md
  files cut success ~3% and raised cost 20%+; human-written ones gave a non-significant +2.4%
  ([arXiv 2602.11988](https://arxiv.org/abs/2602.11988)).

## Organisation-wide context

- Context is finite and degrades as it grows ("context rot",
  [Chroma](https://www.trychroma.com/research/context-rot)); load just in time, disclose
  progressively ([Anthropic](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)).
- Few broad tools, concise/detailed response modes, pagination, ~25k token cap
  ([Anthropic](https://www.anthropic.com/engineering/writing-tools-for-agents)). Dropbox, Block and
  LinkedIn all cut their tool counts ([Dropbox Dash](https://dropbox.tech/machine-learning/how-dash-uses-context-engineering-for-smarter-ai),
  [Block](https://engineering.block.xyz/blog/blocks-playbook-for-designing-mcp-servers)).
- LinkedIn CAPT is the closest analogue: local MCP over code search across ~1,000 repos plus
  600+ versioned playbooks; 8,000+ daily users, ~20% productivity gain; stale knowledge was the
  named pain ([InfoQ](https://www.infoq.com/presentations/linkedin-context-engineering/)).
- GraphRAG is expensive and noisier on simple questions
  ([GraphRAG-Bench](https://github.com/GraphRAG-Bench/GraphRAG-Benchmark)); Dropbox moved off a
  graph database ([Dropbox](https://dropbox.tech/machine-learning/vp-josh-clemm-knowledge-graphs-mcp-and-dspy-dash)).
- Source quality dominates retrieval tricks (Uber Genie: +27% acceptable answers from better
  document processing, [Uber](https://www.uber.com/blog/enhanced-agentic-rag/)).
- Security: a public GitHub issue hijacked an agent into leaking private repo code through the
  official GitHub MCP server ([Invariant Labs](https://invariantlabs.ai/blog/mcp-github-vulnerability)).
  One identity reading everything makes that worse.
- Jira/Confluence already come through Atlassian's Rovo MCP with per-user permissions; don't copy them.

## Software factories (for the harness, not the brain)

This section concerns the harness repo (`citation-harness-library`); none of it is built here.

Components others run that the harness lacks, in suggested order: run telemetry (merge rate,
first-push CI pass, cost per merged PR), hard caps on fix loops (Stripe: 1–2 CI rounds), scoped
credentials and injection defences, accept/reject tracking on review findings (Uber uReview),
doc-gardening agents (OpenAI), acceptance scenarios the dev agent can't edit (StrongDM),
sandboxes with egress control, PR-size limits and tested rollback (DORA 2025).
Sources: [Stripe](https://stripe.dev/blog/minions-stripes-one-shot-end-to-end-coding-agents-part-2),
[Spotify](https://engineering.atspotify.com/2025/12/feedback-loops-background-coding-agents-part-3),
[Uber](https://www.uber.com/us/en/blog/ureview/), [DORA](https://dora.dev/dora-report-2025/),
[METR](https://metr.org/blog/2025-07-10-early-2025-ai-experienced-os-dev-study/).

## What it means for this repo

1. The cross-repo seam map is the core, and it is parser-built. (Revised in October 2026: it
   is found by Claude Code and every entry is verified against the lines it cites.)
2. Curated content is human-owned; agents draft PRs.
3. Wiki pages are advisory, cited, and checked.
4. Freshness is handled on merge, in the write path.
5. Few read-only MCP tools returning pointers with commit and staleness.
6. Prove value with harness evals before growing.
