# Working on the brain

For trying the brain, see the [README](../README.md). This page is for changing it.

## Checks

```
npm ci
npm run check
```

`npm run check` runs the typecheck and the full test suite (about a minute). Each test builds its
own throwaway git repos from `test/fixtures/repos/`. Wiki and seam tests use recorded Claude Code
answers (`test/fixtures/wiki/`, `test/fixtures/seams/`), so they never call the AI, but the
verification runs for real against the fixture files. Keep cited line numbers in those
recordings in step with the fixture files.

The npm scripts call `tsc` and `vitest` through `node` rather than the `node_modules/.bin`
shims, because group policy on Citation laptops blocks those shims. That is also why the
project uses TypeScript 6: TypeScript 7 is a native binary.

Before merging a change to what the brain writes or answers, also run the
[manual testing guide](manual-testing.md). It covers a playground built from real repos with a
local stand-in for GitHub, real open-source repos, and fresh Claude Code sessions. Use a
throwaway store (`$env:BRAIN_DB = "$env:USERPROFILE\.brain\playground.db"`) so your real one is
untouched.

## Layout

```
bin/            launchers that run the TypeScript from any folder (tsx, no build step)
src/cli.ts      the brain CLI; prints exactly what agents get
src/doctor.ts   brain doctor's checks
src/core/       types, git access, languages, HTTP path matching, citations, page sections, the per-repo run queue
src/store/      Store interface, SQLite implementation, migrations, the search index
src/ingest/     registry, sync (the git index), hooks
src/ai/         Claude Code runner, prompts (Markdown), wiki pages, routes and calls, system suggestions, the checks on all three
src/serve/      access policy, freshness, neighbours, systems, tools, MCP server (the read side)
test/           vitest; fixtures are real files in their own languages
docs/           architecture, decisions, research, manual testing
```

Rules for changing it (and for agents working here) are in [CLAUDE.md](../CLAUDE.md).

## How a sync works

`brain sync <name>`, which `brain add` and the hook also run, does three things:
1. **Index:** reads the committed tree at the tracked ref with git (never the working copy) and
   records changed files. There is no AI in this step, and `--no-ai` stops here.
2. **Routes and calls:** one Claude Code run lists every HTTP route served and call made, with
   cited lines.
   - Each one is verified before storing: the cited lines exist, and its method and every fixed
     path segment appear in them.
   - Failures are asked for once more with the reasons, then dropped and reported.
   - After the first run, only changed files (and files whose paths they help build) are redone.
3. **Wiki:** one Claude Code run writes or updates the pages.
   - The citation checker removes unsupported claims.
   - A page with under half its claims kept is written once more. If it fails again, the last
     good version is kept.
   - Pages that cite nothing changed are re-checked and carried forward with no AI.
   - A page every wiki should have but this one lacks (`src/ai/prompts/pages.md`; the product
     page, for wikis written before it existed) is written in a run of its own, leaving the
     others alone.

`brain systems suggest` is the one AI run outside a sync. It reads no code: Claude Code gets a
small file with each repo's card facts, the opening of its product page and its links, and the
suggestions are checked (`src/ai/systems.ts`) before they are stored as `suggested`.

Claude Code runs headless (`src/ai/runner.ts`), in a temporary git worktree at the indexed
commit, with `--safe-mode --strict-mcp-config` and only Read, Grep and Glob. It loads no MCP
servers, settings or skills, so it can't call the brain or anything else. The prompts are
Markdown in `src/ai/prompts/`. Sonnet is the default model (`--model` to change it). The search
index is updated in the same transactions as pages and seams.

## Keeping it fresh

`brain hooks install` puts a git `reference-transaction` hook in each enrolled repo.
- When the tracked ref moves, it starts `brain sync <name>` in the background and returns at
  once, so git is never slowed down. This includes a plain `git fetch`, which has no hook of its
  own.
- Runs are logged to `%USERPROFILE%\.brain\hooks.log`.
- Only one sync per repo runs at a time. If the branch moves mid-run, that run goes round once
  more when it finishes. A lock left by a crashed run is taken over.
- Hooks run whichever brain code is checked out in this folder.
- `brain doctor` flags hooks an older brain wrote; `brain hooks install` refreshes them.

The hook isn't installed if the repo already has its own `reference-transaction` hook, or if
`core.hooksPath` points inside the repo (as husky does), because that would change tracked files.

## Design docs

- [architecture.md](architecture.md): what is being built. Treat it as the spec.
- [decisions.md](decisions.md): every dated decision, with the evidence. The parser-era ones are
  marked superseded.
- [research.md](research.md): what others built, as researched in September 2026.

## Where it's going

| Phase | | Status |
|---|---|---|
| 0, 1, 3a | Index, seam graph, `brain_find_consumers`, `brain_impact`, repo cards, auto-sync | ✅ |
| W0–W5 | The switch to AI-written wikis: Claude Code writes wikis and maps routes and calls in any language, every citation checked; the parsers removed; `brain_search` | ✅ |
| 2 | Harness evals | Waiting on how the harness integrates |
| 4 | Curated context: people correct and confirm facts (`human-reviewed`) | Planned |
| 6 | Hosting: Azure, cloud containers for the runs, GitHub permissions | Planned |
