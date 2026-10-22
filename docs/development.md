# Working on the brain

For setting the brain up, see the [README](../README.md); for every command,
[cli.md](cli.md); for what it answers and how far to trust it, [how-it-works.md](how-it-works.md).
This page is for changing it.

## Checks

```
npm ci
npm run check
```

`npm run check` runs the typecheck and the full test suite (a few minutes). Each test builds its
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
src/core/       types, git access, languages, HTTP path and link-name matching, citations, page sections, the per-repo run queue
src/store/      Store interface, SQLite implementation, migrations, the search index
src/ingest/     registry, sync (the git index), hooks, enrolling (sources, clones, progress, background runs)
src/ai/         Claude Code runner, prompts (Markdown), wiki pages, seams (routes, calls and other links), system suggestions, the checks on all three
src/serve/      access policy, freshness, neighbours, systems, enrolment status, tools, MCP server (the read side)
test/           vitest; fixtures are real files in their own languages
docs/           how it works, commands, architecture, decisions, research, manual testing
```

Rules for changing it (and for agents working here) are in [CLAUDE.md](../CLAUDE.md).

## How a sync works

`brain sync <name>`, which `brain add` and the hook also run, first indexes the committed tree at
the tracked ref with git (no AI; `--no-ai` stops there). Then three steps run side by side: links
(survey, screen, map, the separate links run, traces), the wiki (four pages to a run on a large
repo), and fact checks. What each step does and redoes on an update is in
[architecture.md](architecture.md#freshness-on-merge) and its "Seams" section.

`brain systems suggest` and `brain facts check` run Claude Code outside a sync. Suggesting
systems reads no code: Claude Code gets a small file with each repo's card facts, the opening of
its product page and its links, and the suggestions are checked (`src/ai/systems.ts`) before they
are stored as `suggested`.

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

Repos the brain cloned from GitHub (in `%USERPROFILE%\.brain\repos`) have no one to pull them, so
the MCP server fetches them in the background when a session starts, at most once an hour. Their
hooks then sync them as above.

## Testing enrolment

How adding a repo works is in [architecture.md](architecture.md#adding-a-repo-from-claude-code-b7).
Its tests run the real CLI in the background with `--no-ai`, and clone from local bare repos
through git's `url.<base>.insteadOf` (set with `GIT_CONFIG_COUNT`), so they never reach the
network.

## Docker and AWS

Hosting is on AWS ECS, running the image this repo builds (`decisions.md`, 2026-10-22). The
infrastructure (ECR, the cluster, EFS, the role GitHub assumes) is Terraform in a separate repo
the Platform Team owns, made from their golden template; nothing here depends on it yet.

- **`Dockerfile`**: Node 22 (slim Debian), git, Claude Code at a pinned version
  (`CLAUDE_CODE_VERSION`; bump it on purpose, since it changes how wikis are written), the brain
  with production dependencies only (`tsx` is one: the launchers run the TypeScript directly).
  Runs as the image's `node` user (uid 1000). The default command is `brain doctor`; `brain` and
  `brain-mcp` are on the path. Claude Code has the brain registered for that user, so `claude` run
  in the container can ask it.
- **One data directory**, `BRAIN_DATA` (default `/data`). `docker/entrypoint.sh` points `BRAIN_DB`
  at `$BRAIN_DATA/brain.db`, so the clones, locks and `hooks.log` sit beside it, and `TMPDIR` at
  `$BRAIN_DATA/tmp`, where the temporary worktrees go. Mount a volume there (EFS on ECS, with an
  access point owned by uid 1000), or the store and the clones are lost when the container
  restarts. Set `BRAIN_DB` or `TMPDIR` yourself to split them, e.g. worktrees on local disk.
- **`.github/workflows/image.yml`**: on every pull request and push to main it runs
  `npm run check`, builds the image and runs `brain doctor` in it. On main it also pushes to ECR as
  `<sha>` and `latest`, through GitHub OIDC (`aws-actions/configure-aws-credentials`), once the
  repository variables `AWS_ROLE_ARN`, `AWS_REGION` and `ECR_REPOSITORY` are set; until then it
  builds and says why it didn't push. Citation laptops can't run containers (virtualisation is
  off), so that pull-request run is where the image is tested.

**Claude through Bedrock.** In the container Claude Code reaches Claude through Amazon Bedrock,
with the ECS task role's credentials (the AWS SDK's default chain), not a sign-in. Set on the task:

| Variable | Value |
|---|---|
| `CLAUDE_CODE_USE_BEDROCK` | `1` |
| `AWS_REGION` | the Bedrock region, e.g. `eu-west-2`; Claude Code doesn't read it from AWS config |
| `ANTHROPIC_DEFAULT_SONNET_MODEL` | the Bedrock model or inference-profile ID that `sonnet` (the brain's default `--model`) means |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` | the ID for Claude Code's small background model, if the account's default isn't enabled |
| `ANTHROPIC_MODEL` | optional; only for `claude` run by hand, since the brain always passes `--model` |

