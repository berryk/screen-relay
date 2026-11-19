import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createClient, RelayError, type Client } from '../sdk/index.js';
import { MAX_INPUT_BATCH, isLoopback, validToken } from '../protocol/index.js';
import { DEFAULT_PORT } from './host/common.js';
import { connectHost } from './host/supervisor.js';
import { alive, readSession } from './host/state.js';
import { count, emit, Failure, nextFor, nextStep, quote, receipt, row, sessionCommand, size, writeText } from './output.js';

type Args = Record<string, any> & { command: string; json: boolean; name: string };

interface Target { url: string; token?: string; certificate?: string; connect?: string; timeout: number; signal?: AbortSignal; explicit: boolean }

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function detail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function invalidUrl(url: string): Failure {
  let safe = url;
  try {
    const parsed = new URL(url);
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    safe = parsed.toString();
  } catch {
    safe = url.match(/^[A-Za-z][A-Za-z\d+.-]*:/)?.[0] ?? '';
  }
  return new Failure('invalid_input', `Invalid server URL: ${safe}`, 'Pass --url https://desktop.example.com or --url http://127.0.0.1:8080.',
    {}, { label: 'Use an HTTPS origin or a local address' });
}

function checkUrl(url: string, token?: string): string {
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw invalidUrl(url); }
  const local = isLoopback(parsed.hostname);
  if (!['http:', 'https:'].includes(parsed.protocol) || (!local && parsed.protocol !== 'https:') ||
      parsed.username || parsed.password || !['', '/'].includes(parsed.pathname) || parsed.search || parsed.hash) {
    throw invalidUrl(url);
  }
  if ((token !== undefined && !validToken(token)) || (!local && !token)) {
    throw new Failure('invalid_input', 'Remote servers need a 64-character lowercase hex token', 'Pass --token-file FILE or set SCREEN_RELAY_TOKEN_FILE.');
  }
  return url.replace(/\/$/, '');
}

/** Resolves the engine a client command talks to from flags, the environment, or the local session. */
export function resolveTarget(args: Args): Target {
  let url: string | undefined = typeof args.url === 'string' && args.url ? args.url : undefined;
  if (!url && process.env.SCREEN_RELAY_URL) url = process.env.SCREEN_RELAY_URL;
  const explicit = Boolean(url);
  let tokenFile = typeof args['token-file'] === 'string' ? args['token-file'] : process.env.SCREEN_RELAY_TOKEN_FILE;
  let certificate: string | undefined, connect: string | undefined;
  if (!url) {
    const session = readSession(String(args.name));
    if (session?.state === 'ready' && alive(session.supervisor)) {
      url = String(session.localUrl);
      certificate = session.tlsCert ?? undefined;
      connect = connectHost(session.bind) ?? undefined;
      tokenFile = tokenFile || session.tokenFile;
    } else if (!session && args.name === 'default' && args.nameExplicit === false) {
      url = `http://127.0.0.1:${DEFAULT_PORT}`;
    } else {
      throw new Failure('not_running', `No running session named "${args.name}"`,
        `Start it with \`${sessionCommand('up -d', args.name)}\`, or pass --url.`, {}, { next: nextFor(sessionCommand('up -d', args.name)), label: 'Start a session' });
    }
  }
  let token: string | undefined;
  if (tokenFile) {
    try { token = readFileSync(tokenFile, 'utf8').trim(); }
    catch (error) { throw new Failure('invalid_input', `Cannot read token file: ${detail(error)}`, 'Check --token-file.'); }
  }
  return { url: checkUrl(url, token), token, certificate, connect, timeout: Number(args.timeout ?? 10), signal: args.signal, explicit };
}

const RECOVERY: Partial<Record<string, string>> = {
  busy: 'Close the other viewer or client, then retry.',
  unauthorized: 'Pass the token with --token-file FILE or set SCREEN_RELAY_TOKEN_FILE.',
  forbidden: 'Use the --public origin, or a loopback page whose origin matches the address it connects to. A browser page on another origin needs --allow-origin on `screen-relay up`.',
  unsupported_input: 'Use screen-relay type for layout-neutral text.',
  disconnected: 'Retry the command.',
  clipboard_unavailable: 'Run screen-relay status --json and check capabilities.clipboard.',
};

