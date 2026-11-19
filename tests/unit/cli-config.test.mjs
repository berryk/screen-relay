import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { after, test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildSync } from 'esbuild';

const root = fileURLToPath(new URL('../..', import.meta.url));
const cli = join(root, 'dist/cli/relay.mjs');
const entryPoint = join(root, 'src/cli/config.ts');
const directory = mkdtempSync(join(root, '.cli-config-test-'));
after(() => rmSync(directory, { recursive: true, force: true }));
const nodeBanner = { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" };
const bundle = buildSync({ entryPoints: [entryPoint], bundle: true, external: ['yaml'], platform: 'node', format: 'esm', banner: nodeBanner, write: false });
const bundlePath = join(directory, 'config.mjs');
writeFileSync(bundlePath, bundle.outputFiles[0].contents);
const config = await import(pathToFileURL(bundlePath).href);

function write(text) {
  const path = join(directory, 'config.yaml');
  writeFileSync(path, text);
  return path;
}

test('empty SCREEN_RELAY_CONFIG selects the optional default config', () => {
  const previous = { relayConfig: process.env.SCREEN_RELAY_CONFIG, configHome: process.env.XDG_CONFIG_HOME };
  process.env.SCREEN_RELAY_CONFIG = '';
  process.env.XDG_CONFIG_HOME = directory;
  try {
    assert.deepEqual(config.locate(), [null, false]);
  } finally {
    if (previous.relayConfig === undefined) delete process.env.SCREEN_RELAY_CONFIG;
    else process.env.SCREEN_RELAY_CONFIG = previous.relayConfig;
    if (previous.configHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous.configHome;
  }
});

test('loads validated values and keyboard layout', () => {
  const path = write(`
display:
  resolution: 1600x900
stream:
  fps: 30
  bitrate:
    min: 500k
    start: 4M
    max: 20M
server:
  port: 9090
  bind: 0.0.0.0
  public: https://desk.example.com
  allow_origin: https://app.example.com,http://localhost:8081
  tls_cert: /tmp/fullchain.pem
  tls_key: /tmp/key.pem
keyboard:
  layout: fr,us
desktop: none
`);
  const [settings, source, present] = config.loadConfig(path);
  assert.equal(source, path);
  assert.equal(settings.display.resolution, '1600x900');
  assert.equal(settings.stream.fps, 30);
  assert.deepEqual(settings.stream.bitrate, { min: 500000, start: 4000000, max: 20000000 });
  assert.equal(settings.server.port, 9090);
  assert.equal(settings.server.bind, '0.0.0.0');
  assert.equal(settings.server.public, 'https://desk.example.com');
  assert.equal(settings.server.allow_origin, 'https://app.example.com,http://localhost:8081');
  assert.equal(settings.server.tls_cert, '/tmp/fullchain.pem');
  assert.equal(settings.server.tls_key, '/tmp/key.pem');
  assert.equal(settings.keyboard.layout, 'fr,us');
  assert.equal(settings.desktop, 'none');
  assert.ok(present.has('display.resolution'));
});

test('validates server.allow_origin as exact HTTPS or loopback HTTP origins', () => {
  const [settings, , present] = config.loadConfig(write('server:\n  allow_origin: https://app.example.com,http://localhost:8081\n'));
  assert.equal(settings.server.allow_origin, 'https://app.example.com,http://localhost:8081');
  assert.ok(present.has('server.allow_origin'));
  for (const value of ['http://app.example.com', 'http://localhost:80', 'http://LOCALHOST:8081', 'https://App.example.com', 'https://app.example.com/']) {
    assert.throws(() => config.loadConfig(write(`server:\n  allow_origin: ${value}\n`)), /server\.allow_origin/, value);
  }
  assert.throws(() => config.loadConfig(write('server:\n  allow_origin: 8081\n')), /server\.allow_origin.*a string/);

  const previous = process.env.SCREEN_RELAY_ALLOW_ORIGIN;
  try {
    process.env.SCREEN_RELAY_ALLOW_ORIGIN = 'http://localhost:8081';
    const args = {};
    config.applyTo(args, settings, new Set());
    assert.equal(args['allow-origin'], 'http://localhost:8081');
    process.env.SCREEN_RELAY_ALLOW_ORIGIN = 'http://app.example.com';
    assert.throws(() => config.applyTo({}, settings, new Set()), /SCREEN_RELAY_ALLOW_ORIGIN/);
    const explicit = { 'allow-origin': 'https://app.example.com' };
    config.applyTo(explicit, settings, new Set());
    assert.equal(explicit['allow-origin'], 'https://app.example.com');
  } finally {
    if (previous === undefined) delete process.env.SCREEN_RELAY_ALLOW_ORIGIN;
    else process.env.SCREEN_RELAY_ALLOW_ORIGIN = previous;
  }
});

test('validates the FPS range in YAML and keeps the default at 60', () => {
  assert.equal(config.loadConfig(write('{}\n'))[0].stream.fps, 60);
  for (const fps of [10, 60, 61, 120]) {
    assert.equal(config.loadConfig(write(`stream:\n  fps: ${fps}\n`))[0].stream.fps, fps);
  }
  for (const fps of [9, 121]) {
    assert.throws(() => config.loadConfig(write(`stream:\n  fps: ${fps}\n`)), /stream\.fps.*allowed 10\.\.120/);
  }
});

test('validates FPS overrides from arguments and SCREEN_RELAY_FPS', () => {
  const [settings, , present] = config.loadConfig(write('{}\n'));
  const previous = process.env.SCREEN_RELAY_FPS;
  try {
    process.env.SCREEN_RELAY_FPS = '120';
    const args = {};
    config.applyTo(args, settings, present);
    assert.equal(args.fps, 120);
    process.env.SCREEN_RELAY_FPS = '121';
    assert.throws(() => config.applyTo({}, settings, present), /SCREEN_RELAY_FPS.*allowed 10\.\.120/);
    const explicit = { fps: 120 };
    config.applyTo(explicit, settings, present);
    assert.equal(explicit.fps, 120);
    assert.throws(() => config.applyTo({ fps: 121 }, settings, present), /--fps.*allowed 10\.\.120/);
  } finally {
    if (previous === undefined) delete process.env.SCREEN_RELAY_FPS;
    else process.env.SCREEN_RELAY_FPS = previous;
  }
});

test('rejects unknown keys with their path and valid keys', () => {
  assert.throws(() => config.loadConfig(write('stream:\n  fsp: 30\n')), (error) => {
    assert.equal(error.reason, 'invalid_config');
    assert.match(error.message, /stream\.fsp/);
    assert.match(error.hint, /fps/);
    assert.match(error.hint, /bitrate/);
    return true;
  });
});

test('requires even resolutions within bounds', () => {
  assert.throws(() => config.loadConfig(write('display:\n  resolution: 1281x720\n')), /display\.resolution.*even/);
  assert.equal(config.loadConfig(write('display:\n  resolution: 3840x2160\n'))[0].display.resolution, '3840x2160');
  assert.throws(() => config.loadConfig(write('display:\n  resolution: 16386x1080\n')), /display\.resolution.*320\.\.16384/);
});

test('validates bitrate suffixes and ordering', () => {
  let [settings] = config.loadConfig(write('stream:\n  bitrate:\n    min: 250k\n    start: 8M\n    max: 40M\n'));
  assert.deepEqual(settings.stream.bitrate, { min: 250000, start: 8000000, max: 40000000 });
  assert.throws(() => config.loadConfig(write('stream:\n  bitrate:\n    min: 10M\n    start: 1M\n    max: 40M\n')), /min <= start <= max/);
  assert.throws(() => config.loadConfig(write('stream:\n  fps: 30.0\n')), /stream\.fps.*an integer/);
});

test('rejects invalid UTF-8 as invalid input', () => {
  const path = join(directory, 'invalid.yaml');
  writeFileSync(path, Buffer.from([0x64, 0x65, 0x73, 0x6b, 0x74, 0x6f, 0x70, 0x3a, 0x20, 0xff, 0xfe, 0x0a]));
  assert.throws(() => config.loadConfig(path), (error) => {
    assert.equal(error.reason, 'invalid_config');
    assert.match(error.message, /Cannot read config file/);
    return true;
  });
});

test('flags override file values and bind comes only from the file when set', () => {
  let [settings, , present] = config.loadConfig(write('server:\n  port: 9090\n  bind: 0.0.0.0\ndesktop: none\n'));
  let args = { port: 9000, bind: undefined, public: undefined, 'tls-cert': undefined, 'tls-key': undefined, desktop: undefined };
  config.applyTo(args, settings, present);
  assert.equal(args.port, 9000);
  assert.equal(args.bind, '0.0.0.0');
  assert.equal(args.desktop, 'none');

  [settings, , present] = config.loadConfig(write('server:\n  port: 9090\n'));
  args = { port: undefined, bind: undefined, public: 'https://desk.example.com', 'tls-cert': undefined, 'tls-key': undefined, desktop: undefined };
  config.applyTo(args, settings, present);
  assert.equal(args.bind, undefined);

  [settings, , present] = config.loadConfig(write('server:\n  bind: 192.168.1.5\n'));
  args = { port: undefined, bind: '10.0.0.1', public: undefined, 'tls-cert': undefined, 'tls-key': undefined, desktop: undefined };
  config.applyTo(args, settings, present);
  assert.equal(args.bind, '10.0.0.1');
});

test('defaults keyboard layout to us and validates its allowed characters', () => {
  assert.equal(config.loadConfig()[0].keyboard.layout, 'us');
  assert.throws(() => config.loadConfig(write('keyboard:\n  layout: fr!\n')), /keyboard\.layout/);
  assert.throws(() => config.loadConfig(write('keyboard:\n  layout: 7\n')), /keyboard\.layout.*a string/);
});

test('the compositor setting defaults to auto and accepts only auto, on or off', () => {
  assert.equal(config.loadConfig()[0].display.compositor, 'auto');
  assert.equal(config.loadConfig(write('display:\n  compositor: off\n'))[0].display.compositor, 'off');
  assert.throws(() => config.loadConfig(write('display:\n  compositor: true\n')), /display\.compositor.*auto or on or off/);
});

test('backend from the config file accepts supported names and reports invalid ones', () => {
  for (const backend of ['x11', 'wayland', 'macos']) {
    assert.equal(config.loadConfig(write(`backend: ${backend}\n`))[0].backend, backend);
  }
  assert.throws(() => config.loadConfig(write('backend: mir\n')), /backend.*x11 or wayland or macos/);
});

test('doctor reports an invalid SCREEN_RELAY_BACKEND as a failed check', { skip: process.platform !== 'linux' }, () => {
  const path = write('backend: x11\n');
  const result = spawnSync(process.execPath, [cli, 'doctor', '--config', path, '--json'], {
    encoding: 'utf8', timeout: 15000, env: { ...process.env, SCREEN_RELAY_BACKEND: 'wayl' },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  const { checks } = JSON.parse(result.stdout);
  const backend = checks.find((item) => item.name === 'backend');
  assert.equal(backend.status, 'fail');
  assert.match(backend.detail, /SCREEN_RELAY_BACKEND.*wayl.*x11 or wayland/);
});
