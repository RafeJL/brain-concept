import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { localPerson, resolveDbPath } from "../config.js";
import { fetchClones } from "../ingest/enrol.js";
import { brainCommand } from "../ingest/hooks.js";
import { SqliteStore } from "../store/sqlite.js";
import { LOCAL_CALLER, LocalAccessPolicy } from "./access.js";
import { createServer, serverInstructions } from "./mcp.js";

// stdout carries protocol frames only; anything human-readable goes to stderr.
const store = new SqliteStore(resolveDbPath());
const command = brainCommand();
const deps = { store, access: new LocalAccessPolicy(), caller: LOCAL_CALLER, person: await localPerson(), command };
const server = createServer(deps, await serverInstructions(deps));
await server.connect(new StdioServerTransport());
// Nobody pulls the repos the brain cloned for itself, so a new session fetches them; their hooks sync.
const fetched = fetchClones(store, command);
console.error(`citation-brain MCP server ready (store: ${resolveDbPath()})${fetched.length ? `; fetching ${fetched.join(", ")}` : ""}`);
