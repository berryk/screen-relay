import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { request } from 'node:http';

const [port, token, address = '127.0.0.2'] = [Number(process.argv[2]), process.argv[3], process.argv[4]];
const host = `127.0.0.1:${port}`;
const publicOrigin = 'https://desktop.example.test';
const embedded = 'https://app.example.test';
const localEmbedded = 'http://localhost:8081';

function probe({ origin, hostHeader = 'desktop.example.test', websocket = false, authenticated = true }) {
  return new Promise((resolve, reject) => {
    const headers = { Host: hostHeader, ...(origin === undefined ? {} : { Origin: origin }) };
    if (websocket) {
      Object.assign(headers, { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
        'Sec-WebSocket-Protocol': authenticated ? `nsl1, bearer.${token}` : 'nsl1' });
    } else if (authenticated) headers.Authorization = `Bearer ${token}`;
    const req = request({ host: address, port, path: websocket ? '/stream?view=1' : '/capabilities', headers });
    req.setTimeout(3000, () => req.destroy(new Error('Origin probe timed out')));
    req.on('response', (response) => { response.resume(); resolve(response.statusCode); });
    req.on('upgrade', (response, socket) => { socket.destroy(); resolve(response.statusCode); });
    req.on('error', (error) => {
      if (websocket && error.code === 'ECONNRESET') resolve(0);
      else reject(error);
    });
    req.end();
  });
}
for (const origin of [undefined, publicOrigin, embedded, localEmbedded]) assert.equal(await probe({ origin }), 200);
assert.equal(await probe({ origin: publicOrigin, authenticated: false }), 401);
assert.equal(await probe({ origin: publicOrigin, hostHeader: "Desktop.Example.test:443" }), 200);
assert.equal(await probe({ origin: publicOrigin, hostHeader: "desktop.example.test:8443" }), 403);
assert.equal(await probe({ origin: `http://${host}`, hostHeader: host }), 200);
assert.equal(await probe({ origin: `http://127.0.0.1:${port + 1}`, hostHeader: host }), 403);
for (const origin of ['null', '*', 'http://desktop.example.test', 'https://app.example.test:8443',
  'https://untrusted.example.test', 'https://app.example.test.untrusted.example', `http://${host}`,
  'http://localhost:8082', 'http://127.0.0.1:8081']) {
  assert.equal(await probe({ origin }), 403, origin);
}
assert.equal(await probe({ origin: publicOrigin, hostHeader: 'untrusted.example.test' }), 403);
for (const origin of [undefined, publicOrigin, embedded, localEmbedded]) assert.equal(await probe({ origin, websocket: true }), 101);
for (const origin of ['null', 'https://untrusted.example.test', `http://${host}`, 'http://localhost:8082']) {
  assert.notEqual(await probe({ origin, websocket: true }), 101, origin);
}
console.log('Origins: HTTP and WebSocket allow only the configured origins, including loopback HTTP pages; origin-less clients stay authenticated');
