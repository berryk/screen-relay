import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { after, test } from 'node:test';
import { existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildSync } from 'esbuild';

const root = fileURLToPath(new URL('../..', import.meta.url));
const directory = mkdtempSync(join(tmpdir(), 'relay-state-test-'));
after(() => rmSync(directory, { recursive: true, force: true }));
const nodeBanner = { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" };
const bundle = buildSync({ entryPoints: [join(root, 'src/cli/host/state.ts')], bundle: true, platform: 'node', format: 'esm', banner: nodeBanner, write: false });
const bundlePath = join(directory, 'state.mjs');
writeFileSync(bundlePath, bundle.outputFiles[0].contents);
const state = await import(pathToFileURL(bundlePath).href);
const supervisorBundle = buildSync({ entryPoints: [join(root, 'src/cli/host/supervisor.ts')], bundle: true, platform: 'node', format: 'esm', banner: nodeBanner, write: false });
const supervisorPath = join(directory, 'supervisor.mjs');
writeFileSync(supervisorPath, supervisorBundle.outputFiles[0].contents);
const { resolveBackend, sessionNeeds, splitCommand } = await import(pathToFileURL(supervisorPath).href);
const commandsBundle = buildSync({ entryPoints: [join(root, 'src/cli/host/session_commands.ts')], bundle: true, platform: 'node', format: 'esm', banner: nodeBanner, write: false });
const commandsPath = join(directory, 'session-commands.mjs');
writeFileSync(commandsPath, commandsBundle.outputFiles[0].contents);
const { cmdDown, cmdStatus } = await import(pathToFileURL(commandsPath).href);

test('a Linux session needs setpriv even when it attaches to a display with no desktop', () => {
  const previous = process.env.PATH;
  const empty = join(directory, 'no-tools');
  mkdirSync(empty, { recursive: true });
  try {
    process.env.PATH = empty;
    assert.deepEqual(sessionNeeds('x11', { display: ':0', desktop: 'none' }).missing, ['setpriv']);
    assert.deepEqual(sessionNeeds('wayland', { display: 'wayland-1', desktop: 'none' }).missing, ['setpriv']);
    assert.deepEqual(sessionNeeds('macos', {}).missing, []);
  } finally {
    process.env.PATH = previous;
  }
});

test('backend follows the display unless explicitly selected', { skip: process.platform === 'darwin' }, () => {
  const engine = join(directory, 'relay-engine');
  writeFileSync(engine, "#!/bin/sh\nprintf '%s\\n' 'Compiled backends: x11, wayland'\n", { mode: 0o755 });
  try {
    assert.equal(resolveBackend(undefined, 'wayland-1'), 'wayland');
    assert.equal(resolveBackend(undefined, ':0'), 'x11');
    assert.throws(() => resolveBackend('x11', 'wayland-1'), { reason: 'invalid_input' });
    assert.throws(() => resolveBackend('wayland', ':0'), { reason: 'invalid_input' });
    writeFileSync(engine, "#!/bin/sh\nprintf '%s\\n' 'Compiled backends: x11'\n");
    assert.throws(() => resolveBackend(undefined, 'wayland-1'), { reason: 'missing_dependency' });
  } finally {
    rmSync(engine, { force: true });
  }
});

test('macOS uses the macos backend and rejects the Linux ones', { skip: process.platform !== 'darwin' }, () => {
  const engine = join(directory, 'relay-engine');
  writeFileSync(engine, "#!/bin/sh\nprintf '%s\\n' 'Compiled backends: macos'\n", { mode: 0o755 });
  try {
    assert.equal(resolveBackend(undefined), 'macos');
    assert.equal(resolveBackend('macos'), 'macos');
    assert.throws(() => resolveBackend('x11'), { reason: 'invalid_input' });
    assert.throws(() => resolveBackend('wayland'), { reason: 'invalid_input' });
    writeFileSync(engine, "#!/bin/sh\nprintf '%s\\n' 'Compiled backends: x11, wayland'\n");
    assert.throws(() => resolveBackend(undefined), { reason: 'missing_dependency' });
  } finally {
    rmSync(engine, { force: true });
  }
});

test('desktop command parsing preserves quoted empty arguments', () => {
  assert.deepEqual(splitCommand('my-desktop --profile "" --fullscreen'), ['my-desktop', '--profile', '', '--fullscreen']);
});

test('Wayland cleanup removes only a recorded runtime and clears its state', { skip: typeof process.getuid !== 'function' }, () => {
  const runtime = mkdtempSync('/tmp/relay-');
  const unknown = mkdtempSync('/tmp/relay-');
  try {
    writeFileSync(join(runtime, 'runtime-file'), '');
    const stat = lstatSync(runtime, { bigint: true });
    const session = {
      backend: 'wayland', runtimeDir: runtime, waylandDisplay: 'wayland-1',
      runtimeIdentity: { dev: String(stat.dev), ino: String(stat.ino), uid: String(stat.uid) },
      environment: { XDG_RUNTIME_DIR: runtime, XDG_CONFIG_HOME: '/config' },
    };
    state.cleanupWaylandRuntime(session);
    assert.equal(existsSync(runtime), false);
    assert.deepEqual(session, { backend: 'wayland', environment: { XDG_CONFIG_HOME: '/config' } });
    state.cleanupWaylandRuntime(session);
    const legacy = { backend: 'wayland', runtimeDir: unknown };
    state.cleanupWaylandRuntime(legacy);
    assert.equal(existsSync(unknown), true);
    assert.deepEqual(legacy, { backend: 'wayland' });
    const stale = { backend: 'wayland', runtimeDir: unknown, runtimeIdentity: { dev: String(stat.dev), ino: String(stat.ino), uid: String(stat.uid) } };
    state.cleanupWaylandRuntime(stale);
    assert.equal(existsSync(unknown), true);
    assert.deepEqual(stale, { backend: 'wayland' });
  } finally {
    rmSync(runtime, { recursive: true, force: true });
    rmSync(unknown, { recursive: true, force: true });
  }
});

test('session sweep does not match a longer SCREEN_RELAY_SESSION value', { skip: !existsSync('/proc/self/environ') }, async () => {
  const session = join(directory, 'desk');
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    env: { ...process.env, SCREEN_RELAY_SESSION: `${session}2` },
    stdio: 'ignore',
  });
  try {
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    await state.sweep(session);
    assert.equal(child.exitCode, null);
  } finally {
    child.kill('SIGKILL');
  }
});

