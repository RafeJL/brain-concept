# brain-concept

The brain gives coding agents context about your organisation's repos, over MCP.
For each repo you add, Claude Code writes a wiki in which every sentence cites the code it's based on.
The brain also maps how repos depend on each other: HTTP calls, events, gRPC and shared packages.
Agents ask it for what they need, instead of cloning and reading whole repos.

It's a local proof of concept for the Citation delivery harness.
It runs on your machine, reads your clones, and uses your own Claude Code.

## Set it up

This takes about 10 minutes, in PowerShell.

1. Install Node 24 (22.13 or later works), Git for Windows and Claude Code.
   Sign in to Claude Code by running `claude` once.

2. Clone this repo and go into it:

   ```powershell
   git clone https://github.com/RafeJL/brain-concept.git
   cd brain-concept
   ```

3. Install its packages:

   ```powershell
   npm install
   ```

   npm may warn about install scripts. That's harmless.

4. Check what's in place:

   ```powershell
   npm run brain -- doctor
   ```

   Each line shows ✓ or ✗, and each ✗ says how to fix it.
   The MCP server shows ✗ until the next step.

5. Register the brain with Claude Code.
   Doctor prints the exact command for your machine. It looks like this:

   ```powershell
   claude mcp add --scope user citation-brain -- node "C:\Repos\brain-concept\bin\brain-mcp.mjs"
   ```

   `--scope user` makes the brain available in every folder.

6. Run doctor again. Every line should show ✓.

   ```powershell
   npm run brain -- doctor
   ```

7. Start a new Claude Code session and type `/mcp`.
   `citation-brain` should show as connected.

## Add repos

### From Claude Code

Ask in plain words, in any session. For example:

- *Add github.com/The-Citation-Group-Tech/foo to the brain.*
- *Add The-Citation-Group-Tech/foo to the brain, and focus its wiki on billing.*
- *Add the repo in C:\Repos\foo to the brain.*

Then:

1. The agent tells you roughly how long it will take and what it costs, and asks.
2. Claude Code asks you to allow the `brain_add_repo` call. It asks every time, by design.
3. The brain starts the work in the background and answers at once.
   It carries on if you close the session.

A GitHub repo is cloned with your own git credentials, into `%USERPROFILE%\.brain\repos`.
A local folder is used where it is.
The brain only reads committed code on the main branch, never your uncommitted work.

### From a terminal

```powershell
npm run brain -- add https://github.com/The-Citation-Group-Tech/foo
```

```powershell
npm run brain -- add C:\Repos\foo
```

It prints an estimate, then each step as it goes.
To add several, list them all: they go three at a time.

### How long it takes

Measured when adding real repos (several go side by side, so the times overlap):

| Repo | Files | Time | Claude Code usage |
|---|---|---|---|
| A small service (unity-idp-middleware) | about 120 | a few minutes | about $1.50 |
| A medium one (atlas-ai-audit-ai-be-app, Python) | about 800 | 10–20 minutes | about $7 |
| A large one (eShop) | about 1,100 | 15–25 minutes | about $8–12 |
| A monolith (atlas-webapp-webapi) | about 23,000 | about 25 minutes | about $11 |

The wiki has at most 20 pages, so a monolith costs little more than a large repo, but it's
described less deeply (see [what it can't do yet](docs/how-it-works.md#what-it-cant-do-yet)).
The estimate improves as you add repos: the brain goes by how long earlier ones took.

### Is it ready?

Ask the agent: *Is foo ready yet?*
It reads the repo's card. While the repo is enrolling, the card says where it has got to:

```
foo  @3bd7882 · up to date
Being enrolled: tracing what each entry point leads to; writing the wiki (4 of 18 pages) · started 6 min ago
Expect roughly 15–25 minutes and $8–12 of Claude Code usage (rough: from its size alone, 2431 files) in all.
Not ready to plan from yet: its wiki and links are still being written. Check its card again for progress.
```

- **Done:** the card shows the wiki and links, and says `Enrolled … ready.`
- **Failed:** the card says what failed. Ask the agent to add it again. It redoes only what's missing.
- **From a terminal:** `npm run brain -- card foo`.

Agents won't plan from a repo that is still enrolling.
You can ask about a new repo straight away in the same session.
It only appears in the brain's list of repos in new sessions.

## What to ask

You don't need to name the brain or its tools. Ask about a repo or product by name.

**Product brief (a PO):**
- *What does foo do, and who uses it?*
- *What rules apply to following authors in RealWorld?*
- *Which repos would "let users save articles to read later" touch?*
- *Users can follow at most 500 authors: record that.*
  The agent shows you the fact and asks. You say yes and allow the call.
- *What's waiting for me to confirm?*

**Technical plan:**
- *Plan adding a delivery date to orders in eShop.*
- *How does checkout work, end to end?*
- *Which repos call `GET /api/orders/{id}`?*
- *What would changing how orders are created set off downstream?*

**Development:**
- *How do I run the tests in foo?*
- *Where do we validate login tokens?*
- *What breaks if I rename this endpoint?*

The harness's skills call the same tools.

## Keeping repos up to date

There's nothing to do.

- Each repo gets a git hook. When its main branch moves (a pull or a fetch), the brain updates it in the background.
- Repos the brain cloned are fetched when you start a Claude Code session, at most once an hour.
- Updates redo only what changed. They cost cents, or nothing when nothing relevant changed.
- Every answer says which commit it describes, and how far behind the main branch that is.

## Troubleshooting

- **Something's wrong.** Run `npm run brain -- doctor` first.
- **Claude Code doesn't use the brain.**
  - Start a new session. Sessions load MCP servers when they start.
  - Type `/mcp`. `citation-brain` should show as connected.
  - Ask about the repo or product by name.
- **The brain's tools don't load.**
  - Run `claude mcp get citation-brain`. Its path should point at this folder.
  - Run that command on its own, e.g. `node C:\Repos\brain-concept\bin\brain-mcp.mjs`.
    It should print `citation-brain MCP server ready`. Press Ctrl+C to stop it.
  - If you moved this folder, run doctor. It prints the commands to register it again.
- **A repo is still enrolling.** Ask for its card. A large repo can take half an hour.
  If the card says it stopped or failed, ask the agent to add it again.
- **A GitHub repo won't clone.** The card says what git said.
  Check you can clone it yourself with `git clone <url>`.
- **A repo isn't updating.** Run `npm run brain -- hooks status`.
  Background work is logged to `%USERPROFILE%\.brain\hooks.log`:

  ```powershell
  Get-Content -Encoding utf8 -Tail 50 $env:USERPROFILE\.brain\hooks.log
  ```

- **Group policy blocks `node_modules\.bin`.** That's why every command here runs through `node`.
  Use the npm scripts, not `npx`.

## Removing it

- **One repo.** This removes everything the brain holds about it, its hook, and the brain's clone of it:

  ```powershell
  npm run brain -- repo remove foo
  ```

- **The MCP server:**

  ```powershell
  claude mcp remove citation-brain -s user
  ```

- **Everything.** Delete `%USERPROFILE%\.brain`. It holds the store, the log and the brain's clones.

## More

- [How it works](docs/how-it-works.md): what each tool answers, how far to trust it, facts from people, the wiki, links between repos, and limits.
- [Commands](docs/cli.md): every terminal command.
- [Working on the brain](docs/development.md): tests, layout and design docs.
- [Manual testing](docs/manual-testing.md): checking changes against real repos.
