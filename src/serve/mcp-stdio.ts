import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolveDbPath } from "../config.js";
import { SqliteStore } from "../store/sqlite.js";
import { LOCAL_CALLER, LocalAccessPolicy } from "./access.js";
import { createServer, serverInstructions } from "./mcp.js";

// stdout carries protocol frames only; anything human-readable goes to stderr.
const store = new SqliteStore(resolveDbPath());
const deps = { store, access: new LocalAccessPolicy(), caller: LOCAL_CALLER };
const server = createServer(deps, await serverInstructions(deps));
await server.connect(new StdioServerTransport());
console.error(`citation-brain MCP server ready (store: ${resolveDbPath()})`);