/** Turns an SDK error into the CLI failure shape the documented commands and exit codes use. */
export function clientFailure(error: unknown, target: Target): Failure {
  if (error instanceof Failure) return error;
  if (error instanceof RelayError) {
    const host = new URL(target.url).host;
    if (error.reason === 'timeout') {
      return new Failure('timeout', `Couldn't reach ${host}. The request timed out.`, 'Raise --timeout, or check the engine.', {}, remoteRecovery(target));
    }
    if (error.reason === 'unreachable') {
      return new Failure('unreachable', `Couldn't reach ${host}. ${error.message}`, 'Check the address.', {}, remoteRecovery(target));
    }
    const applied = (error as RelayError & { applied?: number }).applied;
    return new Failure(error.reason, error.message, error.hint ?? RECOVERY[error.reason] ?? '', { ...error.data, ...(applied === undefined ? {} : { applied }) }, { next: error.next, status: error.status, label: error.label });
  }
  return new Failure('internal', detail(error));
}

function remoteRecovery(target: Target): { next?: ReturnType<typeof nextFor>; label: string } {
  return target.explicit
    ? { next: nextFor(`screen-relay status --url ${quote(target.url)}`), label: 'Check the remote session' }
    : { next: nextFor('screen-relay up -d'), label: 'Start a session' };
}

function open(target: Target): Client {
  return createClient({ url: target.url, token: target.token, certificate: target.certificate, connect: target.connect, timeout: target.timeout * 1000, signal: target.signal });
}

async function withClient<Result>(args: Args, action: (client: Client) => Promise<Result>, target = resolveTarget(args)): Promise<Result> {
  try { return await action(open(target)); }
  catch (error) { throw clientFailure(error, target); }
}

