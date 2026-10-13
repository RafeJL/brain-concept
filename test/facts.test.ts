import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema, type ElicitResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { moveAnchor } from "../src/ingest/facts.js";
import { enrolRepo } from "../src/ingest/registry.js";
import { syncRepo } from "../src/ingest/sync.js";
import { LOCAL_CALLER, LocalAccessPolicy } from "../src/serve/access.js";
import { createServer } from "../src/serve/mcp.js";
import { confirmFact } from "../src/serve/facts.js";
import { getPage } from "../src/serve/tools/get-page.js";
import { recordFact, type Confirm } from "../src/serve/tools/record-fact.js";
import { repoCard } from "../src/serve/tools/repo-card.js";
import { search } from "../src/serve/tools/search.js";
import { systemOverview } from "../src/serve/tools/system-overview.js";
import { impactRequest } from "../src/serve/tools/work-impact.js";
import { SqliteStore } from "../src/store/sqlite.js";
import { commit, makeRepo } from "./helpers.js";

const FOLLOW = ["export function follow(user, author) {", "  if (user.following.length >= 500) throw new Error('limit');", "  user.following.push(author);", "}", ""].join("\n");

/** A synced repo with a product page, in a system, as the brain holds it after a sync. */
async function brain() {
  const store = new SqliteStore(":memory:");
  const dir = makeRepo({ "src/follow.ts": FOLLOW, "README.md": "# web\n" });
  await enrolRepo(store, { path: dir, name: "web" });
  await syncRepo(store, "web");
  const markdown = "# Product\n\nLets readers follow the authors they like [src/follow.ts:1-3].\n\n## Business rules\n\nFollowing has no limit [src/follow.ts:2].\n";
  store.replacePages("web", [{ repo: "web", slug: "product", title: "Product", kind: "core", markdown, commit: store.getState("web")!.commit, claims: 2, removed: 0, model: "m", costUsd: 0, generatedAt: "now" }]);
  store.setSystem("Blog", ["web"], "A blogging platform.");
  const deps = { store, access: new LocalAccessPolicy() };
  return { store, dir, deps };
}

const accept = (text?: string, name = "Rafe"): Confirm => async (request) => ({ action: "accept", text: text ?? request.text, statedBy: name });
const rule = { repo: "web", kind: "rule" as const, text: "Users can follow at most 500 authors.", quote: "it's capped at 500, people kept bulk-following" };

