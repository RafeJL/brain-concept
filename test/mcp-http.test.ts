import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import { httpConfig } from "../src/config.js";
import { enrolRepo } from "../src/ingest/registry.js";
import { syncRepo } from "../src/ingest/sync.js";
import { LocalAccessPolicy } from "../src/serve/access.js";
import { createHttpServer, isLoopback, type HttpOptions } from "../src/serve/http.js";
import { SqliteStore } from "../src/store/sqlite.js";
import type { Store } from "../src/store/store.js";
import { makeRepo } from "./helpers.js";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))));
});

/** A brain HTTP server over `store` on a free loopback port; its /mcp URL. */
async function serve(store: Store, options: HttpOptions = {}): Promise<URL> {
  const server = createHttpServer({ store, access: new LocalAccessPolicy() }, options);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`);
}

async function connect(url: URL, token?: string): Promise<Client> {
  const headers: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers } }));
  return client;
}

const initialize = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "curl", version: "0" } },
};

function post(url: URL, body: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body,
  });
}

describe("MCP over HTTP", () => {
  it("serves the same tools and instructions, with what the brain holds, and answers a tool call", async () => {
    const store = new SqliteStore(":memory:");
    await enrolRepo(store, { path: makeRepo({ "a.ts": "1" }), name: "orders" });
    await syncRepo(store, "orders");
    const client = await connect(await serve(store, { token: "secret" }), "secret");

    const { tools } = await client.listTools();
    const result = await client.callTool({ name: "brain_repo_card", arguments: { repo: "orders" } });

    expect(tools).toHaveLength(11);
    expect(tools.find((t) => t.name === "brain_record_fact")?._meta).toEqual({ "anthropic/requiresUserInteraction": true });
    expect(client.getInstructions()).toContain("ask the brain first");
    expect(client.getInstructions()).toContain("- orders");
    expect(result.isError).toBe(false);
    expect(JSON.stringify(result.content)).toContain("· up to date");
  });

  it("refuses /mcp without the token, or with the wrong one, but answers the health check", async () => {
    const url = await serve(new SqliteStore(":memory:"), { token: "secret" });

    const none = await post(url, JSON.stringify(initialize));
    const wrong = await post(url, JSON.stringify(initialize), { authorization: "Bearer guess" });
    const health = await fetch(new URL("/healthz", url));

    expect(none.status).toBe(401);
    expect(none.headers.get("www-authenticate")).toBe("Bearer");
    expect(wrong.status).toBe(401);
    expect(health.status).toBe(200);
    expect(await health.text()).toBe("ok");
  });

  it("answers in plain JSON with no session, so any task behind the load balancer can take the next request", async () => {
    const url = await serve(new SqliteStore(":memory:"));

    const response = await post(url, JSON.stringify(initialize));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^application\/json/);
    expect(response.headers.get("mcp-session-id")).toBeNull();
    expect(((await response.json()) as { result: { serverInfo: { name: string } } }).result.serverInfo.name).toBe("citation-brain");
  });

  it("refuses a Host it wasn't told to accept, other paths, GET on /mcp, bad JSON and oversized bodies", async () => {
    const url = await serve(new SqliteStore(":memory:"), { allowedHosts: ["brain.example"] });
    const open = await serve(new SqliteStore(":memory:"));

    expect((await post(url, JSON.stringify(initialize))).status).toBe(403);
    expect((await fetch(new URL("/other", open))).status).toBe(404);
    expect((await fetch(open)).status).toBe(405);
    expect((await post(open, "{not json")).status).toBe(400);
    expect((await post(open, JSON.stringify({ padding: "x".repeat(2 * 1024 * 1024) }))).status).toBe(413);
  });
});

describe("httpConfig", () => {
  it("listens on loopback port 8080 with no token by default", () => {
    expect(httpConfig({})).toEqual({ host: "127.0.0.1", port: 8080, token: undefined, allowedHosts: undefined });
    expect(isLoopback("127.0.0.1")).toBe(true);
    expect(isLoopback("0.0.0.0")).toBe(false);
  });

  it("reads the host, port, token and allowed hosts, and refuses a port that isn't one", () => {
    const env = { BRAIN_HTTP_HOST: "0.0.0.0", BRAIN_HTTP_PORT: "9000", BRAIN_HTTP_TOKEN: "t", BRAIN_HTTP_ALLOWED_HOSTS: "a.example, b.example" };

    expect(httpConfig(env)).toEqual({ host: "0.0.0.0", port: 9000, token: "t", allowedHosts: ["a.example", "b.example"] });
    expect(() => httpConfig({ BRAIN_HTTP_PORT: "http" })).toThrow(/isn't a port/);
  });
});
