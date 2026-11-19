import { randomUUID } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { registerTools } from "./tools.ts";
import { registerViewer } from "./viewer.ts";

const port = Number(process.env.PORT ?? 3001);
const localHosts = [`localhost:${port}`, `127.0.0.1:${port}`];
const defaultIdleMs = 30 * 60_000;

type Session = {
  transport: NodeStreamableHTTPServerTransport;
  server: McpServer;
  closeGrants: () => Promise<void>;
  lastSeen: number;
};

const sessions = new Map<string, Session>();

/** Reads the idle timeout from MCP_SESSION_IDLE_MS, falling back to 30 minutes when it is not a positive number. */
function idleTimeout(): number {
  const value = Number(process.env.MCP_SESSION_IDLE_MS);
  return Number.isFinite(value) && value > 0 ? value : defaultIdleMs;
}

const sessionIdleMs = idleTimeout();

/** Drops a session from the map and closes its transport and server; closing twice is harmless. */
async function closeSession(id: string): Promise<void> {
  const session = sessions.get(id);
  if (!session) return;
  sessions.delete(id);
  const cleanup = session.closeGrants();
  await session.transport.close().catch(() => {});
  await session.server.close().catch(() => {});
  await cleanup;
}

/** Closes sessions left idle past the timeout, so a host that reconnects without terminating does not pile them up. */
const sweeper = setInterval(() => {
  const cutoff = Date.now() - sessionIdleMs;
  for (const [id, session] of sessions) {
    if (session.lastSeen <= cutoff) void closeSession(id);
  }
}, Math.max(1_000, Math.min(sessionIdleMs, 60_000)));
sweeper.unref();

/** Builds a server with the screen-relay tools and viewer resource. */
export function createServer(): { server: McpServer; closeGrants: () => Promise<void> } {
  const server = new McpServer({ name: "relay-mcp-app", version: "0.1.0" });
  const closeGrants = registerTools(server);
  server.server.onclose = () => { void closeGrants(); };
  registerViewer(server);
  return { server, closeGrants };
}

/** Refuses requests addressed to any host but this loopback server, which blocks DNS rebinding. */
function trustedHost(req: IncomingMessage): boolean {
  return localHosts.includes(String(req.headers.host ?? ""));
}

/** Accepts no Origin, or one served from this machine, so local hosts on any port can connect. */
function trustedOrigin(origin: string | undefined): boolean {
  if (origin === undefined) return true;
  try {
    const { hostname, protocol } = new URL(origin);
    return (protocol === "http:" || protocol === "https:") &&
      (hostname === "localhost" || hostname === "127.0.0.1");
  } catch {
    return false;
  }
}

function cors(origin: string | undefined) {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Expose-Headers": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  };
  if (origin && trustedOrigin(origin)) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  if (!trustedHost(req) || !trustedOrigin(req.headers.origin)) {
    res.writeHead(403).end("Forbidden");
    return;
  }
  const headers = cors(req.headers.origin);
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
  if (req.url !== "/mcp") {
    res.writeHead(404).end();
    return;
  }
  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }
  const sessionId = req.headers["mcp-session-id"];
  if (typeof sessionId === "string") {
    const session = sessions.get(sessionId);
    if (!session) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32001, message: "Session not found" },
        id: null,
      }));
      return;
    }
    if (req.method === "DELETE") {
      await closeSession(sessionId);
      res.writeHead(200).end();
      return;
    }
    session.lastSeen = Date.now();
    await session.transport.handleRequest(req, res);
    return;
  }
  const { server, closeGrants } = createServer();
  const transport = new NodeStreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    enableDnsRebindingProtection: true,
    allowedHosts: localHosts,
    onsessioninitialized: (id) => {
      sessions.set(id, { transport, server, closeGrants, lastSeen: Date.now() });
    },
  });
  server.server.onclose = () => {
    if (transport.sessionId) sessions.delete(transport.sessionId);
    void closeGrants();
  };
  await server.connect(transport);
  try {
    await transport.handleRequest(req, res);
  } finally {
    if (!transport.sessionId) await server.close().catch(() => {});
  }
}

async function startHttp() {
  const http = createHttpServer((req, res) => {
    handle(req, res).catch((error) => {
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
      }
      res.end(JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
        id: null,
      }));
    });
  });
  http.listen(port, "127.0.0.1", () => console.log(`MCP server listening on http://localhost:${port}/mcp`));
}

if (process.argv.includes("--http")) {
  await startHttp();
} else {
  await createServer().server.connect(new StdioServerTransport());
}