describe("recording a fact a person stated", () => {
  it("stores what the person accepted as human-reviewed, after showing them what the brain already says", async () => {
    const { store, deps } = await brain();
    let shown = "";
    const confirm: Confirm = async (request) => {
      shown = request.message;
      return { action: "accept", text: "Readers can follow at most 500 authors.", statedBy: "Rafe" };
    };

    const result = await recordFact(deps, LOCAL_CALLER, { ...rule, anchors: ["src/follow.ts:2"] }, { confirm, person: "Rafe", now: () => "2026-10-12T10:00:00Z" });

    expect(shown).toContain('"Users can follow at most 500 authors."');
    expect(shown).toContain("web · product › Business rules: Following has no limit");
    expect(result.ok && result.data.outcome).toBe("confirmed");
    expect(store.facts({ repos: ["web"], systems: [] })).toMatchObject([
      { text: "Readers can follow at most 500 authors.", status: "confirmed", confirmedBy: "Rafe", anchors: [{ path: "src/follow.ts", start: 2, end: 2 }], anchorCommit: store.getState("web")!.commit },
    ]);
  });

  it("stores nothing when the person declines, and only a proposal when they can't be asked", async () => {
    const { store, deps } = await brain();

    const declined = await recordFact(deps, LOCAL_CALLER, rule, { confirm: async () => ({ action: "decline" }), person: "Rafe" });
    expect(declined.text).toContain("Not recorded: the dialog came back declined.");
    expect(store.facts({ repos: ["web"], systems: [] })).toEqual([]);

    const unasked = await recordFact(deps, LOCAL_CALLER, rule, { confirm: async () => ({ action: "unavailable" }), person: "Rafe" });
    expect(unasked.text).toContain("Confirm it with: npm run brain -- facts confirm");
    expect(store.facts({ repos: ["web"], systems: [] })).toMatchObject([{ status: "proposed", confirmedBy: null }]);
  });

  it("refuses anchors that don't hold, a target that isn't readable, and both a repo and a system", async () => {
    const { store, deps } = await brain();
    const opts = { confirm: accept(), person: "Rafe" };

    const outside = await recordFact(deps, LOCAL_CALLER, { ...rule, anchors: ["src/follow.ts:40-41"] }, opts);
    const missing = await recordFact(deps, LOCAL_CALLER, { ...rule, anchors: ["src/gone.ts:1"] }, opts);
    const unknown = await recordFact(deps, LOCAL_CALLER, { ...rule, repo: "nope" }, opts);
    const both = await recordFact(deps, LOCAL_CALLER, { ...rule, system: "Blog" }, opts);
    const systemAnchors = await recordFact(deps, LOCAL_CALLER, { ...rule, repo: undefined, system: "Blog", anchors: ["src/follow.ts:2"] }, opts);

    expect(outside.text).toContain("outside the file (4 lines)");
    expect(missing.text).toContain("doesn't exist at this commit");
    expect(unknown.text).toContain('No readable repo named "nope"');
    expect(both.text).toBe("Give either a repo or a system for the fact, not both.");
    expect(systemAnchors.text).toContain("record the fact on that repo");
    expect([outside, missing, unknown, both, systemAnchors].every((r) => !r.ok)).toBe(true);
    expect(store.facts({ repos: ["web"], systems: ["Blog"] })).toEqual([]);
  });

  it("replaces an earlier fact once the person confirms the new one, so the two never both stand", async () => {
    const { store, deps } = await brain();
    await recordFact(deps, LOCAL_CALLER, rule, { confirm: accept(), person: "Rafe" });
    let shown = "";
    const confirm: Confirm = async (request) => {
      shown = request.message;
      return { action: "accept", text: request.text, statedBy: "Rafe" };
    };

    const raised = await recordFact(deps, LOCAL_CALLER, { ...rule, text: "Users can follow at most 1000 authors.", replaces: 1 }, { confirm, person: "Rafe" });
    const page = await getPage(deps, LOCAL_CALLER, { repo: "web", page: "product" });

    expect(shown).toContain('It replaces fact #1, which is retired once you accept: "Users can follow at most 500 authors."');
    expect(raised.text).toContain("Fact #1, which it replaces, is retired.");
    expect(store.getFact(1)?.status).toBe("retired");
    expect(page.text).toContain("Users can follow at most 1000 authors. (rule · human-reviewed · Rafe");
    expect(page.text).toContain("replaces fact #1 · fact #2)");
    expect(page.text).not.toContain("500 authors");
  });

  it("keeps the earlier fact until a proposed replacement is confirmed, and won't replace one that's gone", async () => {
    const { store, deps } = await brain();
    await recordFact(deps, LOCAL_CALLER, rule, { confirm: accept(), person: "Rafe" });

    const proposed = await recordFact(deps, LOCAL_CALLER, { ...rule, text: "Users can follow at most 1000 authors.", replaces: 1, propose: true }, { confirm: accept(), person: "Rafe" });
    expect(proposed.text).toContain("fact #1 stands until it is");
    expect(store.getFact(1)?.status).toBe("confirmed");

    confirmFact(store, store.getFact(2)!, "Rafe", "2026-10-13T09:00:00Z", null);
    expect(store.getFact(1)?.status).toBe("retired");
    expect(store.getFact(2)).toMatchObject({ status: "confirmed", confirmedBy: "Rafe", replaces: 1 });

    const again = await recordFact(deps, LOCAL_CALLER, { ...rule, replaces: 1 }, { confirm: accept(), person: "Rafe" });
    const unknown = await recordFact(deps, LOCAL_CALLER, { ...rule, replaces: 99 }, { confirm: accept(), person: "Rafe" });
    expect(again.text).toContain("No live fact #1 to replace.");
    expect(unknown.ok).toBe(false);
  });
});

