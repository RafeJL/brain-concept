# How it works

What the brain holds, what agents can ask it, and how far to trust the answers. For setting it
up, see the [README](../README.md). For the design, see [architecture.md](architecture.md).

## What agents can ask

The MCP server tells Claude Code when to use it. It has eleven tools:
- six only read;
- four record what a person tells them, and count only once that person agrees;
- one adds a repo.

Claude Code asks the person to allow every call to the last five, even when the brain's tools are
allowed. A headless run (`claude -p`) has no one to allow it, so it can't write.

| Tool | Answers | From |
|---|---|---|
| `brain_repo_card` | What is this repo for, which system is it part of, which repos does it call and which call it, is there a wiki? While a repo is being enrolled: how far it has got. | The index, the product page, systems and the link map |
| `brain_get` | What it is, who uses it and its business rules, how to build and test it, what API it serves, how its key modules work; or an overview of a whole system | The repo's wiki pages; for a system, its repos' product pages and the links between them |
| `brain_search` | Where is this handled? (when you don't know which repo or page) | Every repo's wiki sections, endpoints and other links, and system names |
| `brain_find_consumers` | Who serves this endpoint, and who calls it? Who publishes this event and who handles it? The same for a gRPC method or a shared package | Routes, calls, events, gRPC and packages across every repo |
| `brain_review` | What's waiting for me to decide: proposed or stale facts, suggested systems, proposed notes; and what the brain couldn't answer | Facts, systems, notes and gaps |
| `brain_impact` | What breaks if I change this repo, file or endpoint? Or: which systems, repos and endpoints would this piece of work touch? | What it serves or publishes, and everyone who uses each; for work, the wiki and route map |
| `brain_record_fact` | Records a rule, term, purpose, decision or answer a person has just stated, on a repo or a system | The person, who agrees in the conversation |
| `brain_set_note` | Sets what a repo's wiki should focus on, when a person says so | The person, who agrees in the conversation |
| `brain_facts` | Confirms, rewords, re-anchors or retires a fact | The person, who agrees in the conversation |
| `brain_systems` | Confirms a suggested system, adds or moves repos, changes a summary, renames one | The person, who agrees in the conversation |
| `brain_add_repo` | Adds a repo, from GitHub or a local folder, in the background | The person, who asks for it and allows the call |

## Adding a repo

Adding a repo (`brain_add_repo`, or `brain add` in a terminal) does four things:
1. **Clone.** A GitHub repo is cloned with plain `git clone` and your own credentials, into
   `%USERPROFILE%\.brain\repos\<name>`. A local folder is used where it is.
2. **Index.** The brain reads the committed code on the main branch with git. Your uncommitted
   work is never read.
3. **Map and write.** Claude Code maps the repo's links and writes its wiki. These run side by side.
4. **Hook.** A git hook keeps the repo up to date from then on.

From Claude Code, this runs in a process of its own, so the call answers at once and the work
carries on after the session ends. It logs to `%USERPROFILE%\.brain\hooks.log`, like the hooks.

**Status.** Each step is recorded in the store as it happens: cloning, indexing, mapping links,
tracing, writing the wiki (k of n pages for a large repo), installing the hook. The repo's card
shows it, and so does any read tool that reaches the repo before it's indexed. MCP has no progress
bar between calls, so you find out by asking.

**Estimates.** The brain counts the repo's files (once it's cloned) and goes by how long earlier
enrolments of a similar size took. Until there are some, it uses rough figures by size, measured on
the trial repos, and says they're rough.

**When it fails.** The card says which step failed and why, for example what git said about a
clone. Adding the repo again redoes only what's missing. A run whose process ended without finishing
shows as stopped.

**Clones nobody pulls.** You never pull in the brain's own clones. So when a Claude Code session
starts, the brain fetches them in the background, at most once an hour, and their hooks do the rest.
The fetch never prompts for credentials.

## How far to trust an answer

