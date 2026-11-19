const relayOrigin = new URL(process.env.SCREEN_RELAY_ORIGIN ?? "http://localhost:18080").origin;
const envToken = process.env.SCREEN_RELAY_TOKEN;
const scope = process.env.SCREEN_RELAY_VIEWER_SCOPE ?? "watch";
if (scope !== "watch" && scope !== "control") throw new Error("SCREEN_RELAY_VIEWER_SCOPE must be watch or control.");
export const VIEWER_SCOPE = scope;

/** Origin of the screen-relay server this app may embed and talk to. */
export const ORIGIN = relayOrigin;

/** Name of the sandbox that runs the desktop, for the automation tools. */
export const SANDBOX = process.env.SCREEN_RELAY_SANDBOX;

/** Scope that owns the sandbox, when it belongs to a team. */
export const SANDBOX_SCOPE = process.env.SCREEN_RELAY_SANDBOX_SCOPE;

/** Validates a stream URL and returns it, rejecting anything but the configured origin. */
export function originOf(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Stream URL is not a valid URL");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("Stream URL must be an HTTP(S) origin without credentials or query");
  }
  if (url.origin !== ORIGIN) {
    throw new Error(`Stream URL must use the screen-relay origin ${ORIGIN}`);
  }
  return url;
}

/** Reads the owner token from the environment only (never from model/tool inputs). */
export function ownerToken(): string {
  const token = envToken;
  if (!token) throw new Error("This app requires a token-enabled relay. Set SCREEN_RELAY_TOKEN in the MCP server environment.");
  if (!/^[0-9a-f]{64}$/.test(token)) throw new Error("SCREEN_RELAY_TOKEN must be 64 lowercase hexadecimal characters");
  return token;
}
