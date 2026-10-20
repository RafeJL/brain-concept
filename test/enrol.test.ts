import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterEach, describe, expect, it } from "vitest";
import type { Enrolment } from "../src/core/types.js";
import { estimateEnrolment, fetchClones, liveStatus, parseRemote, resolveSource, trackEnrolment } from "../src/ingest/enrol.js";
import type { HookCommand } from "../src/ingest/hooks.js";
import { enrolRepo } from "../src/ingest/registry.js";
import { syncRepo } from "../src/ingest/sync.js";
import { LOCAL_CALLER, LocalAccessPolicy, type AccessPolicy } from "../src/serve/access.js";
import { getPage } from "../src/serve/tools/get-page.js";
import { cardRequest } from "../src/serve/tools/repo-card.js";
import { search } from "../src/serve/tools/search.js";
import { SqliteStore } from "../src/store/sqlite.js";
import { commit, connect, git, repoFromFixture, tempDir, waitFor } from "./helpers.js";

const BRAIN = fileURLToPath(new URL("../bin/brain.mjs", import.meta.url));
const local = new LocalAccessPolicy();

/** An enrolment as the store holds it, running in this test's own process unless changed. */
function enrolment(repo: string, change: Partial<Enrolment> = {}): Enrolment {
  const at = new Date().toISOString();
  return {
    repo,
    source: `acme/${repo}`,
    status: "running",
    step: "cloning it",
    error: null,
    pid: process.pid,
    files: null,
    estimate: null,
    costUsd: 0,
    startedAt: at,
    updatedAt: at,
    finishedAt: null,
    ...change,
  };
}

/** The pid of a process that has already ended. */
const ended = () => spawnSync(process.execPath, ["-e", ""]).pid;

describe("where a repo comes from", () => {
  const noFolders = () => false;

  it("reads GitHub URLs in any form, and owner/repo, as a clone over https unless given in SSH form", () => {
    const https = { url: "https://github.com/acme/orders-api.git", name: "orders-api" };
    const ssh = { url: "git@github.com:acme/orders-api.git", name: "orders-api" };

    expect(parseRemote("https://github.com/acme/orders-api", noFolders)).toEqual(https);
    expect(parseRemote("https://github.com/acme/orders-api.git", noFolders)).toEqual(https);
    expect(parseRemote("https://github.com/acme/orders-api/tree/main/src?tab=readme", noFolders)).toEqual(https);
    expect(parseRemote("github.com/acme/orders-api", noFolders)).toEqual(https);
    expect(parseRemote("acme/orders-api", noFolders)).toEqual(https);
    expect(parseRemote(" acme/orders-api.git ", noFolders)).toEqual(https);
    expect(parseRemote("git@github.com:acme/orders-api.git", noFolders)).toEqual(ssh);
    expect(parseRemote("ssh://git@github.com/acme/orders-api", noFolders)).toEqual(ssh);
  });

  it("clones any other git URL as given, and takes a folder that exists as a local repo", () => {
    expect(parseRemote("https://dev.azure.com/acme/shop/_git/basket", noFolders)).toEqual({ url: "https://dev.azure.com/acme/shop/_git/basket", name: "basket" });
    expect(parseRemote("file:///C:/remotes/ui-kit.git", noFolders)).toEqual({ url: "file:///C:/remotes/ui-kit.git", name: "ui-kit" });
    expect(parseRemote("repos/orders-api", () => true)).toBeNull();
    expect(parseRemote("C:\\Repos\\orders-api", noFolders)).toBeNull();
    expect(parseRemote("./orders-api", noFolders)).toBeNull();
    expect(parseRemote("orders-api", noFolders)).toBeNull();
  });

  it("refuses a source that git would read as an option", async () => {
    await expect(resolveSource("-oProxyCommand@host:repo")).rejects.toThrow("isn't a folder, a GitHub URL or owner/repo");
    await expect(resolveSource("--upload-pack=x")).rejects.toThrow("isn't a folder");
  });
});

