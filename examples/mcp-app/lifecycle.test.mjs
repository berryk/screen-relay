import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { test } from "node:test";

const owner = "f".repeat(64);
const script = new URL("./server.ts", import.meta.url).pathname;

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}

async function waitFor(predicate, timeout = 7000) {
  const deadline = Date.now() + timeout;
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for lifecycle event");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function resultBody(text) {
  const data = text.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim());
  return JSON.parse(data.length ? data.at(-1) : text);
}

test("MCP sessions revoke only their grants on DELETE, idle expiry, and stdio EOF", { timeout: 30000 }, async () => {
  let nextId = 0;
  let holdNext = false;
  let release;
  let held = false;
  const issued = new Map();
  const revoked = [];
  const relay = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${owner}`);
    if (req.method === "POST" && req.url === "/grants/watch") {
      const id = String(++nextId);
      const token = id.padStart(64, "0");
      issued.set(id, token);
      if (holdNext) {
        holdNext = false;
        held = true;
        await new Promise((resolve) => { release = resolve; });
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id, token, scope: "watch", expires_in: 3600 }));
      return;
    }
    if (req.method === "DELETE" && /^\/grants\/[1-9][0-9]*$/.test(req.url)) {
      const id = req.url.slice("/grants/".length);
      revoked.push(id);
      issued.delete(id);
      res.writeHead(200, { "Content-Type": "application/json" }).end("{}");
      return;
    }
    res.writeHead(404).end();
  });
  const relayPort = await listen(relay);
  const origin = `http://127.0.0.1:${relayPort}`;
  const reservation = createServer();
  const port = await listen(reservation);
  await new Promise((resolve) => reservation.close(resolve));
  const env = { ...process.env, PORT: String(port), MCP_SESSION_IDLE_MS: "3000", SCREEN_RELAY_ORIGIN: origin, SCREEN_RELAY_TOKEN: owner, SCREEN_RELAY_VIEWER_SCOPE: "watch" };
  const http = spawn(process.execPath, [script, "--http"], { env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  let errors = "";
  http.stdout.on("data", (chunk) => { output += chunk; });
  http.stderr.on("data", (chunk) => { errors += chunk; });
  let stdio;
  try {
    await waitFor(() => output.includes("MCP server listening") || http.exitCode !== null);
    assert.equal(http.exitCode, null, errors);
    const endpoint = `http://127.0.0.1:${port}/mcp`;
    let requestId = 0;
    async function rpc(session, method, params) {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(session ? { "Mcp-Session-Id": session } : {}) },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method, params }),
      });
      assert.equal(response.status, 200, await response.clone().text());
      const body = resultBody(await response.text());
      assert(!body.error, JSON.stringify(body.error));
      return { session: response.headers.get("mcp-session-id") ?? session, result: body.result };
    }
    async function initialize() {
      const result = await rpc(undefined, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "lifecycle-test", version: "1" } });
      assert(result.session);
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "Mcp-Session-Id": result.session },
        body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      });
      assert.equal(response.status, 202);
      return result.session;
    }
    const open = (session) => rpc(session, "tools/call", { name: "open_desktop", arguments: { url: origin } });
    const remove = (session) => fetch(endpoint, { method: "DELETE", headers: { "Mcp-Session-Id": session } });
    const a = await initialize();
    const b = await initialize();
    const [a1, a2] = await Promise.all([open(a), open(a)]);
    const b1 = await open(b);
    const aGrant = a1.result._meta["relay/viewer"];
    const bGrant = b1.result._meta["relay/viewer"];
    assert.deepEqual(aGrant, a2.result._meta["relay/viewer"]);
    assert.notEqual(aGrant.token, bGrant.token);
    assert(!Object.hasOwn(aGrant, "id"));
    assert(!JSON.stringify(a1.result).includes(owner));
    assert.equal((await remove(a)).status, 200);
    assert.deepEqual(revoked, ["1"]);
    assert(issued.has("2"));
    await waitFor(() => revoked.includes("2"));
    assert(!issued.has("2"));

    const c = await initialize();
    holdNext = true;
    const inflight = open(c).catch(() => undefined);
    await waitFor(() => held);
    const deleting = remove(c);
    await waitFor(async () => {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "Mcp-Session-Id": c },
        body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      });
      return response.status === 404;
    });
    release();
    assert.equal((await deleting).status, 200);
    await inflight;
    assert(revoked.includes("3"));

    stdio = spawn(process.execPath, [script], { env, stdio: ["pipe", "pipe", "pipe"] });
    const replies = new Map();
    createInterface({ input: stdio.stdout }).on("line", (line) => {
      const message = JSON.parse(line);
      if (message.id !== undefined) replies.set(message.id, message);
    });
    let stdioErrors = "";
    stdio.stderr.on("data", (chunk) => { stdioErrors += chunk; });
    function send(message) { stdio.stdin.write(`${JSON.stringify(message)}\n`); }
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "lifecycle-test", version: "1" } } });
    await waitFor(() => replies.has(1) || stdio.exitCode !== null);
    assert(replies.get(1)?.result, stdioErrors);
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "open_desktop", arguments: { url: origin } } });
    await waitFor(() => replies.has(2) || stdio.exitCode !== null);
    assert(replies.get(2)?.result?._meta?.["relay/viewer"], stdioErrors);
    stdio.stdin.end();
    await waitFor(() => stdio.exitCode !== null);
    assert.equal(stdio.exitCode, 0, stdioErrors);
    assert(revoked.includes("4"));
  } finally {
    release?.();
    stdio?.kill();
    http.kill();
    await new Promise((resolve) => relay.close(resolve));
  }
});
