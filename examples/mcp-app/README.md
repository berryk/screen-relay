# screen-relay MCP App

A prototype that shows a screen-relay desktop inside an MCP App. The resource embeds the built viewer directly and connects to the screen-relay server over WebSocket, so it does not need a nested iframe.

| File | Role |
| --- | --- |
| `server.ts` | Builds the server and serves it over stdio or streamable HTTP |
| `tools.ts` | Registers `open_desktop`, `desktop_screenshot`, `desktop_action`, and `browser_action` |
| `viewer.ts` | Registers the `ui://` resource and its CSP metadata |
| `direct-viewer.ts` | Adapts the built viewer bundle at request time |
| `direct-ui.js` | Bridges MCP messages to the embedded viewer |
| `config.ts` | Reads and validates the screen-relay origin and token |
| `sandbox.ts` | Runs automation commands in the sandbox |

## Setup

Build screen-relay first (the prototype reads `dist/viewer/` and imports `dist/sdk/index.js`). Run the desktop in a Linux VM or Vercel Sandbox, not on your host display.

```sh
npm run build
cd examples/mcp-app && npm install
```

## Run

Set the screen-relay origin. It must match the URL passed to `open_desktop`. This example requires a token-enabled relay, even on loopback, so the server can issue scoped viewer grants. For a local relay, start a token-enabled session with `screen-relay up -d --public https://localhost --bind 127.0.0.1`, then use its local `http://127.0.0.1:8080` origin and token on the same machine.

```sh
SCREEN_RELAY_ORIGIN=https://your-sandbox.vercel.run SCREEN_RELAY_TOKEN="$SCREEN_RELAY_TOKEN" npm run start:http
```

The MCP endpoint is `http://localhost:3001/mcp`. Without `--http`, the server uses stdio.

In HTTP mode, each MCP session keeps its own state. `desktop_screenshot` captures the desktop that the same client opened with `open_desktop`, and returns `Call open_desktop first` to a client that hasn't opened one.

An idle session closes after 30 minutes, and a later request that carries its id returns `404 Session not found`. Set `MCP_SESSION_IDLE_MS` to change the timeout in milliseconds. A host that reconnects without closing its previous session does not keep that session alive.

The HTTP mode listens on loopback only, rejects any request whose `Host` is not this server, and rejects an `Origin` that is not served from this machine. That stops DNS rebinding from reaching the desktop tools while letting a local host such as `http://localhost:8081` connect.

For the ext-apps basic host:

```sh
cd /path/to/ext-apps/examples/basic-host
npm install && npm run start
```

Open `http://localhost:8081`, choose `open_desktop`, and call it with the viewer URL. Use `desktop_screenshot` afterwards to capture the same session.

The host serves its page from a loopback HTTP origin, so allow `http://localhost:8081` when you start the relay. See [Allow the app origin](#allow-the-app-origin).

Set `SCREEN_RELAY_TOKEN` in the MCP server environment. The server uses it to request a one-hour watch grant and sends only the grant to the viewer in `_meta`, outside model-visible content. To allow input from the viewer, set `SCREEN_RELAY_VIEWER_SCOPE=control` before starting the MCP server. Neither grant enables clipboard access. Reopening the same desktop reuses the current grant until it expires. After expiry, run `open_desktop` again to renew access. The screenshot and automation tools keep their existing server-side permissions.

## Claude rendering

The tested Claude host blocked a nested iframe, despite the resource declaring the screen-relay origin in `frameDomains`. The resource therefore declares the HTTPS and WSS origins in `connectDomains` and renders the viewer inline.

The adapter changes the built viewer in memory: it takes the scoped grant from the tool result, waits for MCP initialization, and targets the screen-relay origin explicitly. It retains the viewer's trusted-page check. Neither `viewer/` nor `src/` is changed. If the viewer bundle changes enough that the adapter cannot identify its startup code, resource loading fails with an error.

## Desktop and browser tools

Two tools drive the same sandbox the stream comes from. `desktop_action` runs [agent-desktop](https://github.com/vercel-labs/agent-desktop), and `browser_action` runs [agent-browser](https://agent-browser.dev). Each takes an `args` array and returns the command's stdout and stderr.

Set `SCREEN_RELAY_SANDBOX` to the sandbox name, and `SCREEN_RELAY_SANDBOX_SCOPE` when it belongs to a team:

```sh
SCREEN_RELAY_SANDBOX=relay-hi SCREEN_RELAY_SANDBOX_SCOPE=team_xxx npm run start:http
```

Install both tools in the sandbox, then copy the wrapper that loads the desktop environment:

```sh
npm install -g agent-desktop
~/relay/node_modules/.bin/agent-browser install --with-deps
```

Copy `relay-env` to `/vercel/.local/bin/relay-env` and make it executable. It reads `display`, `xauthority`, and the session D-Bus address from screen-relay's `session.json` before running a command, which is what lets these tools reach the running desktop.

It reads the session named by `SCREEN_RELAY_SESSION_NAME`, which defaults to `default`. Set it to the name you gave `screen-relay up --name` to reach a named desktop. The state directory comes from `XDG_STATE_HOME`, or from `$HOME/.local/state` when that is unset. Set `SCREEN_RELAY_STATE` to the full path of a `session.json` to read a file outside that layout. An invalid session name or an unreadable file exits with status 2 and a message on stderr naming the session or the path.

```json
{ "name": "desktop_action", "arguments": { "args": ["list-windows"] } }
{ "name": "browser_action", "arguments": { "args": ["open", "https://example.com"] } }
```

agent-desktop reads the accessibility tree, so it only sees apps that publish one. A GTK app started on the desktop bus with `GTK_MODULES=gail:atk-bridge` appears in `list-windows`; SDL games such as Doom never do. agent-browser controls its own headless Chrome, so it is unaffected by what the desktop shows.

## Allow the app origin

The engine allows the configured relay origin by default. When your MCP host serves the viewer from another origin, add that exact origin with `--allow-origin`. Use an HTTPS origin for a page on a remote host, or a loopback HTTP origin such as `http://localhost:8081` for a page served on your machine. For the sandbox verification below, the default test origin is `https://relay-test.claudemcpcontent.com`. Set `SCREEN_RELAY_EMBED_ORIGIN` if you use a different one, and allow that same origin when you start the relay.

```sh
screen-relay up -d --bind 0.0.0.0 --public https://your-sandbox.vercel.run --allow-origin https://relay-test.claudemcpcontent.com
```

The allowlist applies to the WebSocket upgrade. It does not enable cross-origin browser HTTP requests. The embedded viewer streams over WebSocket, and the MCP server handles screenshots separately.

For the basic host, allow its loopback origin instead:

```sh
screen-relay up -d --bind 0.0.0.0 --public https://your-sandbox.vercel.run --allow-origin http://localhost:8081
```

## Verification

From this directory, with the server environment set:

```sh
node check.mjs
```

Alternatively, `SCREEN_RELAY_TOKEN_FILE` can point to the sandbox session's token file for the check. The check reads the resource through MCP, checks that credentials stay out of model-visible results, exercises both UI initialization orders, captures a screenshot, and tests a WebSocket upgrade with the scoped credential and the configured embed origin. It does not decode video or drive a browser.

Run the check with `SCREEN_RELAY_VIEWER_SCOPE=watch` and `SCREEN_RELAY_VIEWER_SCOPE=control` to cover both modes. Testing inside Claude or Codex still requires a real host session.