/** The text argument, or all of stdin read as a stream, since a synchronous read of a pipe can fail before the writer finishes. */
async function textArgument(args: Args, value: unknown): Promise<string> {
  if (Boolean(args.stdin) === (value !== undefined)) throw new Failure('invalid_input', 'Give the argument or --stdin, not both or neither');
  if (!args.stdin) return String(value);
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function number(value: string): string {
  return String(Number(value));
}

function finish(args: Args, events: number, what: string, target: Target): number {
  emit(args, { input: { events }, outcome: 'sent' },
    [receipt('Sent', count(events, 'event'), args), row('Target', target.url), row('Action', what),
      nextStep('Check the screen', `${sessionCommand('screenshot', args.name)}${args.url ? ` --url ${args.url}` : ''}${args['token-file'] ? ` --token-file '${String(args['token-file']).replaceAll("'", "'\\''")}'` : ''}`, args)].join('\n'), {});
  return 0;
}

export async function cmdScreenshot(args: Args): Promise<number> {
  if (args.json && args.file === '-') throw new Failure('invalid_input', '--json cannot be combined with PNG output on stdout', 'Run `screen-relay screenshot --help`.');
  const data = await withClient(args, (client) => client.screenshot());
  if (data.length < 24 || !Buffer.from(data).subarray(0, 8).equals(PNG)) throw new Failure('internal', 'Engine did not return a PNG', 'Run `screen-relay doctor`.');
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const width = view.getUint32(16), height = view.getUint32(20);
  if (args.file === '-') {
    process.stdout.write(data);
    return 0;
  }
  try { writeFileSync(String(args.file), data); }
  catch (error) { throw new Failure('invalid_input', `Cannot write ${args.file}: ${detail(error)}`, 'Check the path.'); }
  const path = resolve(String(args.file));
  emit(args, { screenshot: { path, bytes: data.length, width, height }, outcome: 'saved' },
    [receipt('Saved', path, args), row('Resolution', `${width}x${height}`), row('Size', size(data.length))].join('\n'), { identifier: path });
  return 0;
}

export async function cmdClick(args: Args): Promise<number> {
  const target = resolveTarget(args);
  const button = String(args.button) as 'left' | 'middle' | 'right';
  const events = await withClient(args, (client) => client.click(Number(args.x), Number(args.y), { button }), target);
  return finish(args, events.events, `Clicked ${button} at ${number(args.x)},${number(args.y)}`, target);
}

export async function cmdMove(args: Args): Promise<number> {
  const target = resolveTarget(args);
  const events = await withClient(args, (client) => client.move(Number(args.x), Number(args.y)), target);
  return finish(args, events.events, `Moved to ${number(args.x)},${number(args.y)}`, target);
}

export async function cmdScroll(args: Args): Promise<number> {
  const dx = Number(args.dx ?? 0), dy = Number(args.dy ?? 0);
  if (!dx && !dy) throw new Failure('invalid_input', 'Nothing to scroll', 'Pass --dy N (positive scrolls down) and/or --dx N.');
  const target = resolveTarget(args);
  const events = await withClient(args, (client) => client.scroll(Number(args.x), Number(args.y), { dx, dy }), target);
  return finish(args, events.events, `Scrolled dx=${dx} dy=${dy}`, target);
}

export async function cmdKey(args: Args): Promise<number> {
  const combos = (Array.isArray(args.combos) ? args.combos : [args.combos]).map(String);
  const target = resolveTarget(args);
  const events = await withClient(args, (client) => client.key(...combos), target);
  return finish(args, events.events, `Pressed ${combos.join(' ')}`, target);
}

export async function cmdType(args: Args): Promise<number> {
  const text = await textArgument(args, args.text);
  const target = resolveTarget(args);
  const events = await withClient(args, (client) => client.type(text), target);
  return finish(args, events.events, `Typed ${count(Array.from(text).length, 'character')}`, target);
}

export async function cmdInput(args: Args): Promise<number> {
  let events: unknown;
  try { events = JSON.parse(await textArgument(args, args.events)); }
  catch (error) {
    if (error instanceof Failure) throw error;
    throw new Failure('invalid_input', `Invalid JSON: ${detail(error)}`, 'Pass a JSON array of SDK input events.');
  }
  if (!Array.isArray(events) || !events.length || events.length > MAX_INPUT_BATCH) {
    throw new Failure('invalid_input', `Input must be a JSON array of 1 to ${MAX_INPUT_BATCH} events`,
      'Example: [{"type":"keyDown","key":4},{"type":"keyUp","key":4}]');
  }
  const target = resolveTarget(args);
  const result = await withClient(args, (client) => client.input(events as never), target);
  return finish(args, result.events, 'Sent input', target);
}

export async function cmdClipboard(args: Args): Promise<number> {
  const target = resolveTarget(args);
  if (args.action === 'get') {
    const text = await withClient(args, (client) => client.clipboard(), target);
    if (args.json) emit(args, { clipboard: { text, bytes: Buffer.byteLength(text) } }, '');
    else writeText(text);
    return 0;
  }
  const text = await textArgument(args, args.text);
  await withClient(args, (client) => client.setClipboard(text), target);
  const bytes = Buffer.byteLength(text);
  emit(args, { clipboard: { bytes }, outcome: 'set' },
    [receipt(bytes ? 'Set' : 'Cleared', 'clipboard', args), row('Target', target.url), row('Size', size(bytes))].join('\n'), {});
  return 0;
}

export async function cmdRemoteStatus(args: Args): Promise<number> {
  const target = resolveTarget(args);
  const client = open(target);
  let capabilities: Awaited<ReturnType<Client['capabilities']>>, metrics: Awaited<ReturnType<Client['status']>>;
  try {
    capabilities = await client.capabilities();
    metrics = await client.status();
  } catch (error) { throw clientFailure(error, target); }
  emit(args, { session: { url: target.url, state: 'ready', capabilities, metrics } },
    [row('URL', target.url), row('State', 'ready'), row('Backend', capabilities.backend), row('Resolution', `${capabilities.width}x${capabilities.height}`), row('Frames encoded', metrics.frames_encoded)].join('\n'));
  return 0;
}