describe("how long enrolling takes", () => {
  const done = (repo: string, files: number, minutes: number, costUsd: number) =>
    enrolment(repo, { status: "done", step: "ready", pid: null, files, costUsd, startedAt: new Date(0).toISOString(), finishedAt: new Date(minutes * 60_000).toISOString() });

  it("goes by size alone, and says it's rough, until a repo of a similar size has been enrolled", () => {
    const store = new SqliteStore(":memory:");

    expect(estimateEnrolment(store, 120)).toEqual({ minutes: [2, 5], costUsd: [0.5, 2], basis: "rough: from its size alone, 120 files" });
    expect(estimateEnrolment(store, 2500)).toMatchObject({ minutes: [15, 25], costUsd: [8, 12] });
  });

  it("then goes by what the nearest ones took, leaving out ones that ran no AI or are far off in size", () => {
    const store = new SqliteStore(":memory:");
    store.saveEnrolment(done("a", 100, 3.2, 0.4));
    store.saveEnrolment(done("b", 150, 4.5, 0.6));
    store.saveEnrolment(done("eshop", 3000, 20, 9));
    store.saveEnrolment(done("indexed-only", 110, 0.1, 0));

    expect(estimateEnrolment(store, 120)).toEqual({ minutes: [3, 5], costUsd: [0.4, 0.6], basis: "from 2 earlier enrolments of a similar size (100–150 files; this one has 120)" });
  });
});

describe("an enrolment's progress", () => {
  it("records each step, the steps going side by side, and how it ended", () => {
    const store = new SqliteStore(":memory:");
    const progress = trackEnrolment(store, { given: "acme/orders-api", name: "orders-api", path: "unused", url: "https://github.com/acme/orders-api.git" });

    progress.step("cloning it");
    expect(store.enrolment("orders-api")).toMatchObject({ status: "running", step: "cloning it", pid: process.pid, source: "acme/orders-api" });
    progress.part("links", "mapping its links");
    progress.part("wiki", "writing the wiki (2 of 6 pages)");
    expect(store.enrolment("orders-api")!.step).toBe("mapping its links; writing the wiki (2 of 6 pages)");
    progress.part("links", null);
    expect(store.enrolment("orders-api")!.step).toBe("writing the wiki (2 of 6 pages)");
    progress.spent(0.25);
    progress.spent(0.5);
    progress.fail("No page passed the citation check", "writing the wiki");

    expect(store.enrolment("orders-api")).toMatchObject({ status: "failed", step: "writing the wiki", error: "No page passed the citation check", costUsd: 0.75 });
    expect(store.enrolment("orders-api")!.finishedAt).not.toBeNull();
  });

  it("counts as stopped once the process doing it has gone", () => {
    expect(liveStatus(enrolment("api"))).toBe("running");
    expect(liveStatus(enrolment("api", { pid: ended() }))).toBe("stopped");
    expect(liveStatus(enrolment("api", { pid: null, updatedAt: new Date(Date.now() - 120_000).toISOString() }))).toBe("stopped");
  });
});

