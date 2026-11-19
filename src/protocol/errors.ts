export type ErrorClass = 'usage' | 'missing_input' | 'not_found' | 'conflict' | 'network' | 'platform' | 'permission' | 'config' | 'bug' | 'canceled';
export interface NextCommand { command: string; argv: string[] }
export interface ErrorOptions {
  hint?: string;
  data?: Record<string, unknown>;
  next?: NextCommand[];
  status?: 'error' | 'action_required';
  label?: string;
}

export const ERROR_REASONS = {
  invalid_input: { class: 'usage', code: 'INVALID_ARGUMENT', exitCode: 2 },
  invalid_option: { class: 'usage', code: 'INVALID_ARGUMENT', exitCode: 2 },
  unknown_command: { class: 'usage', code: 'INVALID_ARGUMENT', exitCode: 2 },
  missing_input: { class: 'missing_input', code: 'INVALID_ARGUMENT', exitCode: 2 },
  missing_command: { class: 'missing_input', code: 'INVALID_ARGUMENT', exitCode: 2 },
  not_found: { class: 'not_found', code: 'NOT_FOUND', exitCode: 1 },
  not_running: { class: 'not_found', code: 'NOT_FOUND', exitCode: 1 },
  already_running: { class: 'conflict', code: 'BUSY', exitCode: 1 },
  port_in_use: { class: 'conflict', code: 'BUSY', exitCode: 1 },
  busy: { class: 'conflict', code: 'BUSY', exitCode: 1 },
  control_taken: { class: 'conflict', code: 'BUSY', exitCode: 1 },
  unreachable: { class: 'network', code: 'NETWORK_ERROR', exitCode: 1 },
  timeout: { class: 'network', code: 'TIMEOUT', exitCode: 1 },
  disconnected: { class: 'network', code: 'DISCONNECTED', exitCode: 1 },
  unauthorized: { class: 'permission', code: 'UNAUTHORIZED', exitCode: 1 },
  forbidden: { class: 'permission', code: 'UNAUTHORIZED', exitCode: 1 },
  unsupported_input: { class: 'platform', code: 'UNSUPPORTED', exitCode: 1 },
  unsupported_platform: { class: 'platform', code: 'UNSUPPORTED', exitCode: 1 },
  clipboard_unavailable: { class: 'platform', code: 'UNSUPPORTED', exitCode: 1 },
  missing_dependency: { class: 'platform', code: 'UNSUPPORTED', exitCode: 1 },
  component_failed: { class: 'platform', code: 'HTTP_ERROR', exitCode: 1 },
  spawn_failed: { class: 'platform', code: 'IO_ERROR', exitCode: 1 },
  io_error: { class: 'platform', code: 'IO_ERROR', exitCode: 1 },
  protocol_error: { class: 'platform', code: 'PROTOCOL_ERROR', exitCode: 1 },
  invalid_config: { class: 'config', code: 'CONFIG_ERROR', exitCode: 1 },
  internal: { class: 'bug', code: 'INTERNAL', exitCode: 1 },
  canceled: { class: 'canceled', code: 'CANCELED', exitCode: 130 },
} as const satisfies Record<string, { class: ErrorClass; code: string; exitCode: number }>;

export type ErrorReason = keyof typeof ERROR_REASONS;

const LEGACY_REASONS: Record<string, ErrorReason> = {
  INVALID_ARGUMENT: 'invalid_input', NOT_FOUND: 'not_found', BUSY: 'busy', NETWORK_ERROR: 'unreachable',
  TIMEOUT: 'timeout', DISCONNECTED: 'disconnected', UNAUTHORIZED: 'unauthorized', UNSUPPORTED: 'unsupported_input',
  HTTP_ERROR: 'component_failed', IO_ERROR: 'io_error', PROTOCOL_ERROR: 'protocol_error', CONFIG_ERROR: 'invalid_config',
  INTERNAL: 'internal', CANCELED: 'canceled',
};

export class RelayError extends Error {
  readonly code: string;
  readonly reason: ErrorReason;
  readonly class: ErrorClass;
  readonly exitCode: number;
  readonly hint?: string;
  readonly data?: Record<string, unknown>;
  readonly next?: NextCommand[];
  readonly status: 'error' | 'action_required';
  readonly label?: string;

  constructor(reason: string, message: string, options: string | ErrorOptions = {}) {
    super(message);
    this.name = 'RelayError';
    this.reason = Object.hasOwn(ERROR_REASONS, reason) ? reason as ErrorReason
      : Object.hasOwn(LEGACY_REASONS, reason) ? LEGACY_REASONS[reason] : 'internal';
    const definition = ERROR_REASONS[this.reason];
    this.code = definition.code;
    this.class = definition.class;
    this.exitCode = definition.exitCode;
    const details = typeof options === 'string' ? { hint: options } : options;
    this.hint = details.hint;
    this.data = details.data;
    this.next = details.next;
    this.label = details.label;
    this.status = details.status ?? 'error';
  }
}

