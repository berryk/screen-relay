import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const browserBin = join(root, 'node_modules/.bin/agent-browser');
const image = process.env.SCREEN_RELAY_E2E_IMAGE ?? 'relay-e2e';
const container = `relay-e2e-${process.pid}`;
const work = mkdtempSync(join(tmpdir(), 'relay-e2e-'));
let browserSession = null;
let browserOpened = false;
let cdpPort = null;

function run(file, args, options = {}) {
  return execFileSync(file, args, { cwd: root, maxBuffer: 64 * 1024 * 1024, ...options });
}
function text(value) {
  return Buffer.isBuffer(value) ? value.toString('utf8') : value;
}
function docker(args, options = {}) {
  return run('docker', args, options);
}
function execIn(args, options = {}) {
  return run('docker', ['exec', container, ...args], options);
}
function execInRoot(args, options = {}) {
  return run('docker', ['exec', '-u', 'root', container, ...args], options);
}
function browser(args) {
  return text(run(browserBin, args, { env: { ...process.env, AGENT_BROWSER_SESSION: browserSession } }));
}
function evalJs(script) {
  return JSON.parse(browser(['eval', '-b', Buffer.from(script).toString('base64')]).trim());
}
function portOpen(port) {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.on('error', () => { socket.destroy(); resolve(false); });
    socket.on('connect', () => { socket.destroy(); resolve(true); });
  });
}
async function poll(read, accept, timeout, message) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await read();
      if (accept(last)) return last;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await sleep(200);
  }
  assert.fail(`${message} (last value: ${typeof last === 'string' ? last : JSON.stringify(last)})`);
}
function appsLog() {
  try {
    return text(execIn(['screen-relay', 'logs', 'apps'])).trim().split('\n').slice(-20).join('\n');
  } catch {
    return 'unavailable';
  }
}