describe("read tools on a repo being enrolled", () => {
  it("say it's being cloned and isn't ready yet, and nothing to a caller who can't read it", async () => {
    const store = new SqliteStore(":memory:");
    store.saveEnrolment(enrolment("orders-api"));
    const deps = { store, access: local };
    const nobody: AccessPolicy = { readableRepos: async () => new Set() };

    const card = await cardRequest(deps, LOCAL_CALLER, "orders-api", "concise");
    const page = await getPage(deps, LOCAL_CALLER, { repo: "orders-api" });
    const hidden = await cardRequest({ store, access: nobody }, LOCAL_CALLER, "orders-api", "concise");

    expect(card).toMatchObject({ ok: true });
    expect(card.text).toBe(
      [
        "orders-api  being enrolled · not ready yet",
        "Source: acme/orders-api",
        "Being enrolled: cloning it · started just now",
        "How long it takes depends on its size, known once it's cloned.",
        "Not ready to plan from yet: its wiki and links are still being written. Check its card again for progress.",
      ].join("\n"),
    );
    expect(page).toMatchObject({ ok: false });
    expect(page.text).toContain('"orders-api" isn\'t ready yet.\nBeing enrolled: cloning it');
    expect(hidden.text).toBe('No readable repo named "orders-api". No repos are enrolled yet. Add one with brain_add_repo (a GitHub URL, owner/repo or a local folder).');
  });

  it("show where an indexed repo has got to, and mark it in what a search couldn't cover", async () => {
    const store = new SqliteStore(":memory:");
    await enrolRepo(store, { path: repoFromFixture("articles-api"), name: "api" });
    await syncRepo(store, "api");
    const estimate = { minutes: [2, 5] as [number, number], costUsd: [0.5, 2] as [number, number], basis: "rough: from its size alone, 9 files" };
    store.saveEnrolment(enrolment("api", { step: "mapping its links; writing the wiki (0 of 6 pages)", estimate }));
    const deps = { store, access: local };

    const card = await cardRequest(deps, LOCAL_CALLER, "api", "concise");
    const page = await getPage(deps, LOCAL_CALLER, { repo: "api" });
    const found = await search(deps, LOCAL_CALLER, { query: "articles", format: "concise" });

    expect(card.text).toContain(
      "Being enrolled: mapping its links; writing the wiki (0 of 6 pages) · started just now\n" +
        "Expect roughly 2–5 minutes and $0.50–2 of Claude Code usage (rough: from its size alone, 9 files) in all.",
    );
    expect(card.text).toContain("Wiki: being written");
    expect(card.text).toContain("Seams: being mapped");
    expect(page.text).toContain("api has no wiki yet.\nBeing enrolled: mapping its links");
    expect(found.text).toContain("No wiki yet, so not searched: api (being enrolled)");
  });

  it("say what failed or stopped and how to try again, and that it's ready once done", async () => {
    const store = new SqliteStore(":memory:");
    store.saveEnrolment(enrolment("gone", { status: "failed", pid: null, error: "git clone https://github.com/acme/gone.git failed: Repository not found.", finishedAt: new Date().toISOString() }));
    store.saveEnrolment(enrolment("halted", { step: "indexing it", pid: ended() }));
    await enrolRepo(store, { path: repoFromFixture("articles-api"), name: "api" });
    await syncRepo(store, "api");
    const finished = new Date().toISOString();
    store.saveEnrolment(enrolment("api", { status: "done", step: "ready", pid: null, costUsd: 0.62, startedAt: new Date(Date.now() - 4 * 60_000).toISOString(), finishedAt: finished }));
    const deps = { store, access: local };

    const failed = await cardRequest(deps, LOCAL_CALLER, "gone", "concise");
    const halted = await cardRequest(deps, LOCAL_CALLER, "halted", "concise");
    const ready = await cardRequest(deps, LOCAL_CALLER, "api", "concise");

    expect(failed.text).toContain("gone  enrolment failed · not ready");
    expect(failed.text).toContain("Enrolment failed while cloning it (just now): git clone https://github.com/acme/gone.git failed: Repository not found.");
    expect(failed.text).toContain('To try again, call brain_add_repo with source "acme/gone" (in a terminal: brain add "acme/gone"); it redoes only what\'s missing.');
    expect(halted.text).toContain("Enrolment stopped before it finished, while indexing it (just now): the process doing it ended.");
    expect(ready.text).toMatch(/^api {2}@[0-9a-f]{7} · up to date\nEnrolled just now, in 4 min for \$0\.62: ready\.\n/);
  });
});

/** Store files to close after each test, before its folder is deleted (Windows won't delete an open file). */
const open: SqliteStore[] = [];
afterEach(() => {
  for (const store of open.splice(0)) store.close();
});

