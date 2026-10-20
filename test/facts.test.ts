import { describe, expect, it } from "vitest";
import { moveAnchor } from "../src/ingest/facts.js";
import { enrolRepo } from "../src/ingest/registry.js";
import { syncRepo } from "../src/ingest/sync.js";
import { LOCAL_CALLER, LocalAccessPolicy } from "../src/serve/access.js";
import { confirmFact } from "../src/serve/facts.js";
import { getPage } from "../src/serve/tools/get-page.js";
import { manageFacts } from "../src/serve/tools/manage-facts.js";
import { manageSystems } from "../src/serve/tools/manage-systems.js";
import { review } from "../src/serve/tools/review.js";
import { recordFact } from "../src/serve/tools/record-fact.js";
import { repoCard } from "../src/serve/tools/repo-card.js";
import { search } from "../src/serve/tools/search.js";
import { systemOverview } from "../src/serve/tools/system-overview.js";
import { impactRequest } from "../src/serve/tools/work-impact.js";
import { commit, connect, FOLLOW, followRepo, makeRepo } from "./helpers.js";

/** A synced repo with a product page, in a system, as the brain holds it after a sync. */
async function brain() {
  const { store, dir } = await followRepo();
  const markdown = "# Product\n\nLets readers follow the authors they like [src/follow.ts:1-3].\n\n## Business rules\n\nFollowing has no limit [src/follow.ts:2].\n";
  store.replacePages("web", [{ repo: "web", slug: "product", title: "Product", kind: "core", markdown, commit: store.getState("web")!.commit, claims: 2, removed: 0, model: "m", costUsd: 0, generatedAt: "now" }]);
  store.setSystem("Blog", ["web"], "A blogging platform.");
  const deps = { store, access: new LocalAccessPolicy() };
  return { store, dir, deps };
}

const yes = { person: "Rafe" };
const rule = { repo: "web", kind: "rule" as const, text: "Users can follow at most 500 authors.", quote: "it's capped at 500, people kept bulk-following" };
const agreed = { ...rule, confirmedWith: "yes, record that" };

describe("recording a fact a person stated", () => {
  it("stores it confirmed with the person's words agreeing, and says what the brain already says nearby", async () => {
    const { store, deps } = await brain();

    const result = await recordFact(deps, LOCAL_CALLER, { ...agreed, anchors: ["src/follow.ts:2"] }, { ...yes, now: () => "2026-10-12T10:00:00Z" });

    expect(result.ok && result.data.outcome).toBe("confirmed");
    expect(result.text).toContain("Recorded fact #1 on web, confirmed by Rafe (human-reviewed).");
    expect(result.text).toContain("If any of it contradicts the new fact, tell the person");
    expect(result.text).toContain("web · product › Business rules: Following has no limit");
    expect(store.facts({ repos: ["web"], systems: [] })).toMatchObject([
      {
        text: "Users can follow at most 500 authors.",
        status: "confirmed",
        confirmedBy: "Rafe",
        confirmedWith: "yes, record that",
        anchors: [{ path: "src/follow.ts", start: 2, end: 2 }],
        anchorCommit: store.getState("web")!.commit,
      },
    ]);
  });

  it("stores only a proposal without their words, pointing at brain_facts to confirm it", async () => {
    const { store, deps } = await brain();

    const unasked = await recordFact(deps, LOCAL_CALLER, rule, yes);

    expect(unasked.text).toContain("Stored as proposed fact #1 on web, not confirmed: no confirmed_with was given.");
    expect(unasked.text).toContain("confirm it with brain_facts (action confirm)");
    expect(unasked.text).not.toContain("npm run brain");
    expect(store.facts({ repos: ["web"], systems: [] })).toMatchObject([{ status: "proposed", confirmedBy: null, confirmedWith: null }]);
  });

  it("is confirmed by running the command in a terminal", async () => {
    const { store, deps } = await brain();
    await recordFact(deps, LOCAL_CALLER, rule, { ...yes, terminal: true });
    expect(store.getFact(1)).toMatchObject({ status: "confirmed", confirmedBy: "Rafe", confirmedWith: null });
  });

  it("refuses anchors that don't hold, a target that isn't readable, and both a repo and a system", async () => {
    const { store, deps } = await brain();

    const outside = await recordFact(deps, LOCAL_CALLER, { ...agreed, anchors: ["src/follow.ts:40-41"] }, yes);
    const missing = await recordFact(deps, LOCAL_CALLER, { ...agreed, anchors: ["src/gone.ts:1"] }, yes);
    const unknown = await recordFact(deps, LOCAL_CALLER, { ...agreed, repo: "nope" }, yes);
    const both = await recordFact(deps, LOCAL_CALLER, { ...agreed, system: "Blog" }, yes);
    const systemAnchors = await recordFact(deps, LOCAL_CALLER, { ...agreed, repo: undefined, system: "Blog", anchors: ["src/follow.ts:2"] }, yes);

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
    await recordFact(deps, LOCAL_CALLER, agreed, yes);

    const raised = await recordFact(deps, LOCAL_CALLER, { ...agreed, text: "Users can follow at most 1000 authors.", replaces: 1 }, yes);
    const page = await getPage(deps, LOCAL_CALLER, { repo: "web", page: "product" });

    expect(raised.text).toContain("Fact #1, which it replaces, is retired.");
    expect(store.getFact(1)?.status).toBe("retired");
    expect(page.text).toContain("Users can follow at most 1000 authors. (rule · human-reviewed · Rafe");
    expect(page.text).toContain("replaces fact #1 · fact #2)");
    expect(page.text).not.toContain("500 authors");
  });

  it("keeps the earlier fact until a proposed replacement is confirmed, and won't replace one that's gone", async () => {
    const { store, deps } = await brain();
    await recordFact(deps, LOCAL_CALLER, agreed, yes);

    const proposed = await recordFact(deps, LOCAL_CALLER, { ...rule, text: "Users can follow at most 1000 authors.", replaces: 1 }, yes);
    expect(proposed.text).toContain("fact #1 stands until it is confirmed");
    expect(store.getFact(1)?.status).toBe("confirmed");

    confirmFact(store, store.getFact(2)!, "Rafe", "2026-10-13T09:00:00Z", null);
    expect(store.getFact(1)?.status).toBe("retired");
    expect(store.getFact(2)).toMatchObject({ status: "confirmed", confirmedBy: "Rafe", replaces: 1 });

    const again = await recordFact(deps, LOCAL_CALLER, { ...agreed, replaces: 1 }, yes);
    const unknown = await recordFact(deps, LOCAL_CALLER, { ...agreed, replaces: 99 }, yes);
    expect(again.text).toContain("No live fact #1 to replace.");
    expect(unknown.ok).toBe(false);
  });
});

