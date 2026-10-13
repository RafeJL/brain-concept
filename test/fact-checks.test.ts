import { describe, expect, it } from "vitest";
import { checkFacts } from "../src/ai/fact-checks.js";
import type { NewFact } from "../src/core/facts.js";
import { enrolRepo } from "../src/ingest/registry.js";
import { syncRepo } from "../src/ingest/sync.js";
import { factLine, readableChecks } from "../src/serve/facts.js";
import { SqliteStore } from "../src/store/sqlite.js";
import { commit, makeRepo, recordedRunner } from "./helpers.js";

const FOLLOW = ["export function follow(user, author) {", "  if (user.following.length >= 500) throw new Error('limit');", "  user.following.push(author);", "}", ""].join("\n");

/** A synced repo, as the brain holds it, with facts added straight to the store. */
async function brain() {
  const store = new SqliteStore(":memory:");
  const dir = makeRepo({ "src/follow.ts": FOLLOW, "README.md": "# web\n" });
  await enrolRepo(store, { path: dir, name: "web" });
  await syncRepo(store, "web");
  const add = (fact: Partial<NewFact> & { text: string }) =>
    store.addFact({
      repo: "web",
      system: null,
      kind: "rule",
      quote: fact.text,
      statedBy: "Rafe",
      ticket: null,
      anchors: [],
      anchorCommit: null,
      status: "confirmed",
      recordedAt: "2026-10-13T09:00:00Z",
      confirmedBy: "Rafe",
      confirmedAt: "2026-10-13T09:00:00Z",
      confirmedWith: null,
      replaces: null,
      ...fact,
    });
  return { store, dir, add };
}

const cite = (file: string, start: number, end = start) => ({ file, start, end });
const agrees = (fact: number, line = 2) => ({ fact, verdict: "agrees", summary: "Following stops once a reader follows 500 authors.", cites: [cite("src/follow.ts", line)], looked_at: ["src/follow.ts"] });