try {
  browserSession = text(run(browserBin, ['session', 'id', '--scope', 'worktree', '--prefix', 'relay-e2e'])).trim();
  assert.ok(browserSession, 'agent-browser did not return a session id');
  try {
    browser(['close']);
  } catch {}
  console.log(`browser session ${browserSession}`);

  if (!process.env.SCREEN_RELAY_E2E_IMAGE) {
    console.log(`building ${image}`);
    docker(['build', '-t', image, '.'], { stdio: 'inherit' });
  }

  const config = join(work, 'config.yaml');
  writeFileSync(config, 'display:\n  resolution: 1920x1080\n');

  docker(['run', '-d', '--name', container, '-p', '127.0.0.1::8080', '-e', 'LANG=C.UTF-8',
    '-v', `${config}:/relay-config.yaml:ro`, '-e', 'SCREEN_RELAY_CONFIG=/relay-config.yaml', image], { stdio: 'inherit' });
  const published = text(docker(['port', container, '8080'])).trim().split('\n')[0];
  const port = Number(published.slice(published.lastIndexOf(':') + 1));
  assert.ok(Number.isInteger(port) && port > 0, `could not read the published port from "${published}"`);
  console.log(`container ${container} on port ${port}`);

  execInRoot(['sh', '-c', 'apt-get update -qq && env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends xdotool'],
    { stdio: ['ignore', 'ignore', 'inherit'] });

  const relay = await poll(
    () => JSON.parse(text(execIn(['screen-relay', 'status', '--show-token', '--json']))).session,
    (value) => value?.running === true && /^[0-9a-f]{64}$/.test(value?.token ?? ''),
    120000,
    'the session did not become ready with a token',
  );
  assert.equal(relay.resolution, '1920x1080', `the session resolution is ${relay.resolution}, expected 1920x1080`);
  assert.ok(relay.display && relay.xauthority, `status has no display or X authority: ${JSON.stringify(relay)}`);
  console.log(`session ready on ${relay.display}, ${relay.resolution}`);
  const xdotool = (args) => text(run('docker', ['exec', '-e', `DISPLAY=${relay.display}`, '-e', `XAUTHORITY=${relay.xauthority}`,
    container, 'xdotool', ...args]));

  browser(['set', 'viewport', '1280', '720']);
  browser(['open', `http://127.0.0.1:${port}/#token=${relay.token}`]);
  browserOpened = true;
  const cdpUrl = browser(['get', 'cdp-url']).trim();
  cdpPort = Number(new URL(cdpUrl).port);
  assert.ok(Number.isInteger(cdpPort) && cdpPort > 0, `could not read a CDP port from "${cdpUrl}"`);

  function viewer() {
    return evalJs(`({
      drawn: window.nativeStats?.drawn ?? 0,
      decodeerrors: window.nativeStats?.decodeerrors ?? -1,
      width: document.querySelector('#screen')?.width ?? 0,
      height: document.querySelector('#screen')?.height ?? 0,
      status: document.querySelector('#status')?.textContent ?? '',
      control: document.querySelector('[data-action="control"]')?.getAttribute('aria-pressed') ?? '',
    })`);
  }
  try {
    await poll(() => viewer(), (view) => view.drawn > 0, 30000, 'the viewer drew no frames');
  } catch {
    let statusText = null;
    try {
      statusText = browser(['get', 'text', '#status']).trim();
    } catch {}
    assert.fail(`the viewer drew no frames: ${statusText || 'no status text'}`);
  }
  const view = viewer();
  assert.ok(view.drawn > 0, `the viewer drew ${view.drawn} frames`);
  assert.equal(view.decodeerrors, 0, `the viewer reported ${view.decodeerrors} decode errors`);
  assert.equal(view.width, 1920, `the canvas is ${view.width} pixels wide, expected 1920`);
  assert.equal(view.height, 1080, `the canvas is ${view.height} pixels high, expected 1080`);
  console.log(`viewer live: ${view.drawn} frames drawn, ${view.width}x${view.height}`);
  assert.equal(view.status, 'Live · you have control', `the viewer status is "${view.status}"`);
  assert.equal(view.control, 'true', 'the first viewer did not claim idle input');

  const watcher = new WebSocket(`ws://127.0.0.1:${port}/stream?view=1`, ['nsl1', `bearer.${relay.token}`]);
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('the second viewer received no video')), 10000);
      watcher.addEventListener('message', () => { clearTimeout(timer); resolve(); }, { once: true });
      watcher.addEventListener('error', () => { clearTimeout(timer); reject(new Error('the second viewer could not connect')); }, { once: true });
    });
    assert.equal(viewer().status, 'Live · you have control');
  } finally {
    watcher.close();
  }

  browser(['click', '#toolbar-toggle']);
  browser(['click', '[data-action="control"]']);
  await poll(() => viewer(), (view) => view.status === 'Live · view only' && view.control === 'false', 15000,
    'the first viewer did not release control');

  const box = evalJs(`(() => {
    const rect = document.querySelector('#screen').getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  })()`);
  assert.ok(box && box.width > 0 && box.height > 0, 'the viewer canvas has no layout box');
  async function clickAt(x, y) {
    browser(['mouse', 'move', String(Math.round(x)), String(Math.round(y))]);
    browser(['mouse', 'down', 'left']);
    browser(['mouse', 'up', 'left']);
  }
  function pointerLocation() {
    const out = xdotool(['getmouselocation']);
    const match = /x:(\d+) y:(\d+)/.exec(out);
    if (!match) throw new Error(`unexpected xdotool output: ${out}`);
    return { x: Number(match[1]), y: Number(match[2]) };
  }

  async function openTerminal(command) {
    text(execIn(['screen-relay', 'run', '--json', '--', 'xfce4-terminal', '-x', 'sh', '-c', command]));
    let id;
    try {
      id = await poll(
        () => text(xdotool(['search', '--onlyvisible', '--class', '[Xx]fce4-[Tt]erminal'])).trim().split(/\s+/).filter(Boolean).at(-1),
        Boolean,
        30000,
        `xfce4-terminal did not open for: ${command}`,
      );
    } catch (error) {
      assert.fail(`${error.message}\napps log:\n${appsLog()}`);
    }
    xdotool(['windowmove', id, '0', '0']);
    xdotool(['windowsize', id, '1900', '1000']);
    xdotool(['windowactivate', '--sync', id]);
    await sleep(500);
    return id;
  }
  async function clickCenter() {
    await clickAt(box.x + box.width * 0.5, box.y + box.height * 0.5);
    await sleep(300);
  }
  async function waitForFile(path) {
    await poll(() => { execIn(['test', '-e', path]); return true; }, Boolean, 10000, `${path} did not appear`);
  }

  const typedWindow = await openTerminal('cat > /tmp/out');
  await waitForFile('/tmp/out');

  text(execIn(['screen-relay', 'click', '0.5', '0.5']));
  text(execIn(['screen-relay', 'type', 'while watching']));
  text(execIn(['screen-relay', 'key', 'Enter']));
  await poll(
    () => text(execIn(['cat', '/tmp/out'])),
    (value) => value.includes('while watching'),
    10000,
    'the CLI could not type into the terminal while a view-only viewer watched',
  );
  console.log('CLI click and type worked while the viewer watched');

  browser(['click', '[data-action="control"]']);
  await poll(
    () => viewer(),
    (state) => state.status === 'Live · you have control' && state.control === 'true',
    15000,
    'the viewer did not take control',
  );
  console.log('viewer took control');

  await clickAt(box.x + box.width * 0.25, box.y + box.height * 0.75);
  await poll(
    () => pointerLocation(),
    (point) => point.x === 480 && point.y === 810,
    10000,
    'a click at 25% x 75% of the canvas did not land at X 480, Y 810',
  );
  console.log('click landed at 480,810');

  await clickCenter();
  for (const key of 'hello') browser(['press', key]);
  browser(['press', 'Enter']);
  await poll(
    () => text(execIn(['cat', '/tmp/out'])),
    (value) => value.includes('hello'),
    10000,
    'the viewer did not type "hello" into the terminal',
  );
  console.log('viewer typed hello');

  browser(['click', '[data-action="keys"]']);
  if (browser(['get', 'attr', '#meta-ctrl', 'aria-pressed']).trim() !== 'true') browser(['click', '#meta-ctrl']);
  assert.equal(browser(['get', 'attr', '#meta-ctrl', 'aria-pressed']).trim(), 'true', 'the "Use ⌘ as Ctrl" setting is off');

  const ctrlWindow = await openTerminal('stty -icanon -echo; cat -v > /tmp/ctrl');
  await waitForFile('/tmp/ctrl');
  await clickCenter();
  evalJs(`(() => {
    const canvas = document.querySelector('#screen');
    const fire = (type, init) => canvas.dispatchEvent(new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init }));
    fire('keydown', { key: 'Meta', code: 'MetaLeft', metaKey: true });
    fire('keydown', { key: 'a', code: 'KeyA', metaKey: true });
    fire('keyup', { key: 'a', code: 'KeyA', metaKey: true });
    fire('keyup', { key: 'Meta', code: 'MetaLeft' });
    return true;
  })()`);
  await poll(
    () => text(execIn(['cat', '/tmp/ctrl'])),
    (value) => value.includes('^A'),
    10000,
    'Meta+a with "Use ⌘ as Ctrl" on did not arrive as Ctrl+A',
  );
  console.log('Meta+a arrived as Ctrl+A');

  xdotool(['windowclose', ctrlWindow]);
  xdotool(['windowactivate', '--sync', typedWindow]);

  browser(['click', '[data-action="control"]']);
  await poll(
    () => viewer(),
    (state) => state.status === 'Live · view only' && state.control === 'false',
    15000,
    'the viewer did not release control',
  );
  console.log('viewer released control');

  text(execIn(['screen-relay', 'type', 'héllo €']));
  text(execIn(['screen-relay', 'key', 'Enter']));
  await poll(
    () => execIn(['cat', '/tmp/out'], { encoding: null }),
    (value) => value.includes(Buffer.from('héllo €')),
    10000,
    'screen-relay type from the CLI did not deliver the UTF-8 text "héllo €"',
  );
  console.log('CLI typed héllo €');

  browser(['open', 'about:blank']);
  await sleep(1000);
  console.log('PASS');
} finally {
  const problems = [];
  if (browserSession) {
    try {
      browser(['close']);
    } catch (error) {
      if (browserOpened) problems.push(`agent-browser close failed: ${error.message}`);
    }
    if (cdpPort) {
      try {
        await poll(() => portOpen(cdpPort), (open) => !open, 15000,
          `a Chrome process from session ${browserSession} still listens on CDP port ${cdpPort}`);
      } catch (error) {
        problems.push(error.message);
      }
    }
  }
  try {
    docker(['rm', '-f', container], { stdio: 'ignore' });
  } catch (error) {
    problems.push(`could not remove container ${container}: ${error.message}`);
  }
  rmSync(work, { recursive: true, force: true });
  if (problems.length) {
    console.error(problems.join('\n'));
    process.exitCode = 1;
  }
}