describe("a fact's life after it is recorded (brain_facts)", () => {
  it("lists those waiting for a person (brain_review), and confirms one only with their words", async () => {
    const { store, deps } = await brain();
    await recordFact(deps, LOCAL_CALLER, agreed, yes);
    await recordFact(deps, LOCAL_CALLER, { ...rule, text: "Authors can block a follower." }, yes);

    const waiting = await review(deps, LOCAL_CALLER, { repo: "web" });
    const all = await review(deps, LOCAL_CALLER, { repo: "web", all: true });
    expect(waiting.text).toContain("1 fact waiting for a person to confirm (proposed, or stale because their code changed) on web:");
    expect(waiting.text).toContain("Authors can block a follower.");
    expect(waiting.text).not.toContain("500 authors");
    expect(all.text).toContain("2 facts on web:");
    expect(all.text.indexOf("Authors can block")).toBeLessThan(all.text.indexOf("500 authors"));

    const unworded = await manageFacts(deps, LOCAL_CALLER, { action: "confirm", id: 2 }, yes);
    expect(unworded.ok).toBe(false);
    expect(unworded.text).toContain("Never confirm for them.");
    expect(store.getFact(2)?.status).toBe("proposed");

    const confirmed = await manageFacts(deps, LOCAL_CALLER, { action: "confirm", id: 2, confirmedWith: "that's right" }, { person: "Sam" });
    expect(confirmed.text).toContain("Confirmed fact #2, by Sam.");
    expect(store.getFact(2)).toMatchObject({ status: "confirmed", confirmedBy: "Sam", confirmedWith: "that's right" });
  });

  it("re-confirms a stale fact at the current commit", async () => {
    const { store, dir, deps } = await brain();
    await recordFact(deps, LOCAL_CALLER, { ...agreed, anchors: ["src/follow.ts:2"] }, yes);
    commit(dir, { "src/follow.ts": FOLLOW.replace("500", "1000") });
    const changed = await syncRepo(store, "web");
    expect(store.getFact(1)?.staleSince).toBe(changed.commit);

    const again = await manageFacts(deps, LOCAL_CALLER, { action: "confirm", id: 1, confirmedWith: "still true" }, yes);

    expect(again.text).toContain("re-anchor it with action edit");
    expect(store.getFact(1)).toMatchObject({ status: "confirmed", staleSince: null, anchorCommit: changed.commit });
  });

  it("makes a confirmed fact proposed again when reworded without the person's words, and keeps it theirs with them", async () => {
    const { store, deps } = await brain();
    await recordFact(deps, LOCAL_CALLER, agreed, yes);

    const reworded = await manageFacts(deps, LOCAL_CALLER, { action: "edit", id: 1, text: "Users can follow at most 600 authors." }, yes);
    expect(reworded.text).toContain("It is proposed again until the person confirms the new wording");
    expect(store.getFact(1)).toMatchObject({ text: "Users can follow at most 600 authors.", status: "proposed", confirmedBy: null });

    await manageFacts(deps, LOCAL_CALLER, { action: "edit", id: 1, text: "Readers can follow at most 600 authors.", confirmedWith: "yes, readers" }, yes);
    expect(store.getFact(1)).toMatchObject({ text: "Readers can follow at most 600 authors.", status: "confirmed", confirmedWith: "yes, readers" });

    const anchored = await manageFacts(deps, LOCAL_CALLER, { action: "edit", id: 1, anchors: ["src/follow.ts:2"] }, yes);
    const bad = await manageFacts(deps, LOCAL_CALLER, { action: "edit", id: 1, anchors: ["src/follow.ts:90"] }, yes);
    expect(anchored.ok).toBe(true);
    expect(store.getFact(1)).toMatchObject({ status: "confirmed", anchors: [{ path: "src/follow.ts", start: 2, end: 2 }] });
    expect(bad.text).toContain("Nothing changed. The anchors don't hold");
  });

  it("retires a fact only with the person's words, and then treats it as gone", async () => {
    const { store, deps } = await brain();
    await recordFact(deps, LOCAL_CALLER, agreed, yes);

    expect((await manageFacts(deps, LOCAL_CALLER, { action: "retire", id: 1 }, yes)).ok).toBe(false);
    const retired = await manageFacts(deps, LOCAL_CALLER, { action: "retire", id: 1, confirmedWith: "drop it, the limit's gone" }, yes);
    const again = await manageFacts(deps, LOCAL_CALLER, { action: "confirm", id: 1, confirmedWith: "yes" }, yes);

    expect(retired.text).toContain("Retired fact #1");
    expect(store.getFact(1)?.status).toBe("retired");
    expect(again.text).toContain("No live fact #1.");
  });

  it("hides facts on repos the caller can't read, with the same answer as an unknown fact", async () => {
    const { store, deps } = await brain();
    await recordFact(deps, LOCAL_CALLER, agreed, yes);
    const blind = { store, access: { readableRepos: async () => new Set<string>() } };

    const hidden = await manageFacts(blind, LOCAL_CALLER, { action: "confirm", id: 1, confirmedWith: "yes" }, yes);
    const unknown = await manageFacts(blind, LOCAL_CALLER, { action: "confirm", id: 9, confirmedWith: "yes" }, yes);
    const listed = await review(blind, LOCAL_CALLER, { all: true });

    expect(hidden.text.replace("#1", "#9")).toBe(unknown.text);
    expect(listed.text).toBe("No facts in the repos you can read.");
  });
});