describe("checking facts against the code", () => {
  it("keeps the verdicts the code bears out, and stores the rest as unclear, never to be retried blind", async () => {
    const { store, add } = await brain();
    for (const text of ["Follows are capped at 500.", "Users must be over 12.", "Comments can be edited.", "Tags are free.", "Articles have titles."]) add({ text });
    const { runner, requests } = recordedRunner({
      checks: [
        agrees(1),
        { fact: 2, verdict: "absent", summary: "Nothing checks a user's age.", cites: [], looked_at: ["src/follow.ts"] },
        { fact: 3, verdict: "contradicts", summary: "Comments can't be edited.", cites: [cite("src/gone.ts", 1)], looked_at: [] },
        { fact: 4, verdict: "absent", summary: "No tags.", cites: [], looked_at: [] },
        { fact: 1000, verdict: "agrees", summary: "Not asked about.", cites: [cite("src/follow.ts", 1)], looked_at: [] },
      ],
    });

    const result = await checkFacts(store, runner, "web");

    expect(requests[0]!.prompt).toContain("- Fact 1 (rule, on this repository): Follows are capped at 500.");
    expect(result.checked.map((c) => [c.fact, c.verdict])).toEqual([[5, "unclear"], [4, "unclear"], [3, "unclear"], [2, "absent"], [1, "agrees"]]);
    expect(store.getFact(3)?.checks[0]?.summary).toBe("the check's answer didn't hold up: cites src/gone.ts, which doesn't exist at this commit");
    expect(store.getFact(4)?.checks[0]?.summary).toBe("the check's answer didn't hold up: it named no files it looked at");
    expect(store.getFact(5)?.checks[0]?.summary).toBe("the check gave no answer for it");
    expect(result.costUsd).toBe(0.05);
    // Nothing changed, so the unclear ones aren't asked about again either.
    expect((await checkFacts(store, runner, "web")).checked).toEqual([]);
    expect(requests).toHaveLength(1);
  });

  it("checks a fact again only when its text, or the code its last check read, changed", async () => {
    const { store, dir, add } = await brain();
    add({ text: "Follows are capped at 500." });
    const { runner, requests } = recordedRunner({ checks: [agrees(1)] });
    await checkFacts(store, runner, "web");

    commit(dir, { "README.md": "# web, renamed\n" });
    await syncRepo(store, "web");
    await checkFacts(store, runner, "web");
    expect(requests).toHaveLength(1);

    store.updateFact(1, { text: "Follows are capped at 1000." });
    await checkFacts(store, runner, "web");
    expect(requests).toHaveLength(2);
    expect(requests[1]!.prompt).toContain("Follows are capped at 1000.");

    commit(dir, { "src/follow.ts": FOLLOW.replace("throw", "return") });
    await syncRepo(store, "web");
    await checkFacts(store, runner, "web");
    expect(requests).toHaveLength(3);
  });

  it("anchors a fact nobody anchored at the lines that agree, and a re-check that still agrees clears the stale mark", async () => {
    const { store, dir, add } = await brain();
    add({ text: "Follows are capped at 500." });
    add({ text: "Following pushes the author.", anchors: [{ path: "src/follow.ts", start: 3, end: 3 }], anchorCommit: store.getState("web")!.commit });
    await checkFacts(store, recordedRunner({ checks: [agrees(1), agrees(2)] }).runner, "web");
    expect(store.getFact(1)).toMatchObject({ anchors: [{ path: "src/follow.ts", start: 2, end: 2 }], anchorsFound: true });
    expect(store.getFact(2)).toMatchObject({ anchors: [{ path: "src/follow.ts", start: 3, end: 3 }], anchorsFound: false });
    expect(factLine(store.getFact(1)!)).toContain("enforced at src/follow.ts:2 (found by Claude Code) · code agrees (checked @");

    commit(dir, { "src/follow.ts": FOLLOW.replace("500", "1000") });
    const sync = await syncRepo(store, "web");
    expect(store.getFact(1)?.staleSince).toBe(sync.commit);

    await checkFacts(store, recordedRunner({ checks: [agrees(1), agrees(2)] }).runner, "web");
    expect(store.getFact(1)).toMatchObject({ staleSince: null, anchorCommit: sync.commit });
  });

  it("checks a system fact in each of its repos, sums it up, and hides the repos a caller can't read", async () => {
    const { store, add } = await brain();
    await enrolRepo(store, { path: makeRepo({ "api.py": "def follow(): pass\n" }), name: "api" });
    await syncRepo(store, "api");
    store.setSystem("Blog", ["web", "api"]);
    add({ repo: null, system: "Blog", text: "Follows are capped at 500." });

    const web = recordedRunner({ checks: [agrees(1)] });
    await checkFacts(store, web.runner, "web");
    await checkFacts(store, recordedRunner({ checks: [{ fact: 1, verdict: "absent", summary: "Following has no limit.", cites: [], looked_at: ["api.py"] }] }).runner, "api");

    expect(web.requests[0]!.prompt).toContain("(rule, on the Blog system, of which this repository is one part)");
    const fact = store.getFact(1)!;
    expect(factLine(fact)).toContain("code agrees in web (src/follow.ts:2); not in the code of api");
    expect(factLine(readableChecks([fact], ["web"])[0]!)).not.toContain("api");
  });

  it("says what the code contradicts, and what isn't built", async () => {
    const { store, add } = await brain();
    add({ text: "Users can follow anyone, any number of times." });
    add({ text: "Users must be over 12." });
    await checkFacts(
      store,
      recordedRunner({
        checks: [
          { fact: 1, verdict: "contradicts", summary: "Following stops at 500 authors.", cites: [cite("src/follow.ts", 2)], looked_at: ["src/follow.ts"] },
          { fact: 2, verdict: "absent", summary: "Nothing checks a user's age.", cites: [], looked_at: ["src/follow.ts"] },
        ],
      }).runner,
      "web",
    );

    expect(factLine(store.getFact(1)!)).toContain("code contradicts it at src/follow.ts:2: Following stops at 500 authors. (checked @");
    expect(factLine(store.getFact(2)!)).toContain("not in the code: Nothing checks a user's age. (checked @");
  });
});
