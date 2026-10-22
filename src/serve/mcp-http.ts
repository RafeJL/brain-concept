import type { AddressInfo } from "node:net";
import { httpConfig, resolveDbPath } from "../config.js";
import { fetchClones } from "../ingest/enrol.js";
import { brainCommand } from "../ingest/hooks.js";
import { SqliteStore } from "../store/sqlite.js";
import { LocalAccessPolicy } from "./access.js";
import { createHttpServer, isLoopback } from "./http.js";

// The hosted brain: the same tools as mcp-stdio.ts, over Streamable HTTP at /mcp.
const config = httpConfig();
if (!config.token && !isLoopback(config.host)) {
  console.error(`citation-brain: refusing to listen on ${config.host} without BRAIN_HTTP_TOKEN. Set it, or listen on 127.0.0.1.`);
  process.exit(1);
}

const store = new SqliteStore(resolveDbPath());
const command = brainCommand();
// Stage 1: one group of named testers, all allowed every enrolled repo, so only enrol repos they
// can all read. The per-caller GitHub check comes with Entra sign-in.
const deps = { store, access: new LocalAccessPolicy(), command };
// On loopback, a browser page could still reach the port through a rebound DNS name: accept only
// the local names unless told otherwise.
const local = [`127.0.0.1:${config.port}`, `localhost:${config.port}`, `[::1]:${config.port}`];
const allowedHosts = config.allowedHosts ?? (isLoopback(config.host) ? local : undefined);
const server = createHttpServer(deps, { token: config.token, allowedHosts });
server.listen(config.port, config.host, () => {
  const { port } = server.address() as AddressInfo;
  const fetched = fetchClones(store, command);
  console.error(
    `citation-brain MCP server listening on http://${config.host}:${port}/mcp (store: ${resolveDbPath()}; ` +
      `${config.token ? "bearer token required" : "no token: loopback only"})${fetched.length ? `; fetching ${fetched.join(", ")}` : ""}`,
  );
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  // ECS stops a task with SIGTERM: finish the requests in flight, then exit.
  process.on(signal, () => server.close(() => process.exit(0)));
}
