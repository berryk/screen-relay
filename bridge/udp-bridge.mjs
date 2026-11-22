#!/usr/bin/env node
// UDP front end for a screen-relay engine.
//
// A browser that already reached the viewer page (through whatever protects it,
// such as Cloudflare Access) POSTs a WebRTC offer to /rtc/offer over that same
// protected connection. The answer carries this server's one-time DTLS
// fingerprint and ICE credentials, so the UDP port accepts only peers that
// completed that exchange. The browser then opens a reliable, ordered data
// channel straight to this machine over UDP, and the bridge relays it to the
// engine's WebSocket on loopback. The engine is unchanged.
//
// Data channel messages carry one type byte: 0 = part of a message, more
// follows; 1 = last (or only) part; 2 = the engine closed the stream, with a
// JSON {code, reason} payload. Engine frames can exceed the data channel's
// message limit, so they are split.
//
// Environment: BRIDGE_HTTP_PORT (8091), BRIDGE_UDP_PORT (60990), BRIDGE_PUBLIC_IP
// (required: the address browsers reach this machine on), ENGINE_URL
// (ws://127.0.0.1:8080).
import http from 'node:http';
import nodeDataChannel from 'node-datachannel';

const HTTP_PORT = Number(process.env.BRIDGE_HTTP_PORT || 8091);
const UDP_PORT = Number(process.env.BRIDGE_UDP_PORT || 60990);
const PUBLIC_IP = process.env.BRIDGE_PUBLIC_IP;
const ENGINE = (process.env.ENGINE_URL || 'ws://127.0.0.1:8080').replace(/\/$/, '');
const CHUNK = 60000, MAX_SESSIONS = 8, MAX_OFFER = 65536, SETUP_TIMEOUT_MS = 15000;
if (!PUBLIC_IP) { console.error('BRIDGE_PUBLIC_IP is required'); process.exit(1); }

let nextId = 0;
const sessions = new Map();

function endSession(session, why) {
  if (session.ended) return;
  session.ended = true;
  sessions.delete(session.id);
  clearTimeout(session.timer);
  try { session.ws?.close(); } catch {}
  try { session.dc?.close(); } catch {}
  try { session.pc.close(); } catch {}
  console.log(`[${session.id}] closed: ${why}`);
}

function sendClose(session, code, reason) {
  try {
    if (session.dc?.isOpen()) session.dc.sendMessageBinary(Buffer.concat([Buffer.from([2]), Buffer.from(JSON.stringify({ code, reason }))]));
  } catch {}
}

function attach(session, dc) {
  session.dc = dc;
  const queued = [];
  let assembling = [];
  const ws = new WebSocket(`${ENGINE}${session.path}`, session.protocols);
  ws.binaryType = 'arraybuffer';
  session.ws = ws;
  ws.onopen = () => { for (const message of queued.splice(0)) ws.send(message); };
  ws.onmessage = (event) => {
    if (session.ended || typeof event.data === 'string') return;
    const data = Buffer.from(event.data);
    try {
      for (let offset = 0; offset < data.length || offset === 0; offset += CHUNK) {
        const part = data.subarray(offset, offset + CHUNK);
        dc.sendMessageBinary(Buffer.concat([Buffer.from([offset + CHUNK >= data.length ? 1 : 0]), part]));
        if (!data.length) break;
      }
    } catch (error) { endSession(session, `send failed: ${error.message}`); }
  };
  ws.onclose = (event) => {
    if (session.ended) return;
    sendClose(session, event.code || 1006, event.reason || '');
    // Let the close notice leave before tearing the channel down.
    setTimeout(() => endSession(session, `engine closed ${event.code}`), 200);
  };
  ws.onerror = () => {};
  dc.onMessage((message) => {
    if (session.ended || typeof message === 'string' || !message.length) return;
    const type = message[0], body = message.subarray(1);
    if (type > 1) return;
    assembling.push(body);
    if (type === 0) { if (assembling.length > 64) endSession(session, 'oversized client message'); return; }
    const whole = assembling.length === 1 ? assembling[0] : Buffer.concat(assembling);
    assembling = [];
    if (ws.readyState === WebSocket.OPEN) ws.send(whole);
    else if (ws.readyState === WebSocket.CONNECTING && queued.length < 256) queued.push(whole);
  });
  dc.onClosed(() => endSession(session, 'data channel closed'));
  dc.onError((error) => endSession(session, `data channel error: ${error}`));
}

function answer(offer, path, protocols) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    const pc = new nodeDataChannel.PeerConnection(`relay-${id}`, {
      iceServers: [], bindAddress: PUBLIC_IP, portRangeBegin: UDP_PORT, portRangeEnd: UDP_PORT,
      enableIceUdpMux: true, enableIceTcp: false, maxMessageSize: 262144,
    });
    const session = { id, pc, path, protocols, ended: false };
    sessions.set(id, session);
    session.timer = setTimeout(() => { if (!session.dc) { endSession(session, 'setup timed out'); reject(new Error('timeout')); } }, SETUP_TIMEOUT_MS);
    pc.onStateChange((state) => {
      console.log(`[${id}] ${state}`);
      if (state === 'failed' || state === 'closed' || state === 'disconnected') endSession(session, state);
    });
    pc.onGatheringStateChange((state) => {
      if (state !== 'complete') return;
      const local = pc.localDescription();
      local ? resolve(local) : reject(new Error('no local description'));
    });
    pc.onDataChannel((dc) => {
      if (session.dc) { dc.close(); return; }
      clearTimeout(session.timer);
      attach(session, dc);
    });
    try { pc.setRemoteDescription(offer, 'offer'); }
    catch (error) { endSession(session, 'bad offer'); reject(error); }
  });
}

const server = http.createServer((request, response) => {
  const reply = (status, body) => { response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify(body)); };
  if (request.method !== 'POST' || request.url !== '/rtc/offer') return reply(404, { error: 'not_found' });
  // Only a page served from this same origin may negotiate; a browser sets Origin on a cross-site POST.
  const origin = request.headers.origin, host = request.headers.host;
  if (origin && new URL(origin).host !== host) return reply(403, { error: 'forbidden' });
  if (sessions.size >= MAX_SESSIONS) return reply(503, { error: 'busy' });
  let size = 0; const chunks = [];
  request.on('data', (chunk) => { size += chunk.length; if (size > MAX_OFFER) request.destroy(); else chunks.push(chunk); });
  request.on('end', async () => {
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const path = String(body.path || ''), protocols = Array.isArray(body.protocols) ? body.protocols.map(String) : [];
      if (typeof body.sdp !== 'string' || !/^\/stream(\?[a-z0-9=&]{0,64})?$/.test(path) ||
          protocols.length > 2 || protocols.some((p) => !/^[A-Za-z0-9._-]{1,128}$/.test(p))) return reply(400, { error: 'invalid_request' });
      const local = await answer(body.sdp, path, protocols);
      reply(200, { sdp: local.sdp, type: local.type });
    } catch (error) { reply(400, { error: 'negotiation_failed' }); }
  });
});
server.listen(HTTP_PORT, '127.0.0.1', () => console.log(`udp-bridge: signalling 127.0.0.1:${HTTP_PORT}, media ${PUBLIC_IP}:${UDP_PORT}/udp, engine ${ENGINE}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { for (const session of [...sessions.values()]) endSession(session, signal); nodeDataChannel.cleanup(); process.exit(0); });
