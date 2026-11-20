/** Prints a readable table from a results JSONL file. */
import { readFileSync } from 'node:fs';
const rows = readFileSync(process.argv[2], 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const cols = [
  ['case', (r) => r.case], ['rep', (r) => r.rep], ['fps', (r) => r.fps], ['Mbit/s', (r) => r.mbps],
  ['KB/frame', (r) => r.avg_frame_kb], ['ivl p50 ms', (r) => r.interval_p50_ms], ['ivl p95 ms', (r) => r.interval_p95_ms],
  ['engine cores', (r) => r.engine_cpu_cores], ['source cores', (r) => r.source_cpu_cores], ['Xvfb cores', (r) => r.xvfb_cpu_cores],
  ['client cores', (r) => r.client_cpu_cores], ['system busy', (r) => r.system_busy_cores],
  ['encoded', (r) => r.metrics?.frames_encoded], ['acked', (r) => r.metrics?.frames_acked],
  ['target Mbps', (r) => r.metrics?.target_bitrate_bps != null ? (r.metrics.target_bitrate_bps / 1e6).toFixed(1) : ''],
];
const data = [cols.map((c) => c[0]), ...rows.map((r) => cols.map((c) => String(c[1](r) ?? '')))];
const widths = cols.map((_, i) => Math.max(...data.map((d) => d[i].length)));
const line = (d) => '| ' + d.map((v, i) => v.padEnd(widths[i])).join(' | ') + ' |';
console.log(line(data[0]));
console.log('|' + widths.map((w) => '-'.repeat(w + 2)).join('|') + '|');
for (const d of data.slice(1)) console.log(line(d));
