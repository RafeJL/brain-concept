import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { FactDraft } from "../src/core/facts.js";
import { readFacts } from "../src/ingest/extract.js";
import { enrolRepo } from "../src/ingest/registry.js";
import { syncRepo } from "../src/ingest/sync.js";
import { SqliteStore } from "../src/store/sqlite.js";
import { commit, readTree, repoFromFixture } from "./helpers.js";

const FACTS = fileURLToPath(new URL("./fixtures/facts/", import.meta.url));

/** Each folder under test/fixtures/facts plays a repo root; every file goes through production `readFacts`. */
function factsIn(fixture: string): Record<string, FactDraft[]> {
  const found: Record<string, FactDraft[]> = {};
  for (const [path, source] of Object.entries(readTree(join(FACTS, fixture)))) {
    const facts = readFacts(path, source);
    if (facts.length) found[path] = facts;
  }
  return found;
}

describe("fact readers", () => {
  it("reads a package.json's name and scripts, each with its line", () => {
    expect(factsIn("npm-scripts")).toEqual({
      "package.json": [
        { kind: "package", name: "@acme/shop-web", value: "@acme/shop-web", line: 2 },
        { kind: "script", name: "dev", value: "vite", line: 5 },
        { kind: "script", name: "build", value: "tsc -b && vite build", line: 6 },
        { kind: "script", name: "test", value: "vitest run", line: 7 },
        { kind: "script", name: "lint", value: "eslint .", line: 8 },
        { kind: "script", name: "storybook", value: "storybook dev -p 6006", line: 9 },
      ],
    });
  });

  it("gives no facts for a package.json that isn't valid JSON", () => {
    expect(factsIn("broken-json")).toEqual({});
  });

  it("tells test, web, app and library projects apart, and notes solutions", () => {
    const project = (name: string, value: string) => [{ kind: "dotnet-project", name, value, line: 1 }];
    expect(factsIn("dotnet")).toEqual({
      "Orders.slnx": [{ kind: "dotnet-solution", name: "Orders", value: "Orders.slnx", line: null }],
      "src/Orders.Api/Orders.Api.csproj": project("Orders.Api", "web"),
      "src/Orders.Domain/Orders.Domain.csproj": project("Orders.Domain", "library"),
      "tests/Orders.Contracts/Orders.Contracts.csproj": project("Orders.Contracts", "test"),
      "tests/Orders.Tests/Orders.Tests.csproj": project("Orders.Tests", "test"),
      "tools/Migrator/Migrator.csproj": project("Migrator", "app"),
    });
  });

  it("reads every CODEOWNERS rule in order, without comments", () => {
    expect(factsIn("codeowners")).toEqual({
      ".github/CODEOWNERS": [
        { kind: "owners", name: "*", value: "@acme/platform", line: 2 },
        { kind: "owners", name: "/src/api/", value: "@acme/orders @jane-doe", line: 5 },
        { kind: "owners", name: "docs/**", value: "@acme/tech-writers", line: 7 },
        { kind: "owners", name: "*", value: "@acme/shop-core", line: 10 },
        { kind: "owners", name: "/generated/", value: "", line: 11 },
      ],
    });
  });

  it("takes the README's first real paragraph, as plain text", () => {
    expect(factsIn("readme-badges")["README.md"]).toEqual([
      {
        kind: "summary",
        name: "summary",
        value: "The storefront for Acme: browse the catalogue, manage a basket and check out. It talks to orders-api and catalog-api.",
        line: 9,
      },
    ]);
  });

  it("skips setext headings, lead-ins ending in a colon and indented code, and reads quotes", () => {
    expect(factsIn("readme-setext")["README.md"]).toEqual([
      { kind: "summary", name: "summary", value: "Takes orders from the storefront and hands them to fulfilment.", line: 8 },
    ]);
  });

  it("names the package manager from a lockfile without reading it", () => {
    expect(readFacts("web/pnpm-lock.yaml", null)).toEqual([{ kind: "package-manager", name: "pnpm-lock.yaml", value: "pnpm", line: null }]);
  });

  it("ignores manifests of dependencies and test inputs", () => {
    expect(readFacts("node_modules/left-pad/package.json", '{ "name": "left-pad" }')).toEqual([]);
    expect(readFacts("test/fixtures/app/package.json", '{ "name": "input" }')).toEqual([]);
    expect(readFacts("docs/README.md", "A long enough paragraph about the docs folder.")).toEqual([]);
  });
});

describe("fact sync", () => {
  it("stores facts with their file and commit, and replaces them when the file changes", async () => {
    const store = new SqliteStore(":memory:");
    const dir = repoFromFixture("polyglot-service");
    await enrolRepo(store, { path: dir, name: "svc" });
    await syncRepo(store, "svc");
    const owners = () => store.facts("svc").filter((f) => f.kind === "owners" && f.path === ".github/CODEOWNERS");

    expect(owners().map((f) => f.value)).toEqual(["@acme/payments", "@acme/frontend"]);

    const next = commit(dir, { ".github/CODEOWNERS": "* @acme/checkout\n" }, "new owners", ["tools/package.json"]);
    await syncRepo(store, "svc");

    expect(owners()).toEqual([{ repo: "svc", path: ".github/CODEOWNERS", kind: "owners", name: "*", value: "@acme/checkout", line: 1, commit: next }]);
    expect(store.facts("svc").some((f) => f.path === "tools/package.json")).toBe(false);
  });

  it("fills in facts for a repo indexed before readers existed", async () => {
    const store = new SqliteStore(":memory:");
    await enrolRepo(store, { path: repoFromFixture("polyglot-service"), name: "svc" });
    await syncRepo(store, "svc");
    const state = store.getState("svc")!;
    // What a store synced by an older brain looks like: files indexed, no facts, an older extractor version.
    store.applySync("svc", { ...state, extractorVersion: 3, upsert: [], remove: [], extractedPaths: store.getFiles("svc").map((f) => f.path), seams: [], facts: [] });
    expect(store.facts("svc")).toEqual([]);

    const result = await syncRepo(store, "svc");

    expect(result.fullExtract).toBe(true);
    expect(store.facts("svc").length).toBeGreaterThan(0);
  });
});
