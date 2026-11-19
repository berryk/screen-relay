import { readFile } from "node:fs/promises";

function replaceOnce(source: string, before: string, after: string): string {
  if (source.split(before).length !== 2) {
    throw new Error("Viewer build changed; update the MCP App adapter before serving it.");
  }
  return source.replace(before, () => after);
}

export async function directViewer(origin: string): Promise<string> {
  const [html, bundle, bridge] = await Promise.all([
    readFile(new URL("../../dist/viewer/index.html", import.meta.url), "utf8"),
    readFile(new URL("../../dist/viewer/viewer.js", import.meta.url), "utf8"),
    readFile(new URL("./direct-ui.js", import.meta.url), "utf8"),
  ]);
  let script = replaceOnce(bundle,
    'new URLSearchParams(location.hash.slice(1)).get("token")', "stream.token ?? null");
  script = replaceOnce(script,
    'new URLSearchParams(location.hash.slice(1)).get("scope")', "stream.scope");
  script = replaceOnce(script,
    'history.replaceState(null, "", location.pathname + location.search);', "");
  script = replaceOnce(script, "function replaceAccess(value, next) {", `replaceScopedCredential = (token) => replaceAccess(token, stream.scope);
  function replaceAccess(value, next) {`);
  const socketOrigin = 'new URL(`${location.protocol}//${location.host}`)';
  script = script.includes(socketOrigin)
    ? replaceOnce(script, socketOrigin, "new URL(stream.url)")
    : replaceOnce(script,
      '`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/stream`',
      'new URL("/stream", stream.url).href.replace(/^http/, "ws")');
  const bootstrap = `
const relayOrigin = ${JSON.stringify(origin).replaceAll("<", "\\u003c")};
function startViewer(stream) {
  const fetch = (path, options) => window.fetch(new URL(path, stream.url), options);
  let replaceScopedCredential;
  ${script}
  return replaceScopedCredential;
}
${bridge}`;
  return replaceOnce(html, '<script src="viewer.js"></script>',
    `<style>html, body { height: 640px; } #relay-connection:not([hidden]), #relay-expiry:not([hidden]) { position: fixed; bottom: 0; left: 0; right: 0; z-index: 10000; padding: 12px; background: #222; color: #fff; } #relay-connection:not([hidden]) { top: 50%; bottom: auto; left: 10%; right: 10%; transform: translateY(-50%); text-align: center; pointer-events: none; }</style>
<div id="relay-connection" role="status" aria-live="polite" hidden></div>
<div id="relay-expiry" role="status" hidden></div>
<script>${bootstrap.replaceAll("</script", "<\\/script")}</script>`);
}
