# UDP bridge (experimental)

Carries the stream over a WebRTC data channel (UDP, DTLS-encrypted) instead of
the WebSocket. The engine is unchanged: the bridge relays the data channel to
the engine's WebSocket on loopback.

- The browser POSTs its WebRTC offer to `/rtc/offer` on the page's own origin,
  so whatever protects the page (Cloudflare Access) decides who can negotiate.
- The answer carries one-time DTLS and ICE credentials. The UDP port ignores
  peers that did not complete that exchange.
- Media then flows browser ⇄ server directly over one UDP port.
- The data channel is reliable and ordered, so this skips the proxy hop but
  does not yet avoid stalls when packets are lost.

Run it next to an engine:

    cd bridge && npm install
    BRIDGE_PUBLIC_IP=<server address> BRIDGE_UDP_PORT=60990 BRIDGE_HTTP_PORT=8091 \
      ENGINE_URL=ws://127.0.0.1:8090 node udp-bridge.mjs

Route `/rtc/*` on the viewer's origin to `127.0.0.1:8091`, open the UDP port,
and load the viewer with `?udp=1` (remembered; `?udp=0` turns it off). The
viewer falls back to the WebSocket if the bridge or UDP is unavailable. The
stats panel shows which transport is in use.