function errorCodes(error: unknown, seen = new Set<unknown>()): string[] {
  if (!error || typeof error !== 'object' || seen.has(error)) return [];
  seen.add(error);
  const record = error as { code?: unknown; cause?: unknown; errors?: unknown[] };
  const codes: string[] = [];
  if (typeof record.code === 'string') codes.push(record.code);
  if (Array.isArray(record.errors)) for (const inner of record.errors) codes.push(...errorCodes(inner, seen));
  if (record.cause !== undefined) codes.push(...errorCodes(record.cause, seen));
  return codes;
}

function errorText(error: unknown, seen = new Set<unknown>()): string {
  if (!error || typeof error !== 'object' || seen.has(error)) return '';
  seen.add(error);
  const record = error as { message?: unknown; cause?: unknown; errors?: unknown[] };
  const parts: string[] = [];
  if (typeof record.message === 'string') parts.push(record.message);
  if (Array.isArray(record.errors)) for (const inner of record.errors) parts.push(errorText(inner, seen));
  if (record.cause !== undefined) parts.push(errorText(record.cause, seen));
  return parts.join(' ');
}

const CAUSES: Record<string, string> = {
  ECONNREFUSED: 'Connection refused.',
  ENOTFOUND: 'The host name did not resolve.',
  EAI_AGAIN: 'The host name did not resolve.',
  ETIMEDOUT: 'The request timed out.',
  ESOCKETTIMEDOUT: 'The request timed out.',
  UND_ERR_CONNECT_TIMEOUT: 'The request timed out.',
  UND_ERR_HEADERS_TIMEOUT: 'The request timed out.',
  UND_ERR_BODY_TIMEOUT: 'The request timed out.',
  ABORT_ERR: 'The request timed out.',
  ECONNRESET: 'The connection was reset.',
  EPIPE: 'The connection was closed.',
  EHOSTUNREACH: 'The host was unreachable.',
  ENETUNREACH: 'The network was unreachable.',
};

const TLS_CODES = /TLS|SSL|CERT/;
const TIMEOUT_CODES = new Set(['ETIMEDOUT', 'ESOCKETTIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'ABORT_ERR', 'TimeoutError']);

/** Maps a Node network failure to the shared timeout or unreachable reason with a human cause. */
export function networkError(error: unknown): RelayError {
  const codes = errorCodes(error);
  const text = errorText(error);
  if (codes.some((code) => TLS_CODES.test(code)) || /certificate/i.test(text)) return new RelayError('unreachable', 'The TLS certificate was rejected.');
  const timedOut = codes.some((code) => TIMEOUT_CODES.has(code)) || (typeof error === 'object' && error !== null && (error as { name?: string }).name === 'AbortError') || /timed? ?out/i.test(text);
  const blocked = /bad port/i.test(text);
  const message = blocked ? 'Connection refused.' : codes.map((code) => CAUSES[code]).find(Boolean) ?? (timedOut ? 'The request timed out.' : 'The connection failed.');
  return new RelayError(timedOut ? 'timeout' : 'unreachable', message);
}

export function responseError(status: number, detail: unknown): RelayError {
  const body = detail && typeof detail === 'object' ? detail as Record<string, unknown> : {};
  const reason: ErrorReason = status === 401 ? 'unauthorized' : status === 403 ? 'forbidden'
    : status === 404 ? 'not_found' : status === 409 || status === 429 || (status === 503 && body.error === 'busy') || body.error === 'busy' ? 'busy'
    : body.error === 'clipboard_busy' ? 'busy'
    : body.error === 'clipboard_too_large' ? 'component_failed'
    : body.error === 'clipboard_unavailable' ? 'clipboard_unavailable'
    : status === 422 || body.error === 'unsupported_input' ? 'unsupported_input'
    : status === 400 || status === 413 || body.error === 'invalid_input' ? 'invalid_input' : 'component_failed';
  const messages: Partial<Record<ErrorReason, string>> = {
    unauthorized: 'The engine rejected the token.', forbidden: 'The engine rejected the connection origin.',
    not_found: 'The engine endpoint was not found.', busy: 'Another controller holds control of the desktop.',
    unsupported_input: 'The engine does not support this input.', invalid_input: 'The engine rejected the input.',
    clipboard_unavailable: 'The engine could not reach the desktop clipboard.',
  };
  const index = Number.isInteger(body.index) && Number(body.index) >= 0 ? Number(body.index) : undefined;
  const applied = Number.isInteger(body.applied) && Number(body.applied) >= 0 ? Number(body.applied) : undefined;
  const details: Record<string, string> = {
    screenshot_unavailable: 'The engine could not take a screenshot. Read the engine log with screen-relay logs engine.',
    invalid_text: 'The clipboard text must be UTF-8 without NUL characters.',
    too_large: 'The text is larger than the engine accepts.',
    clipboard_busy: 'The desktop clipboard request queue is full.',
    clipboard_too_large: 'The desktop clipboard exceeds the 256 KiB read limit.',
  };
  const message = (typeof body.error === 'string' && Object.hasOwn(details, body.error) ? details[body.error] : undefined)
    ?? messages[reason] ?? 'The engine could not complete the request.';
  return new RelayError(reason, message, {
    ...(body.error === 'clipboard_busy' ? { hint: 'Wait briefly, then retry.' } : {}),
    data: { httpStatus: status, ...(index === undefined ? {} : { index }), ...(applied === undefined ? {} : { applied }) },
  });
}
