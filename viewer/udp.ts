/**
 * A WebSocket-shaped transport that carries the stream over a WebRTC data
 * channel (UDP, encrypted with DTLS) when the server runs the UDP bridge.
 *
 * The offer and answer travel over HTTPS to this page's own origin, so whatever
 * protects the page also protects who can open the UDP path. If the bridge is
 * missing or UDP is blocked, it falls back to the WebSocket and behaves exactly
 * like one. Bridge messages carry a type byte: 0 = part, 1 = last part,
 * 2 = the engine closed the stream ({code, reason} as JSON).
 */
type Handler = ((event: any) => void) | null;
const SETUP_TIMEOUT_MS = 5000, GATHER_WAIT_MS = 700;

export class UdpSocket {
  readyState = 0;
  binaryType = 'arraybuffer';
  onopen: Handler = null; onmessage: Handler = null; onerror: Handler = null; onclose: Handler = null;
  /** What carries the stream now: 'udp', or 'websocket' after a fallback. */
  transport: 'udp' | 'websocket' = 'udp';
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private ws: WebSocket | null = null;
  private parts: Uint8Array[] = [];
  private opened = false; private done = false; private timer: any;

  constructor(private url: URL, private protocols: string[], private path: string) {
    this.start().catch(() => this.fallback());
  }
  private async start() {
    const pc = this.pc = new RTCPeerConnection({ iceServers: [] });
    const dc = this.dc = pc.createDataChannel('stream', { ordered: true });
    dc.binaryType = 'arraybuffer';
    this.timer = setTimeout(() => this.fallback(), SETUP_TIMEOUT_MS);
    dc.onopen = () => {
      if (this.done || this.ws) return;
      clearTimeout(this.timer);
      this.opened = true; this.readyState = 1;
      this.onopen?.({});
    };
    dc.onmessage = (event) => this.receive(new Uint8Array(event.data as ArrayBuffer));
    dc.onclose = () => (this.opened ? this.finish(1006, '') : this.fallback());
    pc.onconnectionstatechange = () => {
      if (pc.connectionState !== 'failed' && pc.connectionState !== 'closed') return;
      this.opened ? this.finish(1006, '') : this.fallback();
    };
    await pc.setLocalDescription(await pc.createOffer());
    // The server has a public address, so it finds this browser from its first packet; waiting briefly just lets the offer carry candidates when there are any.
    if (pc.iceGatheringState !== 'complete') {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, GATHER_WAIT_MS);
        pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === 'complete') { clearTimeout(timer); resolve(); } };
      });
    }
    const response = await fetch('/rtc/offer', {
      method: 'POST', cache: 'no-store', redirect: 'error', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sdp: pc.localDescription!.sdp, path: this.path, protocols: this.protocols }),
    });
    if (!response.ok) throw new Error('no bridge');
    const answer = await response.json();
    if (this.done || this.ws) return;
    await pc.setRemoteDescription({ type: 'answer', sdp: answer.sdp });
  }
  private receive(message: Uint8Array) {
    if (this.done || !message.length) return;
    const type = message[0];
    if (type === 2) {
      let code = 1006, reason = '';
      try { ({ code, reason } = JSON.parse(new TextDecoder().decode(message.subarray(1)))); } catch {}
      this.finish(code, reason);
      return;
    }
    if (type > 1) return;
    this.parts.push(message.subarray(1));
    if (type === 0) return;
    let whole: Uint8Array;
    if (this.parts.length === 1) whole = this.parts[0].slice();
    else {
      whole = new Uint8Array(this.parts.reduce((total, part) => total + part.length, 0));
      let offset = 0;
      for (const part of this.parts) { whole.set(part, offset); offset += part.length; }
    }
    this.parts = [];
    this.onmessage?.({ data: whole.buffer });
  }
  private dropRtc() {
    clearTimeout(this.timer);
    const dc = this.dc, pc = this.pc;
    this.dc = null; this.pc = null;
    if (dc) { dc.onopen = dc.onmessage = dc.onclose = null; try { dc.close(); } catch {} }
    if (pc) { pc.onconnectionstatechange = null; try { pc.close(); } catch {} }
  }
  private fallback() {
    if (this.done || this.opened || this.ws) return;
    this.dropRtc();
    this.transport = 'websocket';
    const ws = this.ws = new WebSocket(this.url, this.protocols);
    ws.binaryType = 'arraybuffer';
    ws.onopen = (event) => { this.readyState = 1; this.onopen?.(event); };
    ws.onmessage = (event) => this.onmessage?.(event);
    ws.onerror = (event) => this.onerror?.(event);
    ws.onclose = (event) => { this.done = true; this.readyState = 3; this.onclose?.(event); };
  }
  private finish(code: number, reason: string) {
    if (this.done) return;
    this.done = true; this.readyState = 3;
    this.dropRtc();
    this.onclose?.({ code, reason });
  }
  send(data: ArrayBuffer | Uint8Array) {
    if (this.ws) { this.ws.send(data); return; }
    if (!this.dc || this.dc.readyState !== 'open') throw new Error('transport closed');
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    const framed = new Uint8Array(bytes.length + 1);
    framed[0] = 1; framed.set(bytes, 1);
    this.dc.send(framed);
  }
  close() {
    if (this.ws) { this.readyState = 2; this.ws.close(); return; }
    if (this.done) return;
    this.readyState = 2;
    queueMicrotask(() => this.finish(1000, ''));
  }
}