test('process identity is stable while a process lives and dead after it exits', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  let record;
  try {
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    record = state.identity(child.pid);
    assert.equal(typeof record.start, 'string');
    assert.deepEqual(state.identity(child.pid), record);
    assert.equal(state.alive(record), true);
  } finally {
    child.kill('SIGKILL');
  }
  await new Promise((resolve) => child.once('exit', resolve));
  assert.equal(state.alive(record), false);
});

const lockToolReady = process.platform === 'darwin'
  ? spawnSync('lockf', ['-s', '-t', '0', join(directory, 'lock-probe'), 'true'], { stdio: 'ignore' }).status === 0
  : spawnSync('flock', ['--version'], { stdio: 'ignore' }).status === 0;

test('down persists Wayland cleanup without rewriting a stopped session again', { skip: !lockToolReady || typeof process.getuid !== 'function' }, async () => {
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = join(directory, 'persisted');
  const runtime = mkdtempSync('/tmp/relay-');
  try {
    const sessionDir = state.stateDir('wayland-cleanup');
    mkdirSync(sessionDir, { recursive: true });
    const stat = lstatSync(runtime, { bigint: true });
    state.writeSession(sessionDir, {
      state: 'stopped', backend: 'wayland', runtimeDir: runtime, waylandDisplay: 'wayland-1',
      runtimeIdentity: { dev: String(stat.dev), ino: String(stat.ino), uid: String(stat.uid) },
      environment: { XDG_RUNTIME_DIR: runtime, SWAYSOCK: `${runtime}/sway.sock` },
    });
    await cmdDown({ command: 'down', json: true, name: 'wayland-cleanup' });
    assert.equal(existsSync(runtime), false);
    assert.deepEqual(state.readSession('wayland-cleanup'), { state: 'stopped', backend: 'wayland', environment: {} });
    const file = join(sessionDir, 'session.json');
    const preserved = '{"state":"stopped","backend":"wayland","environment":{}}\n';
    writeFileSync(file, preserved);
    await cmdDown({ command: 'down', json: true, name: 'wayland-cleanup' });
    assert.equal(readFileSync(file, 'utf8'), preserved);
  } finally {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
    rmSync(runtime, { recursive: true, force: true });
  }
});

