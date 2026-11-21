import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import http from 'node:http';

const [port, token, address = '127.0.0.2'] = [Number(process.argv[2]), process.argv[3], process.argv[4]];
assert.ok(port > 0 && /^[0-9a-f]{64}$/.test(token ?? ''), 'usage: grants.mjs PORT OWNER_TOKEN [ADDRESS]');
const host = `127.0.0.1:${port}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Sends one HTTP request to the engine and resolves with its status and body. */
function request(method, path, credential) {
  return new Promise((resolve, reject) => {
    const headers = { Host: host, 'Content-Length': 0, ...(credential ? { Authorization: `Bearer ${credential}` } : {}) };
    const req = http.request({ method, path, host: address, port, headers });
    req.on('response', (response) => {
      let body = '';
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** Builds the 20-byte NSL1 ACK for a frame, wrapped in a masked WebSocket binary frame. */
function ack(generation, sequence) {
  const message = Buffer.alloc(20);
  message.write('NSL1', 0, 'ascii');
  message[4] = 1;
  message[5] = 2;
  message.writeUInt32BE(generation, 8);
  message.writeUInt32BE(sequence, 12);
  const mask = randomBytes(4);
  for (let index = 0; index < message.length; index++) message[index] ^= mask[index % 4];
  return Buffer.concat([Buffer.from([0x82, 0x80 | message.length]), mask, message]);
}

/**
 * Opens a WebSocket with the credential as its bearer subprotocol and resolves with null when the engine refuses it.
 * An open connection acknowledges video frames so only the engine's own decision can close it; `done` settles then.
 */
function connect(path, credential, origin) {
  return new Promise((resolve) => {
    const req = http.request({ path, host: address, port, headers: {
      Host: host, Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13',
      'Sec-WebSocket-Key': randomBytes(16).toString('base64'), 'Sec-WebSocket-Protocol': `nsl1, bearer.${credential}`,
      ...(origin ? { Origin: origin } : {}),
    } });
    req.on('upgrade', (response, socket, head) => {
      if (response.statusCode !== 101 || response.headers['sec-websocket-protocol'] !== 'nsl1') { socket.destroy(); resolve(null); return; }
      const connection = { closed: false, close: () => socket.destroy() };
      connection.done = new Promise((finish) => {
        const end = () => { connection.closed = true; finish(); };
        let buffer = Buffer.alloc(0);
        const read = (chunk) => {
          buffer = Buffer.concat([buffer, chunk]);
          while (buffer.length >= 2) {
            let length = buffer[1] & 127, offset = 2;
            if (length === 126) { if (buffer.length < 4) return; length = buffer.readUInt16BE(2); offset = 4; }
            else if (length === 127) { if (buffer.length < 10) return; length = Number(buffer.readBigUInt64BE(2)); offset = 10; }
            if (buffer.length < offset + length) return;
            const opcode = buffer[0] & 15, payload = buffer.subarray(offset, offset + length);
            if (opcode === 8) { socket.destroy(); end(); return; }
            if (opcode === 2 && payload.length >= 20 && payload.toString('ascii', 0, 4) === 'NSL1' && payload[5] === 1) {
              socket.write(ack(payload.readUInt32BE(8), payload.readUInt32BE(12)));
            }
            buffer = buffer.subarray(offset + length);
          }
        };
        socket.on('data', read);
        socket.on('close', end);
        socket.on('error', end);
        read(head);
      });
      resolve(connection);
    });
    req.on('response', (response) => { response.resume(); resolve(null); });
    req.on('error', () => resolve(null));
    req.end();
  });
}

/** Reports whether the path opens with the credential, then closes it and lets the engine release its slot and input. */
async function opens(path, credential, origin) {
  const connection = await connect(path, credential, origin);
  if (!connection) return false;
  connection.close();
  await sleep(400);
  return true;
}

/** Resolves true when the connection closes within the limit. */
function closesWithin(connection, ms) {
  return Promise.race([connection.done.then(() => true), sleep(ms).then(() => false)]);
}

/** Creates a grant with the owner token and checks the response shape. */
async function grant(scope, ttl) {
  const response = await request('POST', `/grants/${scope}${ttl ? `?ttl=${ttl}` : ''}`, token);
  assert.equal(response.status, 200, response.body);
  const body = JSON.parse(response.body);
  assert.match(body.token, /^[0-9a-f]{64}$/);
  assert.notEqual(body.token, token);
  assert.ok(typeof body.id === 'string' && /^[A-Za-z0-9_-]+$/.test(body.id), `grant id ${body.id}`);
  assert.equal(body.scope, scope);
  assert.equal(body.expires_in, ttl ?? 3600);
  return body;
}

const denied = (status) => status === 401 || status === 403;
const watchPath = '/stream?view=1';
const inputPaths = ['/stream', '/stream?take=1', '/control'];
const clipboardPaths = ['/stream?clipboard=1', '/stream?take=1&clipboard=1'];

assert.equal((await request('POST', '/grants/watch')).status, 401);
assert.equal((await request('POST', '/grants/control')).status, 401);
assert.ok(!(await opens(watchPath, '0'.repeat(64))), 'an unknown credential opened the stream');

const watch = await grant('watch');
const control = await grant('control', 600);
assert.notEqual(watch.id, control.id);
assert.notEqual(watch.token, control.token);

for (const credential of [watch, control]) {
  for (const [method, path] of [
    ['GET', '/capabilities'], ['GET', '/screenshot.png'], ['GET', '/metrics'], ['GET', '/clipboard'], ['POST', '/input'],
    ['POST', '/grants/watch'], ['POST', '/grants/control'], ['DELETE', `/grants/${credential.id}`],
  ]) {
    const response = await request(method, path, credential.token);
    assert.ok(denied(response.status), `${credential.scope} grant: ${method} ${path} returned ${response.status}`);
  }
}

assert.ok(await opens(watchPath, watch.token), 'the watch grant did not open the view-only stream');
for (const path of [...inputPaths, ...clipboardPaths]) {
  assert.ok(!(await opens(path, watch.token)), `the watch grant opened ${path}`);
}
for (const path of [...inputPaths, watchPath]) {
  assert.ok(await opens(path, control.token), `the control grant did not open ${path}`);
}
for (const path of clipboardPaths) {
  assert.ok(!(await opens(path, control.token)), `the control grant opened ${path}`);
  assert.ok(await opens(path, token), `the owner token did not open ${path}`);
}

const owner = await connect(watchPath, token);
const watching = await connect(watchPath, watch.token);
const driving = await connect('/control', control.token);
assert.ok(owner && watching && driving, 'owner, watch, and control connections did not open together');
await sleep(500);
assert.ok(!owner.closed && !watching.closed && !driving.closed, 'a connection closed before any grant was revoked');

assert.equal((await request('DELETE', `/grants/${watch.id}`, token)).status, 200);
assert.ok(await closesWithin(watching, 2000), 'revoking the watch grant left its connection open');
assert.ok(!owner.closed, 'revoking a grant closed the owner connection');
assert.ok(!driving.closed, 'revoking the watch grant closed the control grant connection');
assert.ok(!(await opens(watchPath, watch.token)), 'a revoked watch grant reconnected');

assert.equal((await request('DELETE', `/grants/${control.id}`, token)).status, 200);
assert.ok(await closesWithin(driving, 2000), 'revoking the control grant left its connection open');
assert.ok(!(await opens('/control', control.token)), 'a revoked control grant reconnected');
assert.ok(!owner.closed, 'revoking a grant closed the owner connection');

const brief = await grant('watch', 2);
const started = Date.now();
const expiring = await connect(watchPath, brief.token);
assert.ok(expiring, 'a new two-second grant did not open');
await sleep(800);
assert.ok(!expiring.closed, 'a two-second grant closed in under a second');
assert.ok(await closesWithin(expiring, 5000), 'an expired grant left its connection open');
assert.ok(Date.now() - started >= 1500, 'a two-second grant closed early');
assert.ok(!(await opens(watchPath, brief.token)), 'an expired grant reconnected');

assert.ok(!owner.closed, 'grant expiry closed the owner connection');

// A grant connects from any page origin, null included, because MCP App hosts
// frame viewers on opaque or per-load origins. The session token keeps the check.
const anywhere = await grant('watch');
for (const origin of ['null', 'https://untrusted.example.test', 'https://abc123.claudemcpcontent.com']) {
  assert.ok(await opens(watchPath, anywhere.token, origin), `the grant did not open from Origin ${origin}`);
}
for (const origin of ['null', 'https://untrusted.example.test']) {
  assert.ok(!(await opens(watchPath, token, origin)), `the session token opened from Origin ${origin}`);
}
assert.ok(await opens(watchPath, token, 'https://app.example.test'), 'the session token did not open from an allowed origin');

// An oversized fragment must fail, not end parsing and silently drop later constraints.
for (const scope of ['watch', 'control']) {
  for (const fragment of [`ttl=${'0'.repeat(59)}1`, `x=${'a'.repeat(62)}`]) {
    for (const query of [fragment, `${fragment}&connections=1`, `connections=1&${fragment}`, `ttl=60&${fragment}&connections=1`]) {
      const response = await request('POST', `/grants/${scope}?${query}`, token);
      assert.equal(response.status, 400, `${scope}: oversized query ${query}`);
      assert.equal(JSON.parse(response.body).error, 'invalid_query');
    }
  }
}
// A 63-byte fragment still fits, including room for its terminator.
const boundaryResponse = await request('POST', `/grants/watch?ttl=${'0'.repeat(57)}60&connections=1`, token);
assert.equal(boundaryResponse.status, 200, boundaryResponse.body);
const boundary = JSON.parse(boundaryResponse.body);
assert.equal(boundary.expires_in, 60);
assert.equal(boundary.connections, 1);
assert.equal((await request('DELETE', `/grants/${boundary.id}`, token)).status, 200);

// A single-connection grant opens exactly one WebSocket, which stays open.
for (const query of ['connections=2', 'connections=1&connections=1']) {
  const response = await request('POST', `/grants/watch?${query}`, token);
  assert.equal(response.status, 400, query);
  assert.equal(JSON.parse(response.body).error, 'invalid_connections', query);
}
const singleResponse = await request('POST', '/grants/watch?ttl=60&connections=1', token);
assert.equal(singleResponse.status, 200, singleResponse.body);
const single = JSON.parse(singleResponse.body);
assert.equal(single.connections, 1);
assert.equal(single.expires_in, 60);
// Refused for its scope, so it isn't used up.
assert.ok(!(await opens('/control', single.token, 'null')), 'a single watch grant opened /control');
const only = await connect(watchPath, single.token, 'null');
assert.ok(only, 'the single-connection grant did not open its connection');
// A used single-connection grant is refused at the handshake, with no 101 upgrade.
assert.equal(await connect(watchPath, single.token, 'null'), null, 'a used single-connection grant got past the handshake');
await sleep(800);
assert.ok(!only.closed, 'a refused second connection closed the first');
assert.equal((await request('DELETE', `/grants/${single.id}`, token)).status, 200);
assert.ok(await closesWithin(only, 2000), 'revoking a single-connection grant left its connection open');

assert.equal((await request('GET', '/capabilities', token)).status, 200);
owner.close();
console.log('Grants: scopes enforced, revocation and expiry close live connections, any origin for grants, single-connection grants, owner unaffected');
process.exit(0);