- **Every claim is checked before it's stored, with no AI involved.**
  - Each sentence in a wiki page must cite lines that exist, at most 80 of them, and the names it
    mentions must appear there.
  - Each route or call must have its HTTP method and every fixed part of its path in the lines it
    cites. Each event, gRPC method or package must have its name, or each part of it, there.
  - Anything that fails is removed, and `brain sync` says what and why. On the trial repos about
    80% of wiki claims were kept, and the removals were real problems.
- **Every answer says when it's from:** the commit it describes, and how far behind the tracked
  branch that is (`@a397d11 · up to date`, or `2 commits behind origin/main`).
- **Systems are suggested by Claude Code and confirmed by a person.** A suggestion is stored only
  if its repos exist, none is in two systems, and each repo in it calls or is called by another
  member in the route map. Agents see unconfirmed systems labelled "suggested".
- **Everything Claude Code wrote is labelled `llm-generated`.** The check confirms the cited lines
  say what the claim names, not that the claim reads them correctly. So agents are told to confirm
  at the citation before relying on it.
- **Facts from people are labelled `human-reviewed`** once the person confirms them, with who and
  when, or "proposed" until then. Only the person can confirm: with their words in the conversation
  and their click on the permission prompt. Text in a repo can't plant one, since agents are told
  to record only what the person said.
- **Answers give file and line pointers, never pasted code.**
- **Gaps are stated, not hidden.** For example, calls whose URL (or events whose name) is only
  known at run time are counted and located.
- **Your code stays on your machine.** It is read only by your own Claude Code, in a temporary
  read-only copy at the indexed commit. That run has no other tools or MCP servers.

## The wiki

### For product owners

Every wiki has a **product page** in product language:
- who uses it, and what they can do;
- its business rules, each cited to the line that enforces it;
- its terms;
- what it depends on, and what it doesn't do.

Code names appear only in citations. The repo card opens with its first sentence:

```
react-web  @ee72eba · up to date
Product: Lets readers browse, write and discuss short-form articles, organise them by topic, and follow the authors they want to keep up with. · read with brain_get (page "product")
System: RealWorld (with aspnet-api, express-api, flask-api, laravel-api) · overview with brain_get (system "RealWorld")
```

