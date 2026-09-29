import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolveDbPath } from "../config.js";
import { SqliteStore } from "../store/sqlite.js";
import { LOCAL_CALLER, LocalAccessPolicy } from "./access.js";
import { createServer } from "./mcp.js";

// stdout carries protocol frames only; anything human-readable goes to stderr.
const store = new SqliteStore(resolveDbPath());
const server = createServer({ store, access: new LocalAccessPolicy(), caller: LOCAL_CALLER });
await server.connect(new StdioServerTransport());
console.error(`citation-brain MCP server ready (store: ${resolveDbPath()})`);