/** A brain on a store file, whose background enrolments run the real CLI, without AI. */
function fileBrain() {
  const dir = tempDir();
  const dbPath = join(dir, "brain.db");
  const store = new SqliteStore(dbPath);
  open.push(store);
  const command: HookCommand = { node: process.execPath, brain: BRAIN, dbPath, logPath: join(dir, "hooks.log"), syncFlags: ["--no-ai"] };
  return { dir, store, command };
}

const textOf = (result: Awaited<ReturnType<Client["callTool"]>>) => (result.content as { text: string }[])[0]!.text;

/**
 * Bare repos standing in for GitHub: git's `insteadOf` sends https://github.com/<owner>/<repo>
 * to <remotes>/<owner>/<repo>, for this process and the ones it starts, so nothing reaches the
 * network. Returns a function that puts the environment back.
 */
function fakeGitHub(remotes: string): () => void {
  const saved = { count: process.env.GIT_CONFIG_COUNT, key: process.env.GIT_CONFIG_KEY_0, value: process.env.GIT_CONFIG_VALUE_0 };
  process.env.GIT_CONFIG_COUNT = "1";
  process.env.GIT_CONFIG_KEY_0 = `url.${pathToFileURL(remotes).href}/.insteadOf`;
  process.env.GIT_CONFIG_VALUE_0 = "https://github.com/";
  return () => {
    for (const [name, value] of [["GIT_CONFIG_COUNT", saved.count], ["GIT_CONFIG_KEY_0", saved.key], ["GIT_CONFIG_VALUE_0", saved.value]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

describe("brain_add_repo", () => {
  it("starts enrolling a local repo in the background and answers at once; the card shows it going, then ready", async () => {
    const { store, command } = fileBrain();
    const client = await connect(store, { command });

    const started = await client.callTool({ name: "brain_add_repo", arguments: { source: repoFromFixture("articles-api"), name: "api" } });
    const during = await client.callTool({ name: "brain_repo_card", arguments: { repo: "api" } });

    expect(started.isError).toBe(false);
    expect(textOf(started)).toContain("Enrolling api in the background, from ");
    expect(textOf(started)).toMatch(/It has \d+ files: expect roughly 2–5 minutes and \$0\.50–2 of Claude Code usage \(rough: from its size alone, \d+ files\)\./);
    expect(textOf(started)).toContain('brain_repo_card (repo "api") says where it has got to, when it\'s ready, or what failed.');
    expect(textOf(during)).toMatch(/being enrolled/i);
    expect(textOf(during)).toContain("Not ready to plan from yet");

    await waitFor(() => store.enrolment("api")?.status === "done", 60_000);
    const after = await client.callTool({ name: "brain_repo_card", arguments: { repo: "api" } });

    expect(textOf(after)).toMatch(/^api {2}@[0-9a-f]{7} · up to date\nEnrolled just now, in 1 min, indexed only\./);
    expect(readFileSync(command.logPath, "utf8")).toContain("api: enrolling from ");
  }, 90_000);

  it("clones a GitHub repo with the person's own git, and says why a clone failed and how to retry", async () => {
    const { dir, store, command } = fileBrain();
    const remotes = join(dir, "remotes");
    execFileSync("git", ["clone", "--quiet", "--bare", repoFromFixture("articles-api"), join(remotes, "acme", "articles-api.git")]);
    const restore = fakeGitHub(remotes);
    try {
      const client = await connect(store, { command });

      const cloned = await client.callTool({ name: "brain_add_repo", arguments: { source: "acme/articles-api" } });
      await client.callTool({ name: "brain_add_repo", arguments: { source: "https://github.com/acme/missing" } });
      expect(textOf(cloned)).toContain("Enrolling articles-api in the background, cloning it first from https://github.com/acme/articles-api.git");
      expect(textOf(cloned)).toContain("How long it takes depends on its size, known once it's cloned");

      await waitFor(() => store.enrolment("articles-api")?.status === "done" && store.enrolment("missing")?.status === "failed", 60_000);
      const card = textOf(await client.callTool({ name: "brain_repo_card", arguments: { repo: "missing" } }));

      expect(store.getRepo("articles-api")).toMatchObject({ ref: "origin/main", remote: "https://github.com/acme/articles-api.git" });
      expect(store.getRepo("articles-api")!.path.replace(/\\/g, "/")).toMatch(/\/repos\/articles-api$/);
      expect(store.enrolment("articles-api")?.files).toBeGreaterThan(0);
      expect(card).toContain("missing  enrolment failed · not ready");
      expect(card).toContain("Enrolment failed while cloning it");
      expect(card).toContain("git clone https://github.com/acme/missing.git failed: ");
      expect(card).toContain('call brain_add_repo with source "https://github.com/acme/missing"');
      expect(store.getRepo("missing")).toBeUndefined();
    } finally {
      restore();
    }
  }, 120_000);

  it("finishes a repo that was enrolled but never indexed, and leaves one that's done alone", async () => {
    const { store, command } = fileBrain();
    const path = repoFromFixture("articles-api");
    await enrolRepo(store, { path, name: "api" });
    const client = await connect(store, { command });

    const again = await client.callTool({ name: "brain_add_repo", arguments: { source: path, name: "api" } });
    expect(textOf(again)).toContain("Trying again to enrol api in the background");
    await waitFor(() => store.enrolment("api")?.status === "done", 60_000);
    const twice = await client.callTool({ name: "brain_add_repo", arguments: { source: path, name: "api" } });

    expect(store.getState("api")?.fileCount).toBeGreaterThan(0);
    expect(twice.isError).toBe(true);
    expect(textOf(twice)).toContain('A repo named "api" is already enrolled');
  }, 90_000);

  it("says when a repo is already being enrolled, and refuses a source that is neither a folder nor a repo", async () => {
    const { store, command } = fileBrain();
    store.saveEnrolment(enrolment("web", { step: "writing the wiki (1 of 6 pages)" }));
    const client = await connect(store, { command });

    const busy = await client.callTool({ name: "brain_add_repo", arguments: { source: "acme/web" } });
    const nowhere = await client.callTool({ name: "brain_add_repo", arguments: { source: "C:\\no\\such\\folder" } });

    expect(busy.isError).toBe(false);
    expect(textOf(busy)).toContain("web is already being enrolled.\nBeing enrolled: writing the wiki (1 of 6 pages)");
    expect(nowhere.isError).toBe(true);
    expect(textOf(nowhere)).toBe("There is no folder C:\\no\\such\\folder, and it isn't a GitHub URL or owner/repo.");
  });
});

describe("the brain's own clones", () => {
  it("are fetched in the background when a session starts, at most once an hour; other repos are left alone", async () => {
    const dir = tempDir();
    const dbPath = join(dir, "brain.db");
    const origin = repoFromFixture("articles-api");
    const clone = join(dir, "repos", "api");
    execFileSync("git", ["-c", "core.autocrlf=false", "clone", "--quiet", origin, clone]);
    const store = new SqliteStore(dbPath);
    open.push(store);
    await enrolRepo(store, { path: clone, name: "api" });
    await enrolRepo(store, { path: repoFromFixture("articles-api"), name: "mine" });
    const next = commit(origin, { "src/tags.ts": "export const tags = [];\n" });
    const command: HookCommand = { node: process.execPath, brain: BRAIN, dbPath, logPath: join(dir, "hooks.log") };

    expect(fetchClones(store, command)).toEqual(["api"]);
    await waitFor(() => existsSync(join(clone, ".git", "FETCH_HEAD")) && git(clone, "rev-parse", "origin/main") === next, 30_000);

    expect(fetchClones(store, command)).toEqual([]);
  }, 60_000);
});