**Systems** say which repos make up one product. Claude Code suggests them (`brain systems
suggest`, cents, from the repos' cards and links, not their code), and a person confirms them.
A system's overview (`brain_get` with `system`) lists its repos, what each is for and how they
connect. It is put together when asked, so it is never out of date.

**Which repos would a piece of work touch?** `brain_impact` with `work` searches the wikis (product
pages first) and the route map, and groups what it finds by system. It also names the repos that
call the matching endpoints. No AI runs, so it is instant and free; the calling agent does the
reasoning.

### For technical plans

A **small repo** (most services and libraries) gets five to seven pages in one run: overview,
build and test, API, its most important module, the product page, and data-model and integrations
pages when it has them.

A **large repo** has 200 or more source files outside tests, or four or more projects, such as
eShop's twenty. It gets a wiki that fits it. First, a free count of its folders, projects and entry
points (no AI) is handed to a planning run, which picks its pages:
- the core pages: overview, build and test, API, and product;
- a page per area a developer would work in on its own, such as Basket, Ordering or Identity;
- up to three **flow** pages: a journey, such as checkout, as numbered, cited steps;
- a **data-model** page and an **integrations** page.

There are at most 20 pages. They're written four to a run, side by side, each run starting from
its pages' key files. `brain wiki plan <repo>` shows the plan.

The overview and each flow page carry a Mermaid diagram. A comment above each box and message
cites the code, and every element is checked like a sentence. Agents get the text without the
diagrams unless they ask, since the text says the same.

### How the wiki follows the code

- **Lines shift:** when a commit only shifts the lines a page cites, the citations move with them
  and no AI runs.
- **Cited lines change:** only the pages citing them are rewritten. A rewrite that fails the check
  twice keeps the last good version, which then says it's "kept from @…".
- **A new project or area:** the plan is made again, adding pages only for what's new.
- **A steering note:** a person sets one (`brain note <repo> "Ordering matters most"`, or an agent
  with `brain_set_note` once they agree). It re-plans the wiki at the next sync, and each page
  follows it when it's next rewritten. It can't switch off a check.

## Links between repos

The brain maps the HTTP routes each repo serves and calls, the events it publishes and handles, its
gRPC services and its shared packages. C#, TypeScript, Python and PHP servers sit side by side, each
with its full path. No language needs any setup.

- **Names match exactly**, ignoring case and package versions. Paths match with parameters in any
  style, and a base path such as `/api` may differ between server and caller.
- **Shared databases aren't linked:** table names like `users` repeat across unrelated databases.

### Following a flow

`brain_find_consumers` with `follow` (or `consumers "POST /api/orders" --follow`) also shows:
- what starts it: the UI actions and jobs that lead to it, such as the web and mobile checkouts;
- what handling it sets off, hop by hop, until the flow ends.

Hops go two ways:
- **Between repos:** the calls it makes and events it publishes, then who serves or handles those.
- **Through tables:** the tables it reads and writes. Within a repo, the trace continues from a
  table's writer to a job that polls it. Between repos, a table is only named, never linked.

Each hop is a chain of cited steps from the handler to the line that makes the call, checked
without AI. A step that reaches nothing says "ends here", and one not yet mapped says so.

The chains come from a third run in the links step. Sync keeps them current: lines that only move
cost nothing, and only chains whose code changed are followed again.

## Facts from people

The code can't say everything: "follows are capped at 500 because people bulk-followed" lives in
someone's head. When a person tells their agent something like that, the agent offers to record it
with `brain_record_fact`. Two things make it the person's decision, not the agent's:
- **Their words.** The agent shows the fact and asks; the call carries their reply ("yes, record
  that"), and it is stored with the fact. Without it, the fact is only *proposed*.
- **The permission prompt.** Claude Code asks the person to allow the call, showing what will be
  stored. An agent can't click it.

Confirmed facts are stored as `human-reviewed`, with who, when and their words, and come first: at
the top of the product page, on the card, in search and in system overviews.

```
## From people

- Users can follow at most 500 authors. (rule · human-reviewed · Rafe Loveday, 2026-10-12 · enforced at src/follow.ts:2 · fact #1)
```

- **Proposed facts wait.** Agents see them labelled "proposed" until the person agrees
  (`brain_review` lists them; `brain_facts` confirms them). Rewording a confirmed fact without the
  person's agreement makes it proposed again.
- **A changed rule replaces the old one.** The old fact is retired when the new one is confirmed,
  so the two never both stand.
- **Anchored facts go stale.** A fact can point at the lines that enforce it. When those lines
  change, the next sync marks it stale ("re-confirm before relying on it").
- **Checked against the code.** On the next sync, Claude Code reads each new or changed fact against
  the code and says whether the code **agrees**, **contradicts** it, or has **nothing for it**. The
  answer must cite lines that pass the usual check, and it never changes the fact.
- **Gaps:** searches the brain couldn't answer are logged on your machine. `brain_review` lists
  the most asked, which is what is worth writing down.

## What it can't do yet

Found on real Citation repos (2026-10-13). Fixes are planned (B6b).
- **Links in very large repos are a sample.** On a monolith with hundreds of controllers, the link
  map holds only some of the routes and calls, and varies from run to run. Treat "no consumer
  found" or "no matching routes" there as unknown, not as none. Wiki pages stay accurate.
- **Calls and queues named at run time end a trace.** When a URL or queue name comes from config,
  the trace says "ends here" where the code actually calls out.
- **Paths with spaces can't be cited**, so files under such folders aren't described.
- **Search by meaning:** `brain_search` matches words, not synonyms. Search "auth" rather than
  "login security".
- **Flows across repos as pages:** a flow page covers one repo. Following a flow across repos is a
  trace (`follow`), not a page.
- **Hosting:** it runs on your machine. A hosted version with GitHub permissions is phase 6.
- **Cancelling an enrolment** from Claude Code. In a terminal, `brain repo remove <name>` refuses
  while it runs and names the process to stop.
