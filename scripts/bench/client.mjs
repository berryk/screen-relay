/** Minimal nsl1 viewer: ACKs every video frame and reports throughput over a measured window. */
const [url, warmupS, windowS, markFile] = process.argv.slice(2);
const warmupMs = Number(warmupS) * 1000, windowMs = Number(windowS) * 1000;
const ws = new WebSocket(url, 'nsl1');
ws.binaryType = 'arraybuffer';
let t0 = 0, frames = 0, bytes = 0, keyframes = 0, last = 0, total = 0, width = 0, height = 0;
const intervals = [];
let measuring = false;
const ack = new Uint8Array(20);
ack.set([0x4e, 0x53, 0x4c, 0x31, 1, 2]);
const ackView = new DataView(ack.buffer);
ws.onopen = () => {
  t0 = performance.now();
  setTimeout(async () => {
    measuring = true;
    if (markFile) (await import('node:fs')).writeFileSync(markFile, 'start');
    const start = performance.now();
    setTimeout(() => finish(performance.now() - start), windowMs);
  }, warmupMs);
};
ws.onmessage = (ev) => {
  const buf = ev.data, v = new DataView(buf);
  if (v.getUint32(0) !== 0x4e534c31 || v.getUint8(4) !== 1) { console.error('bad header'); process.exit(1); }
  if (v.getUint8(5) !== 1) return;
  ackView.setUint32(8, v.getUint32(8));
  ackView.setUint32(12, v.getUint32(12));
  ws.send(ack);
  total++;
  const now = performance.now();
  if (measuring) {
    if (last) intervals.push(now - last);
    frames++;
    bytes += buf.byteLength;
    if (v.getUint16(6) & 1) keyframes++;
    width = v.getUint16(20); height = v.getUint16(22);
  }
  last = now;
};
ws.onerror = (e) => { console.error('ws error', e.message ?? e); process.exit(1); };
ws.onclose = (e) => { if (!done) { console.error('ws closed', e.code, e.reason); process.exit(1); } };
let done = false;
function pct(sorted, p) { return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : null; }
function finish(elapsedMs) {
  done = true;
  const s = intervals.slice().sort((a, b) => a - b);
  const sec = elapsedMs / 1000;
  console.log(JSON.stringify({
    window_s: +sec.toFixed(3), frames, fps: +(frames / sec).toFixed(2), mbps: +(bytes * 8 / sec / 1e6).toFixed(3),
    avg_frame_kb: frames ? +(bytes / frames / 1024).toFixed(1) : 0, keyframes, frames_total: total,
    interval_p50_ms: +(pct(s, 0.5) ?? 0).toFixed(2), interval_p95_ms: +(pct(s, 0.95) ?? 0).toFixed(2),
    interval_max_ms: +(s.at(-1) ?? 0).toFixed(2), width, height,
  }));
  setTimeout(() => { ws.close(); setTimeout(() => process.exit(0), 200); }, 2500);
}
