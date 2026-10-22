import { createServer as createNodeServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Caller } from "./access.js";
import { createServer, INSTRUCTIONS, serverInstructions, type ServerDeps } from "./mcp.js";

/** Requests to the brain are tool calls with a few short arguments; anything bigger is refused. */
const MAX_BODY_BYTES = 1024 * 1024;

export interface HttpOptions {
  /**
   * The shared bearer token every request to /mcp must carry. Required unless the server only
   * listens on loopback. Entra sign-in replaces it once the app registration exists.
   */
  token?: string;
  /** Host header values to accept (DNS rebinding); unset accepts any, as behind a load balancer. */
  allowedHosts?: readonly string[];
}

/** Who a request's credentials say is asking, or undefined to refuse it. */
function authenticate(req: IncomingMessage, options: HttpOptions): Caller | undefined {
  if (options.token === undefined) return { id: "local" };
  const header = req.headers.authorization ?? "";
  const given = Buffer.from(header.startsWith("Bearer ") ? header.slice(7) : "");
  const expected = Buffer.from(options.token);
  return given.length === expected.length && timingSafeEqual(given, expected) ? { id: "token" } : undefined;
}

function send(res: ServerResponse, status: number, body: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8", ...headers }).end(body);
}

/** A JSON-RPC error with no id, as the transport itself answers for a request it can't take. */
function sendRpcError(res: ServerResponse, status: number, message: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }));
}

async function readJson(req: IncomingMessage): Promise<{ ok: true; body: unknown } | { ok: false; status: number; message: string }> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) return { ok: false, status: 413, message: "Request body too large" };
    chunks.push(chunk);
  }
  try {
    return { ok: true, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
  } catch {
    return { ok: false, status: 400, message: "Parse error: the body isn't JSON" };
  }
}

function isInitialize(body: unknown): boolean {
  const messages = Array.isArray(body) ? body : [body];
  return messages.some((m) => typeof m === "object" && m !== null && (m as { method?: unknown }).method === "initialize");
}

/**
 * The MCP server over Streamable HTTP, for the hosted brain. Stateless: every POST to /mcp gets
 * its own server and transport, so any task behind the load balancer can answer it and a restart
 * loses nothing. The brain sends no notifications, so answers are plain JSON, not SSE streams.
 * The instructions (with what the caller can read) are built only for `initialize`, the one
 * request whose answer carries them. GET /healthz answers without a token, for the load balancer.
 */
export function createHttpServer(deps: Omit<ServerDeps, "caller">, options: HttpOptions = {}): Server {
  return createNodeServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      console.error(`citation-brain HTTP: ${error instanceof Error ? error.stack : String(error)}`);
      if (!res.headersSent) sendRpcError(res, 500, "Internal server error");
      else res.end();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = new URL(req.url ?? "/", "http://brain").pathname;
    if (options.allowedHosts && !options.allowedHosts.includes(req.headers.host ?? "")) {
      return send(res, 403, "Host not allowed");
    }
    if (path === "/healthz") return req.method === "GET" ? send(res, 200, "ok") : send(res, 405, "Method not allowed", { allow: "GET" });
    if (path !== "/mcp") return send(res, 404, "Not found");

    const caller = authenticate(req, options);
    if (!caller) return sendRpcError(res, 401, "Unauthorized", { "www-authenticate": "Bearer" });
    // Stateless: there's no session to stream to or end, so only POST does anything.
    if (req.method !== "POST") return sendRpcError(res, 405, "Method not allowed", { allow: "POST" });

    const parsed = await readJson(req);
    if (!parsed.ok) return sendRpcError(res, parsed.status, parsed.message);

    const callerDeps: ServerDeps = { ...deps, caller };
    const instructions = isInitialize(parsed.body) ? await serverInstructions(callerDeps) : INSTRUCTIONS;
    const server = createServer(callerDeps, instructions);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, parsed.body);
  }
}

/** True when the server can only be reached from this machine, so it may run without a token. */
export function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}