describe("serving facts from people", () => {
  it("opens the product page with them, counts them on the card, and ranks them first in search", async () => {
    const { deps } = await brain();
    await recordFact(deps, LOCAL_CALLER, rule, { confirm: accept(), person: "Rafe", now: () => "2026-10-12T10:00:00Z" });
    await recordFact(deps, LOCAL_CALLER, { repo: undefined, system: "Blog", kind: "term", text: "A follower is a reader who follows an author.", quote: "follower means..." }, { confirm: async () => ({ action: "unavailable" }), person: "Rafe" });

    const page = await getPage(deps, LOCAL_CALLER, { repo: "web", page: "product" });
    const card = await repoCard(deps, LOCAL_CALLER, "web", "concise");
    const found = await search(deps, LOCAL_CALLER, { query: "follow limit", format: "concise" });
    const overview = await systemOverview(deps, LOCAL_CALLER, "Blog");

    expect(page.text).toContain("llm-generated, with 2 facts from people");
    expect(page.text).toContain("## From people");
    expect(page.text).toContain("- Users can follow at most 500 authors. (rule · human-reviewed · Rafe, 2026-10-12 · fact #1)");
    expect(page.text).toContain("(term · proposed, not confirmed by a person: said by Rafe on");
    expect(page.text.indexOf("## From people")).toBeLessThan(page.text.indexOf("# Product"));
    expect(card.text).toContain('Facts from people: 1 confirmed by people, 1 proposed · at the top of its product page (brain_get page "product")');
    expect(found.text.split("\n").slice(0, 4).join("\n")).toContain("From people:\n  web: Users can follow at most 500 authors.");
    expect(overview.text).toContain("  web: Users can follow at most 500 authors.");
    expect(overview.text).toContain("  system: A follower is a reader who follows an author.");
  });
});

describe("facts anchored to code", () => {
  it("move with the lines around them, and go stale when their own lines change", async () => {
    const { store, dir, deps } = await brain();
    await recordFact(deps, LOCAL_CALLER, { ...rule, anchors: ["src/follow.ts:2"] }, { confirm: accept(), person: "Rafe" });

    commit(dir, { "src/follow.ts": `// Follows.\n${FOLLOW}` });
    const moved = await syncRepo(store, "web");
    expect(moved.staleFacts).toBe(0);
    expect(store.getFact(1)).toMatchObject({ anchors: [{ start: 3, end: 3 }], anchorCommit: moved.commit, staleSince: null });

    commit(dir, { "src/follow.ts": `// Follows.\n${FOLLOW.replace("500", "1000")}` });
    const changed = await syncRepo(store, "web");
    expect(changed.staleFacts).toBe(1);
    expect(store.getFact(1)?.staleSince).toBe(changed.commit);
    const page = await getPage(deps, LOCAL_CALLER, { repo: "web", page: "product" });
    expect(page.text).toContain(`stale: that code changed at @${changed.commit.slice(0, 7)}, so re-confirm before relying on it`);
  });

  it("only count a change that touches the anchored lines", () => {
    const anchor = { path: "a.ts", start: 10, end: 12 };

    expect(moveAnchor(anchor, [{ oldStart: 2, oldLines: 1, newLines: 3 }])).toEqual({ path: "a.ts", start: 12, end: 14 });
    expect(moveAnchor(anchor, [{ oldStart: 3, oldLines: 2, newLines: 0 }])).toEqual({ path: "a.ts", start: 8, end: 10 });
    expect(moveAnchor(anchor, [{ oldStart: 9, oldLines: 0, newLines: 1 }])).toEqual({ path: "a.ts", start: 11, end: 13 });
    expect(moveAnchor(anchor, [{ oldStart: 20, oldLines: 1, newLines: 1 }])).toEqual(anchor);
    expect(moveAnchor(anchor, [{ oldStart: 12, oldLines: 0, newLines: 2 }])).toEqual(anchor);
    expect(moveAnchor(anchor, [{ oldStart: 11, oldLines: 1, newLines: 1 }])).toBeNull();
    expect(moveAnchor(anchor, [{ oldStart: 10, oldLines: 0, newLines: 1 }])).toBeNull();
    expect(moveAnchor(anchor, [{ oldStart: 8, oldLines: 4, newLines: 1 }])).toBeNull();
  });
});