The task role needs `bedrock:InvokeModel` and `bedrock:InvokeModelWithResponseStream` on those
models, and the models must be enabled in the account. The brain's runs (`--safe-mode`) load no
settings files, so these go in the environment, not `settings.json`. The image also sets
`DISABLE_AUTOUPDATER` and `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`. The other variables the image
reads are `BRAIN_DATA`, `BRAIN_DB`, `BRAIN_REPOS` and `TMPDIR`, as above.

**What's left for hosting** (each its own phase):
- The Streamable HTTP MCP transport, behind Entra ID sign-in; the server is stdio only today.
- Postgres (RDS) behind the `Store` interface, replacing SQLite on a volume.
- Credentials for cloning private GitHub repos (a GitHub App), and per-caller permissions in
  `AccessPolicy`.
- Freshness without local hooks: a GitHub webhook that queues a sync.
- Locks and enrolments that survive a restart. Sync locks (`src/core/queue.ts`) and running
  enrolments are judged alive by their process id. On a volume that outlives the container, a new
  container can reuse an old id, so a lock left by a crash could block a repo's syncs. Record which
  container wrote them, or clear them on start once only one task uses the volume.
- The Terraform, in the Platform-owned `<project>-terraform` repo, and the OU and account it goes
  in; non-prod first.

## Design docs

- [architecture.md](architecture.md): what is being built. Treat it as the spec.
- [decisions.md](decisions.md): the dated decisions that stand. Superseded ones, and the long
  evidence behind some that stand, are in [decisions-archive.md](decisions-archive.md).
- [research.md](research.md): what others built, as researched in September 2026.

## Where it's going

| Phase | | Status |
|---|---|---|
| 0, 1, 3a | Index, seam graph, `brain_find_consumers`, `brain_impact`, repo cards, auto-sync | ✅ |
| W0–W5 | The switch to AI-written wikis: Claude Code writes wikis and maps routes and calls in any language, every citation checked; the parsers removed; `brain_search` | ✅ |
| 2 | Harness evals | Waiting on how the harness integrates |
| 4 (B3) | Facts from people (`human-reviewed`): `brain_record_fact`, staleness, gaps; each fact checked against the code | ✅ |
| 4 (B4) | Technical depth: page plans for large repos, area, flow, data-model and integrations pages, checked diagrams, a steering note, steps and repos side by side; following a flow across repos | ✅ B4a; B4b built |
| B5 | Everything a person does through MCP: confirming in the conversation, `brain_review`, `brain_facts`, `brain_systems` (replaces `brain web`, dropped) | Built |
| B6 | Real Citation repos and the readiness gate | Trial done (findings drove B6b) |
| B6b | Maps that say what they covered: survey, screening, mapping in parts, inherited routes, coverage in answers, run-time exits in traces | Built |
| B7 | Adding a repo from Claude Code (`brain_add_repo`, the eleventh tool), GitHub sources, enrolment status on the card; the README rewritten for setting up | Built |
| B8 | Planning depth: strict tool inputs, several pages per `brain_get`, a conventions page, tests in build-run-test, steps renumbered after removals | Built |
| 6 | Hosting on AWS ECS: the Docker image and its pipeline; then HTTP transport, Postgres, GitHub permissions | Image and pipeline written; the rest planned |
