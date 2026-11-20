#!/usr/bin/env bash
# Usage: bash scripts/bench/run.sh ENGINE_BINARY LABEL. Streams a full-screen moving picture on a fresh Xvfb per case and reports
# delivered fps, Mbit/s, and engine CPU. Env: REPEAT=2 WARMUP=3 WINDOW=15 CASES="1280x720@60 1920x1080@60 1920x1080@120" VIEWERS=1 OUTDIR.
set -euo pipefail
ENGINE=$(readlink -f "$1"); LABEL=$2
SRC=$(cd "$(dirname "$0")" && pwd)
BENCH=${OUTDIR:-${TMPDIR:-/tmp}/screen-relay-bench}
mkdir -p "$BENCH"
VIEWER=${VIEWER:-$SRC/../../dist/viewer}
REPEAT=${REPEAT:-2}; WARMUP=${WARMUP:-3}; WINDOW=${WINDOW:-15}; VIEWERS=${VIEWERS:-1}
CASES=${CASES:-"1280x720@60 1920x1080@60 1920x1080@120"}
OUT=$BENCH/results-$LABEL.jsonl; LOGDIR=$BENCH/logs/$LABEL
mkdir -p "$LOGDIR"; : > "$OUT"
[ -x "$BENCH/motion" ] || gcc -O2 -o "$BENCH/motion" "$SRC/motion.c" -lX11 -lXext
HZ=$(getconf CLK_TCK)
PIDS=()
cleanup() { for p in "${PIDS[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null || true; done; sleep 0.3
  for p in "${PIDS[@]:-}"; do [ -n "$p" ] && kill -9 "$p" 2>/dev/null || true; done; PIDS=(); }
trap cleanup EXIT INT TERM
ticks() { [ -r /proc/$1/stat ] && awk '{sub(/^.*\) /,""); print $12+$13}' /proc/$1/stat || echo 0; }
sysbusy() { awk '/^cpu /{print $2+$3+$4+$7+$8, $2+$3+$4+$5+$6+$7+$8}' /proc/stat; }
free_display() { local n=120; while [ -e /tmp/.X11-unix/X$n ] || [ -e /tmp/.X$n-lock ]; do n=$((n+1)); done; echo $n; }
free_port() { local p=$1; while (exec 3<>/dev/tcp/127.0.0.1/$p) 2>/dev/null; do p=$((p+1)); done; echo $p; }

run_case() {
  local size=$1 fps=$2 rep=$3 w=${1%x*} h=${1#*x}
  local dpy; dpy=$(free_display); local port; port=$(free_port $((18000+dpy*10+rep)))
  local tag="${size}_${fps}_r$rep" mark; mark=$(mktemp)
  rm -f "$mark"
  Xvfb :$dpy -screen 0 ${w}x${h}x24 -nolisten tcp >"$LOGDIR/$tag.xvfb.log" 2>&1 & local xpid=$!; PIDS+=($xpid)
  for _ in $(seq 100); do [ -e /tmp/.X11-unix/X$dpy ] && break; sleep 0.05; done
  DISPLAY=:$dpy "$BENCH/motion" "$fps" >"$LOGDIR/$tag.motion.log" 2>&1 & local mpid=$!; PIDS+=($mpid)
  sleep 0.5
  DISPLAY=:$dpy "$ENGINE" --fps "$fps" --port "$port" --viewer-dir "$VIEWER" >"$LOGDIR/$tag.engine.log" 2>&1 & local epid=$!; PIDS+=($epid)
  for _ in $(seq 100); do curl -sf "http://127.0.0.1:$port/metrics" >/dev/null 2>&1 && break; sleep 0.1; done
  node "$SRC/client.mjs" "ws://127.0.0.1:$port/stream?view=1" "$WARMUP" "$WINDOW" "$mark" >"$LOGDIR/$tag.client.json" 2>"$LOGDIR/$tag.client.err" & local cpid=$!; PIDS+=($cpid)
  for extra in $(seq 2 "$VIEWERS"); do
    node "$SRC/client.mjs" "ws://127.0.0.1:$port/stream?view=1" "$WARMUP" "$WINDOW" >"$LOGDIR/$tag.client$extra.json" 2>&1 & PIDS+=($!)
  done
  for _ in $(seq 300); do [ -e "$mark" ] && break; kill -0 $cpid 2>/dev/null || break; sleep 0.02; done
  local e0 m0 x0 c0 s0 t0; e0=$(ticks $epid); m0=$(ticks $mpid); x0=$(ticks $xpid); c0=$(ticks $cpid); read -r s0 t0 < <(sysbusy)
  local w0; w0=$(date +%s.%N)
  sleep "$WINDOW"
  local e1 m1 x1 c1 s1 t1; e1=$(ticks $epid); m1=$(ticks $mpid); x1=$(ticks $xpid); c1=$(ticks $cpid); read -r s1 t1 < <(sysbusy)
  local w1; w1=$(date +%s.%N)
  local metrics; metrics=$(curl -sf "http://127.0.0.1:$port/metrics" || echo null)
  wait $cpid || true
  local client; client=$(cat "$LOGDIR/$tag.client.json"); [ -n "$client" ] || client=null
  local alive=true; kill -0 $epid 2>/dev/null || alive=false
  cleanup; rm -f "$mark"
  node -e '
    const [label,size,fps,rep,el,e,m,x,c,sb,st,hz,alive,src]=process.argv.slice(1); const ncpu=require("os").availableParallelism();
    const d=JSON.parse(process.argv[15]||"null"), met=JSON.parse(process.argv[16]||"null");
    const cores=t=>+(Number(t)/Number(hz)/Number(el)).toFixed(3);
    console.log(JSON.stringify({label,case:`${size}@${fps}`,size,target_fps:+fps,rep:+rep,engine_alive:alive==="true",
      ...(d??{client_error:true}),engine_cpu_cores:cores(e),source_cpu_cores:cores(m),xvfb_cpu_cores:cores(x),client_cpu_cores:cores(c),
      system_busy_cores:+(Number(sb)/Number(st)*ncpu).toFixed(3),source:src,metrics:met}));
  ' "$LABEL" "$size" "$fps" "$rep" "$(awk -v a="$w0" -v b="$w1" 'BEGIN{print b-a}')" $((e1-e0)) $((m1-m0)) $((x1-x0)) $((c1-c0)) $((s1-s0)) $((t1-t0)) "$HZ" "$alive" "motion.c (XShmPutImage scrolling noise texture, xor per-frame)" "$client" "$metrics" >>"$OUT"
  tail -1 "$OUT" | node -e 'const r=JSON.parse(require("fs").readFileSync(0));console.error(`  ${r.case} rep${r.rep}: ${r.fps} fps, ${r.mbps} Mbit/s, engine ${r.engine_cpu_cores} cores`)'
}

for c in $CASES; do
  size=${c%@*}; fps=${c#*@}
  for rep in $(seq "$REPEAT"); do run_case "$size" "$fps" "$rep"; done
done
node "$SRC/table.mjs" "$OUT"
