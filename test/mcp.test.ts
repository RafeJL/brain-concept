import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { enrolRepo } from "../src/ingest/registry.js";
import { syncRepo } from "../src/ingest/sync.js";
import { LOCAL_CALLER, LocalAccessPolicy } from "../src/serve/access.js";
import { createServer } from "../src/serve/mcp.js";
import { SqliteStore } from "../src/store/sqlite.js";
import { makeRepo } from "./helpers.js";

async function connect(store: SqliteStore): Promise<Client> {
  const server = createServer({ store, access: new LocalAccessPolicy(), caller: LOCAL_CALLER });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientSide);
  return client;
}

describe("MCP server", () => {
  it("lists only read-only tools", async () => {
    const client = await connect(new SqliteStore(":memory:"));

    const { tools } = await client.listTools();

    expect(tools.map((t) => t.name)).toEqual(["brain_repo_card", "brain_find_consumers"]);
    expect(tools.every((t) => t.annotations?.readOnlyHint === true)).toBe(true);
    expect(tools[0]?.annotations?.readOnlyHint).toBe(true);
  });

  it("tells the client when to use the brain", async () => {
    const client = await connect(new SqliteStore(":memory:"));

    expect(client.getInstructions()).toContain("ask the brain first");
  });

  it("returns a repo card over the protocol", async () => {
    const store = new SqliteStore(":memory:");
    await enrolRepo(store, { path: makeRepo({ "a.ts": "1" }), name: "orders" });
    await syncRepo(store, "orders");
    const client = await connect(store);

    const result = await client.callTool({ name: "brain_repo_card", arguments: { repo: "orders" } });

    expect(result.isError).toBe(false);
    expect(JSON.stringify(result.content)).toContain("up to date · parser-built");
  });

  it("flags unknown repos as errors without throwing", async () => {
    const client = await connect(new SqliteStore(":memory:"));

    const result = await client.callTool({ name: "brain_repo_card", arguments: { repo: "nope" } });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("No repos are enrolled yet.");
  });
});