describe("serving facts from people", () => {
  it("opens the product page with them, counts them on the card, and ranks them first in search", async () => {
    const { deps } = await brain();
    await recordFact(deps, LOCAL_CALLER, agreed, { ...yes, now: () => "2026-10-12T10:00:00Z" });
    await recordFact(deps, LOCAL_CALLER, { repo: undefined, system: "Blog", kind: "term", text: "A follower is a reader who follows an author.", quote: "follower means..." }, yes);

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
    await recordFact(deps, LOCAL_CALLER, { ...agreed, anchors: ["src/follow.ts:2"] }, yes);

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

  it("are listed by brain_review, leaving out searches limited to a repo the caller can't read", async () => {
    const { store, deps } = await brain();
    store.logGap({ tool: "brain_search", query: "refund policy", repos: [], askedAt: "2026-10-13T09:00:00Z" });
    store.logGap({ tool: "brain_search", query: "secret roadmap", repos: ["hidden"], askedAt: "2026-10-13T09:01:00Z" });

    const listed = await review(deps, LOCAL_CALLER, {});

    expect(listed.text).toContain('- "refund policy" · asked once, last 2026-10-13 (brain_search)');
    expect(listed.text).not.toContain("secret roadmap");
  });
});

describe("which repos make up a product (brain_systems)", () => {
  async function twoRepos() {
    const made = await brain();
    await enrolRepo(made.store, { path: makeRepo({ "README.md": "# api\n" }), name: "api" });
    await syncRepo(made.store, "api");
    made.store.replaceSuggestedSystems([{ name: "Shop", summary: "Selling things.", reason: "They share a basket.", repos: ["api"] }]);
    return made;
  }

  it("lists suggested systems and proposed notes as waiting, and changes nothing without the person's words", async () => {
    const { store, deps } = await twoRepos();
    store.setProposedNote("api", { text: "Checkout matters most", by: "Rafe", at: "2026-10-13T09:00:00Z" });

    const waiting = await review(deps, LOCAL_CALLER, {});
    const unworded = await manageSystems(deps, LOCAL_CALLER, { action: "confirm", system: "Shop" });

    expect(waiting.text).toContain("Systems Claude Code suggested, not yet confirmed (brain_systems):\n- Shop: api. Why: They share a basket.");
    expect(waiting.text).not.toContain("- Blog");
    expect(waiting.text).toContain('- api: "Checkout matters most" (proposed by Rafe, 2026-10-13)');
    expect(unworded.ok).toBe(false);
    expect(store.systems().find((s) => s.name === "Shop")?.status).toBe("suggested");
  });

  it("confirms, moves repos between systems, creates one, and renames one", async () => {
    const { store, deps } = await twoRepos();
    const words = { confirmedWith: "yes, do that" };

    await manageSystems(deps, LOCAL_CALLER, { action: "confirm", system: "shop", ...words });
    expect(store.systems().find((s) => s.name === "Shop")?.status).toBe("confirmed");

    const moved = await manageSystems(deps, LOCAL_CALLER, { action: "set", system: "Blog", repos: ["api"], ...words });
    expect(moved.text).toContain("Updated Blog, confirmed: api, web. Moved api (from Shop).");

    const made = await manageSystems(deps, LOCAL_CALLER, { action: "set", system: "Admin", summary: "Back office.", ...words });
    expect(made.text).toContain("Created Admin, confirmed: no repos yet.");

    const renamed = await manageSystems(deps, LOCAL_CALLER, { action: "rename", system: "Blog", to: "Publishing", ...words });
    const clash = await manageSystems(deps, LOCAL_CALLER, { action: "rename", system: "Publishing", to: "admin", ...words });
    expect(renamed.ok).toBe(true);
    expect(clash.text).toContain("another system has that name");
    expect(store.systems().map((s) => s.name)).toContain("Publishing");
  });

  it("won't add a repo the caller can't read", async () => {
    const { store, deps } = await twoRepos();
    const result = await manageSystems(deps, LOCAL_CALLER, { action: "set", system: "Blog", repos: ["secret"], confirmedWith: "yes" });
    expect(result.text).toContain('No readable repo named "secret"');
    expect(store.systems().find((s) => s.name === "Blog")?.repos).toEqual(["web"]);
  });
});

describe("the write tools over MCP", () => {
  const person = { person: "Rafe" };

  // Which tools write is in mcp.test.ts.
  it("each ask the person to allow every call, and take the person's words", async () => {
    const { store } = await brain();
    const { tools } = await (await connect(store, person)).listTools();
    const writes = tools.filter((t) => t.annotations?.readOnlyHint !== true);
    const recording = writes.filter((t) => t.name !== "brain_add_repo");

    expect(tools.find((t) => t.name === "brain_review")?._meta).toBeUndefined();
    expect(writes.every((t) => JSON.stringify(t._meta) === JSON.stringify({ "anthropic/requiresUserInteraction": true }))).toBe(true);
    expect(recording.every((t) => "confirmed_with" in (t.inputSchema.properties ?? {}))).toBe(true);
  });

  it("record a fact confirmed with the person's words, and proposed without them", async () => {
    const { store } = await brain();
    const client = await connect(store, person);
    const fact = { system: "Blog", kind: "decision", text: "We won't add paid tiers.", quote: "no paid tiers" };

    const proposed = await client.callTool({ name: "brain_record_fact", arguments: fact });
    const confirmed = await client.callTool({ name: "brain_facts", arguments: { action: "confirm", id: 1, confirmed_with: "yes, that's our decision" } });

    expect(JSON.stringify(proposed.content)).toContain("Stored as proposed fact #1 on the Blog system");
    expect(confirmed.isError).toBe(false);
    expect(store.getFact(1)).toMatchObject({ system: "Blog", status: "confirmed", confirmedBy: "Rafe", confirmedWith: "yes, that's our decision" });
  });
});