describe("gaps", () => {
  it("logs searches nothing fully answers and work descriptions that find nothing, grouped by question", async () => {
    const { store, deps } = await brain();

    await search(deps, LOCAL_CALLER, { query: "refund policy", format: "concise" });
    await search(deps, LOCAL_CALLER, { query: "Refund policy ", format: "concise" });
    // Lists the follow sections, but none says anything about blocking.
    const partly = await search(deps, LOCAL_CALLER, { query: "follow blocking", format: "concise" });
    await search(deps, LOCAL_CALLER, { query: "follow authors", format: "concise" });
    await impactRequest(deps, LOCAL_CALLER, { work: "quantum teleportation", format: "concise" });

    expect(partly.text).toContain("Business rules");
    expect(store.gaps(10)).toMatchObject([
      { query: "Refund policy ", times: 2, tools: ["brain_search"] },
      { query: "quantum teleportation", times: 1, tools: ["brain_impact"] },
      { query: "follow blocking", times: 1, tools: ["brain_search"] },
    ]);
  });
});

describe("brain_record_fact over MCP", () => {
  async function connect(store: SqliteStore, onElicit?: () => ElicitResult) {
    const server = createServer({ store, access: new LocalAccessPolicy(), caller: LOCAL_CALLER, person: "Rafe" });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: "test", version: "0.0.0" }, { capabilities: onElicit ? { elicitation: { form: {} } } : {} });
    if (onElicit) client.setRequestHandler(ElicitRequestSchema, async () => onElicit());
    await client.connect(clientSide);
    return client;
  }

  it("is the one tool that writes, asks for permission on every call, and confirms through the person's dialog", async () => {
    const { store } = await brain();
    const client = await connect(store, () => ({ action: "accept", content: { fact: "Users can follow at most 500 authors.", name: "Rafe Loveday" } }));

    const { tools } = await client.listTools();
    const record = tools.find((t) => t.name === "brain_record_fact")!;
    const result = await client.callTool({ name: "brain_record_fact", arguments: { repo: "web", kind: "rule", text: "max 500 follows", quote: "capped at 500" } });

    expect(tools.filter((t) => t.annotations?.readOnlyHint !== true).map((t) => t.name)).toEqual(["brain_record_fact", "brain_set_note"]);
    expect(record._meta).toEqual({ "anthropic/requiresUserInteraction": true });
    expect(result.isError).toBe(false);
    expect(store.getFact(1)).toMatchObject({ text: "Users can follow at most 500 authors.", status: "confirmed", confirmedBy: "Rafe Loveday" });
  });

  it("leaves a fact proposed when the client can't show a dialog", async () => {
    const { store } = await brain();
    const client = await connect(store);

    const result = await client.callTool({ name: "brain_record_fact", arguments: { system: "Blog", kind: "decision", text: "We won't add paid tiers.", quote: "no paid tiers" } });

    expect(JSON.stringify(result.content)).toContain("Stored as proposed fact #1 on the Blog system");
    expect(store.getFact(1)).toMatchObject({ system: "Blog", status: "proposed" });
  });

  it("says when a client declined the dialog itself, and then takes the fact as proposed", async () => {
    const { store } = await brain();
    // Like the desktop app: the client says it can show dialogs, then declines at once.
    const client = await connect(store, () => ({ action: "decline" }));
    const fact = { system: "Blog", kind: "decision", text: "We won't add paid tiers.", quote: "no paid tiers" };

    const declined = await client.callTool({ name: "brain_record_fact", arguments: fact });
    const proposed = await client.callTool({ name: "brain_record_fact", arguments: { ...fact, propose: true } });

    expect(JSON.stringify(declined.content)).toContain("most likely never shown");
    expect(JSON.stringify(proposed.content)).toContain("Stored as proposed fact #1");
    expect(store.facts({ repos: [], systems: ["Blog"] })).toMatchObject([{ status: "proposed", text: "We won't add paid tiers." }]);
  });
});