test('status JSON omits the Wayland runtime identity without changing the session', async () => {
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = join(directory, 'status');
  const runtime = mkdtempSync(join(tmpdir(), 'relay-status-'));
  try {
    const sessionDir = state.stateDir('wayland-status');
    mkdirSync(sessionDir, { recursive: true });
    const runtimeIdentity = { dev: '1', ino: '2', uid: '3' };
    state.writeSession(sessionDir, {
      state: 'stopped', backend: 'wayland', runtimeDir: runtime, waylandDisplay: 'wayland-1', runtimeIdentity,
      components: { engine: { pid: 1, start: null } },
    });
    const writes = [];
    const write = process.stdout.write;
    process.stdout.write = (chunk) => { writes.push(String(chunk)); return true; };
    try { await cmdStatus({ command: 'status', json: true, name: 'wayland-status' }); }
    finally { process.stdout.write = write; }
    const { session } = JSON.parse(writes.join(''));
    assert.equal('runtimeIdentity' in session, false);
    assert.equal('components' in session, false);
    assert.equal(session.runtimeDir, runtime);
    assert.deepEqual(state.readSession('wayland-status').runtimeIdentity, runtimeIdentity);
  } finally {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
    rmSync(runtime, { recursive: true, force: true });
  }
});

test('closing an exited lock holder resolves', { skip: !lockToolReady }, async () => {
  const sessionDirectory = join(directory, 'exited-holder');
  mkdirSync(sessionDirectory);
  const held = await state.lock('exited-holder', sessionDirectory);
  await held.close();
  await held.close();
});

test('the regular lock file serializes concurrent acquisitions', { skip: !lockToolReady }, async () => {
  const lockDir = join(directory, 'lock-race');
  mkdirSync(lockDir);
  const lockFile = join(lockDir, 'lock');
  writeFileSync(lockFile, '');
  const acquisitions = await Promise.allSettled([state.lock('desk', lockDir), state.lock('desk', lockDir)]);
  const acquired = acquisitions.filter((result) => result.status === 'fulfilled');
  const rejected = acquisitions.filter((result) => result.status === 'rejected');
  assert.equal(acquired.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason.reason, 'already_running');
  assert.equal(readFileSync(lockFile, 'utf8'), '');
  await acquired[0].value.close();
  await (await state.lock('desk', lockDir)).close();
});

test('setting the compositor keeps the other saved xfwm4 settings', async () => {
  const { writeCompositing, compositing } = await import(pathToFileURL(supervisorPath).href);
  assert.deepEqual([compositing('auto', 60), compositing('auto', 61), compositing('on', 120), compositing('off', 30)], [true, false, true, false]);
  const home = mkdtempSync(join(directory, 'config-'));
  const file = join(home, 'xfce4', 'xfconf', 'xfce-perchannel-xml', 'xfwm4.xml');
  const off = '<property name="use_compositing" type="bool" value="false"/>';
  writeCompositing(home, false);
  assert.ok(readFileSync(file, 'utf8').includes(off));
  const theme = '<property name="theme" type="string" value="Greybird"/>';
  const focus = '<property name="click_to_focus" type="bool" value="false"/>';
  const wrap = (body) => `<?xml version="1.0" encoding="UTF-8"?>\n<channel name="xfwm4" version="1.0">\n  <property name="general" type="empty">\n${body}  </property>\n</channel>\n`;
  writeFileSync(file, wrap(`    ${theme}\n    <property name="use_compositing" type="bool" value="true"/>\n    ${focus}\n`));
  writeCompositing(home, false);
  let saved = readFileSync(file, 'utf8');
  assert.ok(saved.includes(theme) && saved.includes(focus) && saved.includes(off));
  assert.ok(!saved.includes('value="true"'));
  writeFileSync(file, wrap(`    ${theme}\n`));
  writeCompositing(home, false);
  saved = readFileSync(file, 'utf8');
  assert.ok(saved.includes(theme) && saved.includes(off));
  assert.equal(saved.match(/use_compositing/g).length, 1);
  writeCompositing(home, true);
  saved = readFileSync(file, 'utf8');
  assert.ok(saved.includes(theme) && saved.includes('name="use_compositing" type="bool" value="true"') && !saved.includes(off));
});
