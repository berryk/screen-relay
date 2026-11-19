import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { randomBytes } from "node:crypto";
import { Script, runInNewContext } from "node:vm";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const origin = process.env.SCREEN_RELAY_ORIGIN;
assert(origin, "Set SCREEN_RELAY_ORIGIN to the relay origin.");
const request = new URL(origin).protocol === "https:" ? httpsRequest : httpRequest;
const scope = process.env.SCREEN_RELAY_VIEWER_SCOPE ?? "watch";
const embedOrigin = process.env.SCREEN_RELAY_EMBED_ORIGIN ?? "https://relay-test.claudemcpcontent.com";
const token = process.env.SCREEN_RELAY_TOKEN ?? (await readFile(process.env.SCREEN_RELAY_TOKEN_FILE, "utf8")).trim();
assert(/^[0-9a-f]{64}$/.test(token), "Set a valid token without putting it in tool arguments.");
const client = new Client({ name: "relay-app-check", version: "0.1.0" });
await client.connect(new StdioClientTransport({
  command: process.execPath,
  args: [new URL("./server.ts", import.meta.url).pathname],
  env: { ...process.env, SCREEN_RELAY_ORIGIN: origin, SCREEN_RELAY_TOKEN: token },
}));
try {
  const tools = await client.listTools();
  assert.deepEqual(
    tools.tools.map((item) => item.name).sort(),
    ["browser_action", "desktop_action", "desktop_screenshot", "open_desktop"],
  );
  const tool = tools.tools.find((item) => item.name === "open_desktop");
  assert(!Object.hasOwn(tool.inputSchema.properties, "token"));
  const resource = await client.readResource({ uri: tool._meta.ui.resourceUri });
  const { text: html, _meta: meta } = resource.contents[0];
  assert(meta.ui.csp.connectDomains.includes(origin.replace(/^http/, "ws")));
  assert(!meta.ui.csp.frameDomains);
  assert(!html.includes(token), "A resource must not contain session credentials.");
  assert.match(html, /id="relay-connection" role="status" aria-live="polite"/);
  new Script(html.match(/<script>([\s\S]*)<\/script>/)[1]);

  const results = await Promise.all(Array.from({ length: 4 }, () =>
    client.callTool({ name: "open_desktop", arguments: { url: origin } }),
  ));
  const [opened] = results;
  assert(!opened.isError);
  assert.match(opened.content[0].text, /viewer still needs to connect/);
  const grant = opened._meta["relay/viewer"];
  assert.match(grant.token, /^[0-9a-f]{64}$/);
  assert.notEqual(grant.token, token, "The owner token must not reach the UI.");
  assert.equal(grant.scope, scope);
  assert(Number.isSafeInteger(grant.expiresAt) && grant.expiresAt > Date.now());
  for (const result of results.slice(1)) {
    assert(!result.isError);
    assert.deepEqual(result._meta["relay/viewer"], grant, "Concurrent opens reuse one grant.");
  }
  const reopened = await client.callTool({ name: "open_desktop", arguments: { url: origin } });
  assert(!reopened.isError);
  assert.deepEqual(reopened._meta["relay/viewer"], grant, "Reopening reuses the active grant.");
  assert(!JSON.stringify(opened).includes(token));
  assert(!JSON.stringify(opened.content).includes(grant.token));
  assert(!(JSON.stringify(opened.structuredContent) ?? "").includes(grant.token));
  const screenshot = await client.callTool({ name: "desktop_screenshot", arguments: {} });
  assert(!screenshot.isError);
  const image = screenshot.content.find((item) => item.type === "image");
  const png = Buffer.from(image.data, "base64");
  assert.equal(png.subarray(1, 4).toString(), "PNG");
  console.log(`MCP: scoped credential confined to _meta; screenshot ${png.readUInt32BE(16)}×${png.readUInt32BE(20)}.`);

  const bridge = await readFile(new URL("./direct-ui.js", import.meta.url), "utf8");
  for (const resultFirst of [false, true]) {
    const parent = { postMessage() {} };
    let receive;
    let starts = 0;
    let reconnects = 0;
    let clock = Date.now();
    const timers = new Map();
    const notice = { hidden: true, textContent: "" };
    const connectionNotice = { hidden: true, textContent: "" };
    const status = { textContent: "" };
    let observeStatus;
    runInNewContext(bridge, {
      URL,
      Date: { now: () => clock },
      MutationObserver: class { constructor(callback) { observeStatus = callback; } observe() {} },
      setTimeout(callback, delay) { const id = Symbol(); timers.set(id, { callback, delay }); return id; },
      clearTimeout(id) { timers.delete(id); },
      relayOrigin: origin,
      startViewer(stream) {
        assert.equal(stream.token, grant.token);
        assert.equal(stream.scope, scope);
        starts++;
        return (token) => { assert.equal(token, "b".repeat(64)); reconnects++; };
      },
      document: {
        querySelector(selector) {
          if (selector === "#relay-expiry") return notice;
          if (selector === "#relay-connection") return connectionNotice;
          if (selector === "#status") return status;
          return { textContent: "" };
        },
      },
      window: {
        parent,
        isSecureContext: true,
        addEventListener(name, handler) { if (name === "message") receive = handler; },
      },
    });
    assert.equal(connectionNotice.hidden, false);
    assert.match(connectionNotice.textContent, /Waiting for desktop session/);
    status.textContent = "Connecting… · retrying in 1s";
    observeStatus();
    assert.match(connectionNotice.textContent, /Could not connect to the desktop/);
    status.textContent = "Live · view only";
    observeStatus();
    assert.equal(connectionNotice.hidden, true);
    status.textContent = "Viewer link expired or was revoked";
    observeStatus();
    assert.equal(connectionNotice.hidden, false);
    const result = { jsonrpc: "2.0", method: "ui/notifications/tool-result", params: opened };
    const ready = { jsonrpc: "2.0", id: 1, result: {} };
    receive({ source: {}, data: result });
    assert.equal(starts, 0, "Only the parent may supply credentials.");
    for (const data of resultFirst ? [result, ready] : [ready, result]) receive({ source: parent, data });
    receive({ source: parent, data: result });
    assert.equal(starts, 1, "Start once, regardless of message ordering.");
    assert.equal(reconnects, 0, "Duplicate results must not restart the stream.");
    assert.equal(timers.size, 1);
    clock = grant.expiresAt;
    for (const { callback } of [...timers.values()]) callback();
    assert.equal(notice.hidden, false);
    receive({ source: parent, data: result });
    assert.equal(reconnects, 0, "Expired metadata must not reconnect.");
    const changed = { ...result, params: { _meta: { "relay/viewer": { url: origin, token: "b".repeat(64), scope, expiresAt: clock + 3600000 } } } };
    receive({ source: parent, data: changed });
    assert.equal(notice.hidden, true);
    assert.equal(reconnects, 1, "A changed session credential must reconnect the existing viewer.");
  }
  console.log("UI bridge: both message orders and duplicate results passed.");

  await new Promise((resolve, reject) => {
    const upgrade = request(new URL(scope === "watch" ? "/stream?view=1" : "/stream", origin), {
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": randomBytes(16).toString("base64"),
        "Sec-WebSocket-Protocol": `nsl1, bearer.${grant.token}`,
        Origin: embedOrigin,
      },
    });
    const timer = setTimeout(() => { upgrade.destroy(); reject(new Error("Stream handshake timed out")); }, 10000);
    upgrade.on("error", (error) => { clearTimeout(timer); reject(error); });
    upgrade.on("response", (response) => {
      clearTimeout(timer);
      response.resume();
      reject(new Error(`Stream returned HTTP ${response.statusCode}; check the relay browser Origin allowlist`));
    });
    upgrade.on("upgrade", (response, socket) => {
      clearTimeout(timer);
      assert.equal(response.statusCode, 101);
      socket.destroy();
      console.log("Stream: scoped credential accepted on the expected viewer route.");
      resolve();
    });
    upgrade.end();
  });
} finally {
  await client.close();
}
