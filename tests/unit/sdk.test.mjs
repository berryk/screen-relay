import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { capabilities, connect, createClient, screenshot, status } from '../../dist/sdk/index.js';

test('HTTP status paths request engine metrics', async () => {
  const server = createServer((request, response) => {
    response.writeHead(request.url === '/metrics' ? 200 : 404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ path: request.url }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const options = { url: `http://127.0.0.1:${server.address().port}` };
    assert.deepEqual(await createClient(options).status(), { path: '/metrics' });
    assert.deepEqual(await status(options), { path: '/metrics' });
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('HTTP input batches events and validates before sending', async () => {
  const received = [];
  const server = createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/capabilities') return response.end(JSON.stringify({ max_input_batch: 2 }));
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    received.push(body);
    response.end(JSON.stringify({ applied: body.length / 16 }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const client = createClient({ url: `http://127.0.0.1:${server.address().port}` });
    assert.deepEqual(await client.input([{ type: 'releaseAll' }, { type: 'releaseAll' }, { type: 'releaseAll' }]), { events: 3 });
    assert.deepEqual(received.map(body => body.length), [32, 16]);
    await assert.rejects(client.key('ctrl+l'), { code: 'INVALID_ARGUMENT' });
    await assert.rejects(client.input([{ type: 'releaseAll' }, { type: 'keyDown', key: 999 }]), { code: 'INVALID_ARGUMENT' });
    assert.equal(received.length, 2);
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('HTTP input reports the records applied before a cancelled batch', async () => {
  let batches = 0;
  const server = createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/capabilities') return response.end(JSON.stringify({ max_input_batch: 2 }));
    for await (const chunk of request);
    if (batches++ === 0) return response.end(JSON.stringify({ applied: 2 }));
    response.statusCode = 409;
    response.end(JSON.stringify({ error: 'busy', applied: 1 }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const client = createClient({ url: `http://127.0.0.1:${server.address().port}` });
    await assert.rejects(client.input([{ type: 'releaseAll' }, { type: 'releaseAll' }, { type: 'releaseAll' }, { type: 'releaseAll' }]),
      { code: 'BUSY', applied: 3, data: { httpStatus: 409, applied: 3 } });
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('HTTP input counts a rejected batch prefix from its failure index', async () => {
  let batches = 0;
  const server = createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/capabilities') return response.end(JSON.stringify({ max_input_batch: 2 }));
    for await (const chunk of request);
    if (batches++ === 0) return response.end(JSON.stringify({ applied: 2 }));
    response.statusCode = 422;
    response.end(JSON.stringify({ error: 'unsupported_input', index: 1 }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const client = createClient({ url: `http://127.0.0.1:${server.address().port}` });
    await assert.rejects(client.input(Array.from({ length: 4 }, () => ({ type: 'releaseAll' }))),
      { code: 'UNSUPPORTED', applied: 3, data: { httpStatus: 422, index: 1, applied: 3 } });
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('custom HTTP transport enforces the overall request deadline', async () => {
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    const interval = setInterval(() => response.write(' '), 10);
    response.on('close', () => clearInterval(interval));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const client = createClient({ url: `http://127.0.0.1:${server.address().port}`, connect: '127.0.0.1', timeout: 50 });
    await assert.rejects(client.capabilities(), { code: 'TIMEOUT' });
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

function incompleteResponseServer() {
  return createServer((request, response) => {
    response.on('error', () => {});
    response.writeHead(200, { 'content-type': 'application/json', 'content-length': '128' });
    response.write('{"version":1', () => { if (response.socket) response.socket.end(); else response.destroy(); });
  });
}

function oversizedResponseServer(status) {
  return createServer((request, response) => {
    response.on('error', () => {});
    response.writeHead(status, { 'content-type': 'application/json' });
    const chunk = 'x'.repeat(64 * 1024);
    const limit = 8 * 1024 * 1024 + chunk.length * 2;
    let sent = 0;
    const pump = () => {
      try {
        while (sent < limit && !response.destroyed) {
          sent += chunk.length;
          if (!response.write(chunk)) { response.once('drain', pump); return; }
        }
        if (!response.destroyed) response.end();
      } catch {}
    };
    pump();
  });
}

async function withServer(server, run) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try { await run(`http://127.0.0.1:${server.address().port}`); }
  finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

test('custom transport returns a normal response', async () => {
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"version":7}');
  });
  await withServer(server, async (url) => {
    assert.deepEqual(await createClient({ url, connect: '127.0.0.1' }).capabilities(), { version: 7 });
  });
});

for (const [transport, options] of [['fetch', {}], ['custom', { connect: '127.0.0.1' }]]) {
  test(`${transport} transport reports an incomplete response as disconnected`, async () => {
    await withServer(incompleteResponseServer(), async (url) => {
      await assert.rejects(capabilities({ ...options, url, timeout: 5000 }), {
        code: 'DISCONNECTED', reason: 'disconnected',
      });
    });
  });
}

test('custom transport bounds success and error bodies', async () => {
  for (const status of [200, 500]) {
    await withServer(oversizedResponseServer(status), async (url) => {
      await assert.rejects(createClient({ url, connect: '127.0.0.1', timeout: 10000 }).capabilities(), { code: 'PROTOCOL_ERROR' });
    });
  }
});

test('fetch transport bounds success and error bodies', async () => {
  for (const status of [200, 500]) {
    await withServer(oversizedResponseServer(status), async (url) => {
      await assert.rejects(capabilities({ url, timeout: 10000 }), { code: 'PROTOCOL_ERROR' });
    });
  }
});

test('control connections reject unsupported transport overrides', async () => {
  await assert.rejects(connect({ ca: 'ca.pem' }), { code: 'INVALID_ARGUMENT', message: /do not support ca, certificate, or connect/ });
  await assert.rejects(connect({ certificate: 'cert.pem' }), { code: 'INVALID_ARGUMENT', message: /do not support ca, certificate, or connect/ });
  await assert.rejects(connect({ connect: '127.0.0.1' }), { code: 'INVALID_ARGUMENT', message: /do not support ca, certificate, or connect/ });
});

function packet(type, generation, sequence, payload) {
  const b = Buffer.alloc(20 + payload.length);
  b.write('NSL1'); b[4] = 1; b[5] = type;
  b.writeUInt32BE(generation, 8); b.writeUInt32BE(sequence, 12); b.writeUInt32BE(payload.length, 16); payload.copy(b, 20);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}
class FakeSocket extends EventTarget {
  static CLOSING = 2;
  constructor(url, protocol) {
    super(); assert.equal(url.pathname, '/control'); assert.deepEqual(protocol, ['nsl1']);
    this.readyState = 1;
    FakeSocket.current = this;
    queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: packet(4, 7, 0, Buffer.from([5, 0, 2, 208])) })));
  }
  send(data) { this.sent = Buffer.from(data); }
  reply(sequence, status = 0) { this.dispatchEvent(new MessageEvent('message', { data: packet(5, 7, sequence, Buffer.from([status])) })); }
  close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
}

test('control input uses the protocol and awaits its matching acknowledgement', async () => {
  const original = globalThis.WebSocket; globalThis.WebSocket = FakeSocket;
  try {
    const session = await connect();
    assert.deepEqual(session.surface, { width: 1280, height: 720 });
    const pending = session.input({ type: 'buttonDown', button: 1, x: 0.5, y: 1 });
    const b = FakeSocket.current.sent;
    assert.equal(b.readUInt32BE(8), 7); assert.equal(b.readUInt32BE(12), 1);
    assert.equal(b[20], 4); assert.equal(b.readUInt16BE(22), 1);
    assert.equal(b.readUInt16BE(28), 32768); assert.equal(b.readUInt16BE(30), 65535);
    FakeSocket.current.reply(1); await pending;
    const rejected = session.input({ type: 'keyDown', key: 4 });
    FakeSocket.current.reply(2, 2);
    await assert.rejects(rejected, { code: 'UNSUPPORTED' });
    await assert.rejects(session.input({ type: 'pointerMove', x: NaN, y: 0 }), { code: 'INVALID_ARGUMENT' });
    for (const type of ['__proto__', 'toString', null]) await assert.rejects(session.input({ type }), { code: 'INVALID_ARGUMENT' });
    session.close();
    await assert.rejects(session.input({ type: 'releaseAll' }), { code: 'DISCONNECTED' });
  } finally { globalThis.WebSocket = original; }
});

test('input timeout closes the session and rejects other pending input', async () => {
  const original = globalThis.WebSocket; globalThis.WebSocket = FakeSocket;
  try {
    const session = await connect({ timeout: 30 });
    const first = session.input({ type: 'releaseAll' });
    const second = session.input({ type: 'releaseAll' });
    const results = await Promise.allSettled([first, second]);
    assert.equal(results[0].reason.code, 'TIMEOUT');
    assert.equal(results[1].reason.code, 'DISCONNECTED');
    assert.equal(FakeSocket.current.readyState, 3);
  } finally { globalThis.WebSocket = original; }
});

test('malformed response closes session and rejects pending input', async () => {
  const original = globalThis.WebSocket; globalThis.WebSocket = FakeSocket;
  try {
    const session = await connect();
    const pending = session.input({ type: 'releaseAll' });
    FakeSocket.current.dispatchEvent(new MessageEvent('message', { data: packet(5, 99, 1, Buffer.from([0])) }));
    await assert.rejects(pending, { code: 'PROTOCOL_ERROR' });
    assert.equal(FakeSocket.current.readyState, 3);
  } finally { globalThis.WebSocket = original; }
});

test('control bounds outstanding input and rejects it when closed', async () => {
  const original = globalThis.WebSocket; globalThis.WebSocket = FakeSocket;
  try {
    const session = await connect();
    const pending = Array.from({ length: 32 }, () => session.input({ type: 'releaseAll' }));
    const results = Promise.allSettled(pending);
    await assert.rejects(session.input({ type: 'releaseAll' }), { code: 'BUSY' });
    session.close();
    assert.ok((await results).every(result => result.reason.code === 'DISCONNECTED'));
  } finally { globalThis.WebSocket = original; }
});

test('disconnect rejects in-flight input', async () => {
  const original = globalThis.WebSocket; globalThis.WebSocket = FakeSocket;
  try {
    const session = await connect();
    const pending = session.input({ type: 'releaseAll' });
    FakeSocket.current.close();
    await assert.rejects(pending, { code: 'DISCONNECTED' });
  } finally { globalThis.WebSocket = original; }
});

test('connection failure closes the socket before rejecting', async () => {
  const original = globalThis.WebSocket;
  class FailedSocket extends EventTarget {
    static CLOSING = 2;
    constructor() { super(); this.readyState = 0; FailedSocket.current = this; queueMicrotask(() => this.dispatchEvent(new Event('error'))); }
    close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
  }
  globalThis.WebSocket = FailedSocket;
  try {
    await assert.rejects(connect(), { code: 'NETWORK_ERROR' });
    assert.equal(FailedSocket.current.readyState, 3);
  } finally { globalThis.WebSocket = original; }
});

test('JSON parse errors and body timeouts have stable codes', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response('{');
    await assert.rejects(capabilities(), { code: 'PROTOCOL_ERROR' });
    globalThis.fetch = async () => new Response(new ReadableStream({ pull() { return new Promise(() => {}); } }));
    await assert.rejects(capabilities({ timeout: 20 }), { code: 'TIMEOUT' });
  } finally { globalThis.fetch = original; }
});

test('aborting during a fetch response body reports cancellation', async () => {
  const original = globalThis.fetch;
  const abort = new AbortController();
  try {
    globalThis.fetch = async (_url, { signal }) => new Response(new ReadableStream({
      pull(body) {
        abort.abort();
        body.error(signal.reason);
      },
    }, { highWaterMark: 0 }));
    await assert.rejects(capabilities({ signal: abort.signal }), { code: 'CANCELED', reason: 'canceled' });
  } finally { globalThis.fetch = original; }
});

test('HTTP error bodies distinguish screenshot contention from service failure', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response('{"error":"busy"}', { status: 503 });
    await assert.rejects(capabilities(), { code: 'BUSY', reason: 'busy', class: 'conflict' });
    globalThis.fetch = async () => new Response('{"error":"screenshot_unavailable"}', { status: 503 });
    await assert.rejects(capabilities(), {
      code: 'HTTP_ERROR', reason: 'component_failed', class: 'platform',
      message: 'The engine could not take a screenshot. Read the engine log with screen-relay logs engine.',
    });
  } finally { globalThis.fetch = original; }
});

test('screenshot body failures and file failures have stable codes', async () => {
  const originalSocket = globalThis.WebSocket, originalFetch = globalThis.fetch;
  globalThis.WebSocket = FakeSocket;
  try {
    const session = await connect();
    globalThis.fetch = async () => new Response(new ReadableStream({ pull(controller) { controller.error(new Error('broken body')); } }));
    await assert.rejects(session.screenshot(), { code: 'DISCONNECTED', reason: 'disconnected' });
    globalThis.fetch = async () => new Response(new Uint8Array([1, 2, 3]));
    await assert.rejects(session.screenshot('/nonexistent-directory/screen.png'), { code: 'IO_ERROR' });
    session.close();
  } finally { globalThis.WebSocket = originalSocket; globalThis.fetch = originalFetch; }
});

test('SDK screenshots do not open a control connection', async () => {
  const original = globalThis.WebSocket, originalFetch = globalThis.fetch;
  globalThis.WebSocket = class { constructor() { throw new Error('Unexpected control connection'); } };
  globalThis.fetch = async url => { assert.equal(url.pathname, '/screenshot.png'); return new Response(new Uint8Array([1, 2, 3])); };
  try {
    assert.deepEqual(await screenshot(), Buffer.from([1, 2, 3]));
  } finally {
    globalThis.WebSocket = original; globalThis.fetch = originalFetch;
  }
});

test('remote credentials require HTTPS and are not forwarded through redirects', async () => {
  const token = 'ab'.repeat(32);
  for (const options of [
    { url: 'http://remote.invalid', token },
    { url: 'https://remote.invalid' },
    { url: 'https://remote.invalid', token: 'short' },
    { url: 'https://user:password@remote.invalid', token },
    { url: 'https://remote.invalid/path', token },
  ]) await assert.rejects(capabilities(options), { code: 'INVALID_ARGUMENT' });
  let redirected = 0;
  const target = createServer((req, res) => { redirected++; res.end('{}'); });
  target.listen(0, '127.0.0.1'); await once(target, 'listening');
  const server = createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401); res.end('{}'); }
    else if (req.url === '/screenshot.png') { res.writeHead(302, { Location: `http://127.0.0.1:${target.address().port}/` }); res.end(); }
    else { res.setHeader('Content-Type', 'application/json'); res.end('{"version":1}'); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    await assert.rejects(capabilities({ url }), { code: 'UNAUTHORIZED' });
    assert.deepEqual(await capabilities({ url, token }), { version: 1 });
    await assert.rejects(screenshot({ url, token }), { code: 'NETWORK_ERROR' });
    assert.equal(redirected, 0);
  } finally {
    server.closeAllConnections(); target.closeAllConnections();
    await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => target.close(resolve))]);
  }
});

test('a refused control connection reports busy', async () => {
  const original = globalThis.WebSocket;
  class RefusedSocket extends EventTarget {
    static CLOSING = 2;
    constructor() { super(); this.readyState = 1; queueMicrotask(() => { this.readyState = 3; this.dispatchEvent(Object.assign(new Event('close'), { code: 4003 })); }); }
    close() { this.readyState = 3; }
    send() {}
  }
  globalThis.WebSocket = RefusedSocket;
  try {
    await assert.rejects(connect(), { code: 'BUSY', reason: 'busy' });
  } finally { globalThis.WebSocket = original; }
});

test('takeover ends session input and screenshots but leaves HTTP status and capabilities available', async () => {
  const server = createServer((request, response) => {
    response.writeHead(['/capabilities', '/metrics'].includes(request.url) ? 200 : 404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ path: request.url }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const original = globalThis.WebSocket; globalThis.WebSocket = FakeSocket;
  try {
    const session = await connect({ url: `http://127.0.0.1:${server.address().port}` });
    const pending = session.input({ type: 'releaseAll' });
    FakeSocket.current.readyState = 3;
    FakeSocket.current.dispatchEvent(Object.assign(new Event('close'), { code: 4001 }));
    await assert.rejects(pending, { reason: 'control_taken' });
    await assert.rejects(session.input({ type: 'releaseAll' }), { reason: 'control_taken' });
    await assert.rejects(session.screenshot(), { reason: 'control_taken' });
    assert.deepEqual(await session.capabilities(), { path: '/capabilities' });
    assert.deepEqual(await session.status(), { path: '/metrics' });
  } finally {
    globalThis.WebSocket = original;
    await new Promise(resolve => server.close(resolve));
  }
});

test('clipboard text round-trips as UTF-8 and engine refusals keep their reasons', async () => {
  let stored = '', error;
  const server = createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json');
    if (error) { response.writeHead(503); return response.end(JSON.stringify({ error })); }
    if (request.method === 'GET') return response.end(JSON.stringify({ text: stored }));
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    stored = Buffer.concat(chunks).toString('utf8');
    response.end(JSON.stringify({ length: Buffer.concat(chunks).length }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const client = createClient({ url: `http://127.0.0.1:${server.address().port}` });
    await client.setClipboard('naïve ✓ 🚀\nline');
    assert.equal(await client.clipboard(), 'naïve ✓ 🚀\nline');
    await client.setClipboard('');
    assert.equal(await client.clipboard(), '');
    await assert.rejects(client.setClipboard('a\0b'), { reason: 'invalid_input' });
    await assert.rejects(client.setClipboard('é'.repeat(131073)), { reason: 'invalid_input' });
    error = 'clipboard_unavailable';
    await assert.rejects(client.clipboard(), { reason: 'clipboard_unavailable' });
    error = 'clipboard_busy';
    await assert.rejects(client.clipboard(), { reason: 'busy', hint: 'Wait briefly, then retry.' });
  } finally {
    server.close();
    await once(server, 'close');
  }
});
