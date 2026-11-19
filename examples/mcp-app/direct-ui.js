let initialized = false;
let started = false;
let activeToken;
let activeScope;
let replaceScopedCredential;
let expiryTimer;
let pendingStream;

function post(data) {
  window.parent.postMessage({ jsonrpc: "2.0", ...data }, "*");
}

function size() {
  post({ method: "ui/notifications/size-changed", params: { height: 640 } });
}

function show(stream) {
  if (!stream) return;
  try {
    const url = new URL(stream.url);
    if (url.origin !== relayOrigin || url.username || url.password || url.search || url.hash) {
      throw new Error("Unexpected screen-relay origin.");
    }
    if (!/^[0-9a-f]{64}$/.test(stream.token ?? "")) {
      throw new Error("Invalid screen-relay token.");
    }
    if (stream.scope !== "watch" && stream.scope !== "control") throw new Error("Invalid viewer scope.");
    if (!Number.isSafeInteger(stream.expiresAt)) throw new Error("Invalid viewer grant expiry.");
    if (!window.isSecureContext) throw new Error("The MCP App needs a secure browser context.");
    const notice = document.querySelector("#relay-expiry");
    if (stream.expiresAt <= Date.now()) {
      if (!started || activeToken === stream.token) {
        notice.textContent = "Viewer grant expired. Call open_desktop to renew it.";
        notice.hidden = false;
      }
      return;
    }
    if (started) {
      if (activeScope !== stream.scope) throw new Error("Reopen the viewer to change its permissions.");
      if (activeToken === stream.token) return;
      replaceScopedCredential(stream.token);
    } else {
      replaceScopedCredential = startViewer({ url: url.origin, token: stream.token, scope: stream.scope });
      started = true;
      activeScope = stream.scope;
      size();
    }
    activeToken = stream.token;
    clearTimeout(expiryTimer);
    notice.hidden = true;
    expiryTimer = setTimeout(() => {
      notice.textContent = "Viewer grant expired. Call open_desktop to renew it.";
      notice.hidden = false;
    }, stream.expiresAt - Date.now());
  } catch (error) {
    document.querySelector("#status").textContent = error.message;
  }
}

window.addEventListener("message", (event) => {
  if (event.source !== window.parent || event.data?.jsonrpc !== "2.0") return;
  const data = event.data;
  if (data.id === 1) {
    if (data.error) {
      document.querySelector("#status").textContent = "MCP App initialization failed.";
      return;
    }
    if (!data.result || initialized) return;
    initialized = true;
    post({ method: "ui/notifications/initialized", params: {} });
    size();
    show(pendingStream);
  } else if (data.method === "ui/notifications/tool-result") {
    pendingStream = data.params?._meta?.["relay/viewer"];
    if (initialized) show(pendingStream);
  }
});

window.addEventListener("resize", size);
const connectionStatus = document.querySelector("#status");
const connectionNotice = document.querySelector("#relay-connection");
function showConnectionStatus() {
  const message = connectionStatus.textContent.trim();
  connectionNotice.hidden = !message || message.startsWith("Live");
  if (connectionNotice.hidden) return;
  connectionNotice.textContent = /^(Connecting… · (retrying|reconnect)|Connection error)/.test(message)
    ? "Could not connect to the desktop. Check that the relay is running and allows this app’s origin."
    : message;
}
connectionStatus.textContent = "Waiting for desktop session…";
new MutationObserver(showConnectionStatus).observe(connectionStatus, { childList: true, characterData: true, subtree: true });
showConnectionStatus();
post({
  id: 1,
  method: "ui/initialize",
  params: {
    protocolVersion: "2026-01-26",
    appInfo: { name: "relay-mcp-app", version: "0.1.0" },
    appCapabilities: { availableDisplayModes: ["inline", "fullscreen"] },
  },
});
