import { describe, expect, it } from "vitest";
import { enrolRepo } from "../src/ingest/registry.js";
import { syncRepo } from "../src/ingest/sync.js";
import { LOCAL_CALLER, LocalAccessPolicy, type AccessPolicy } from "../src/serve/access.js";
import { INSTRUCTIONS, serverInstructions } from "../src/serve/mcp.js";
import { SqliteStore } from "../src/store/sqlite.js";
import { connect, makeRepo } from "./helpers.js";

describe("MCP server", () => {
  it("lists the read-only tools, then the four that record what a person says, then adding a repo", async () => {
    const client = await connect(new SqliteStore(":memory:"));

    const { tools } = await client.listTools();

    expect(tools.map((t) => t.name)).toEqual([
      "brain_repo_card",
      "brain_find_consumers",
      "brain_impact",
      "brain_get",
      "brain_search",
      "brain_review",
      "brain_record_fact",
      "brain_set_note",
      "brain_facts",
      "brain_systems",
      "brain_add_repo",
    ]);
    expect(tools.slice(0, 6).every((t) => t.annotations?.readOnlyHint === true)).toBe(true);
    expect(tools.slice(6).every((t) => t.annotations?.readOnlyHint === false)).toBe(true);
    // It costs time and money, so the person allows every call; and it reaches GitHub.
    const add = tools.find((t) => t.name === "brain_add_repo")!;
    expect(add._meta).toEqual({ "anthropic/requiresUserInteraction": true });
    expect(add.annotations).toMatchObject({ openWorldHint: true, destructiveHint: false });
    expect(Object.keys(add.inputSchema.properties ?? {})).toEqual(["source", "name", "note"]);
    expect(add.description).toMatch(/takes time and money/);
  });

  it("tells the client when to use the brain, to offer adding a repo it lacks, and not to plan from one being enrolled", async () => {
    const client = await connect(new SqliteStore(":memory:"));

    expect(client.getInstructions()).toContain("ask the brain first");
    expect(client.getInstructions()).toContain("offer to add it with brain_add_repo");
    expect(client.getInstructions()).toContain("While a repo is being enrolled, don't plan from it");
    expect(client.getInstructions()).toContain("brain_repo_card finds them at once");
  });

  it("returns a repo card over the protocol", async () => {
    const store = new SqliteStore(":memory:");
    await enrolRepo(store, { path: makeRepo({ "a.ts": "1" }), name: "orders" });
    await syncRepo(store, "orders");
    const client = await connect(store);

    const result = await client.callTool({ name: "brain_repo_card", arguments: { repo: "orders" } });

    expect(result.isError).toBe(false);
    expect(JSON.stringify(result.content)).toContain("· up to date");
  });

  it("refuses a parameter a tool doesn't have, naming it, instead of dropping it", async () => {
    const client = await connect(new SqliteStore(":memory:"));

    const result = await client.callTool({ name: "brain_get", arguments: { repo: "orders", pages: ["overview"] } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('Unrecognized key: \\"pages\\"');
    const { tools } = await client.listTools();
    expect(tools.every((t) => t.inputSchema.additionalProperties === false)).toBe(true);
  });

  it("takes one page or up to five in brain_get, and refuses more", async () => {
    const client = await connect(new SqliteStore(":memory:"));

    const six = await client.callTool({ name: "brain_get", arguments: { repo: "orders", page: ["a", "b", "c", "d", "e", "f"] } });
    const none = await client.callTool({ name: "brain_get", arguments: { repo: "orders", page: [] } });
    const several = await client.callTool({ name: "brain_get", arguments: { repo: "orders", page: ["overview", "conventions"] } });

    expect(six.isError).toBe(true);
    expect(JSON.stringify(six.content)).toContain("Invalid arguments for tool brain_get");
    expect(none.isError).toBe(true);
    // A list that passes reaches the tool, which knows no such repo.
    expect(JSON.stringify(several.content)).toContain("No repos are enrolled yet.");
  });

  it("flags unknown repos as errors without throwing", async () => {
    const client = await connect(new SqliteStore(":memory:"));

    const result = await client.callTool({ name: "brain_repo_card", arguments: { repo: "nope" } });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("No repos are enrolled yet.");
  });
});

describe("server instructions", () => {
  /** Repos and a product page straight into the store: the catalogue reads only rows, no git. */
  function store(): SqliteStore {
    const s = new SqliteStore(":memory:");
    for (const name of ["aspnet-api", "react-web", "payroll"]) {
      s.addRepo({ name, path: `/repos/${name}`, ref: "main", remote: null, enrolledAt: "2026-10-12T00:00:00Z", note: null, proposedNote: null });
    }
    s.replacePages("aspnet-api", [
      { repo: "aspnet-api", slug: "product", title: "Product", kind: "core", markdown: "# Product\n\nLets people write and read articles [a.cs:1].", commit: "c", claims: 1, removed: 0, model: "m", costUsd: 0, generatedAt: "now" },
    ]);
    s.setSystem("RealWorld", ["aspnet-api", "react-web"], "A blogging platform.");
    return s;
  }
  const deps = (s: SqliteStore, access: AccessPolicy = new LocalAccessPolicy()) => ({ store: s, access, caller: LOCAL_CALLER });

  it("name the systems and repos the brain holds, with their product summaries, as the organisation's own", async () => {
    const text = await serverInstructions(deps(store()));

    expect(text.startsWith(INSTRUCTIONS)).toBe(true);
    expect(text).toContain("even where one matches a public or open-source project");
    expect(text).toContain("- RealWorld: aspnet-api, react-web. A blogging platform.");
    expect(text).toContain("- aspnet-api: Lets people write and read articles.");
    // A repo without a product page is still named, just without a summary.
    expect(text).toMatch(/^- react-web$/m);
  });

  it("leave out repos the caller can't read, and add nothing when there are none", async () => {
    const onlyPayroll: AccessPolicy = { readableRepos: async () => new Set(["payroll"]) };

    const hidden = await serverInstructions(deps(store(), onlyPayroll));
    const empty = await serverInstructions(deps(new SqliteStore(":memory:")));

    expect(hidden).not.toContain("RealWorld");
    expect(hidden).not.toContain("aspnet-api");
    expect(hidden).toContain("- payroll");
    expect(empty).toBe(INSTRUCTIONS);
  });

  it("mark a repo still being enrolled as not ready", async () => {
    const s = store();
    const at = new Date().toISOString();
    s.saveEnrolment({ repo: "payroll", source: "acme/payroll", status: "running", step: "writing the wiki", error: null, pid: process.pid, files: 10, estimate: null, costUsd: 0, startedAt: at, updatedAt: at, finishedAt: null });

    expect(await serverInstructions(deps(s))).toContain("- payroll (being enrolled: not ready yet)");
  });
});
