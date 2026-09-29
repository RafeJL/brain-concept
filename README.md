# brain-concept

Organisation-wide engineering context for coding agents, served over MCP.

The brain indexes the organisation's repositories and answers narrow questions ("what is this
repo?", later "who calls this endpoint?") with small, cited answers. Each answer names the commit
it describes, how far behind the tracked branch that is, and how the fact was made. The
Citation delivery harness calls it; it never moves code out of the harness.

Read [`docs/architecture.md`](docs/architecture.md) first. The evidence behind the design is in
[`docs/research.md`](docs/research.md), and dated decisions in [`docs/decisions.md`](docs/decisions.md).

**Status:** phase 0, the walking skeleton. Repos can be enrolled and synced, and `brain_repo_card`
works over MCP. The seam graph (phase 1) comes next.

## Requirements

- Node 22.13 or later (uses the built-in `node:sqlite`, so there are no native builds)
- git on `PATH`

```
npm ci
npm run check        # typecheck + tests
```

The npm scripts call `tsc` and `vitest` through `node` rather than through the `node_modules/.bin`
shims, because group policy on Citation laptops blocks those shims.

## Commands

Run from this folder with `npm run brain -- <command>`, or from anywhere with
`node C:\Users\Rafe.Loveday\Repos\brain-concept\bin\brain.mjs <command>`.

| Command | Does |
|---|---|
| `repo add <path> [--name n] [--ref branch]` | Enrol a local clone. The name defaults to the folder; the ref defaults to the branch `origin/HEAD` points at. |
| `repo list` | Enrolled repos, the commit each is indexed at, and how far behind it is. |
| `repo remove <name>` | Remove a repo and every fact about it. |
| `sync [<name>]` | Index the tracked branch's committed tree (not your working copy). All repos if no name. |
| `card <name> [--detailed]` | Print exactly what an agent gets from `brain_repo_card`. |

The store lives at `%USERPROFILE%\.brain\brain.db`. Set `BRAIN_DB` to use a different file,
for example a throwaway one while testing.

## Use it from Claude Code

Register the MCP server once (user scope, so it is available in every repo):

```
claude mcp add --scope user citation-brain -- node C:\Users\Rafe.Loveday\Repos\brain-concept\bin\brain-mcp.mjs
```

Then, in any Claude Code session, ask something like "use brain_repo_card to tell me about
citation-harness-library". Run `/mcp` to check the server is connected.

## Try it (phase 0 test script)

1. Enrol and index the harness repo:
   ```
   npm run brain -- repo add ..\citation-harness-library
   npm run brain -- sync
   npm run brain -- card citation-harness-library
   ```
   Expect `@<sha> · up to date · parser-built` and a language breakdown led by Markdown.
2. Run `npm run brain -- sync` again. Expect `+0 ~0 -0`, because unchanged files are skipped.
3. Clone a repo in another stack and enrol it:
   ```
   mkdir C:\Users\Rafe.Loveday\Repos\brain-test-repos
   git clone https://github.com/gothinkster/node-express-realworld-example-app C:\Users\Rafe.Loveday\Repos\brain-test-repos\realworld-express
   npm run brain -- repo add C:\Users\Rafe.Loveday\Repos\brain-test-repos\realworld-express
   npm run brain -- sync realworld-express
   npm run brain -- repo list
   ```
4. Staleness: make a commit on `main` in any enrolled test repo. `repo list` should say
   `1 commit behind main` until you sync again.
5. Register the MCP server (above) and ask Claude Code for both repo cards.
6. `npm run brain -- card nope` should list only the repos you enrolled.

## Layout

```
bin/            launchers that run the TypeScript from any folder
src/core/       types, git access, language detection
src/store/      Store interface, SQLite implementation, migrations
src/ingest/     registry and sync (the write side)
src/serve/      access policy, freshness, tools, MCP server (the read side)
test/           vitest; each test builds its own throwaway git repos
docs/           architecture, research, decisions
```
