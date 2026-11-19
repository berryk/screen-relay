#!/bin/sh
set -eu
relay=${SCREEN_RELAY:-screen-relay}
name=smoke-$$
port=${SMOKE_PORT:-18090}
backend=${SCREEN_RELAY_BACKEND:-}
wayland_display=${SCREEN_RELAY_DISPLAY:-}
work=$(mktemp -d)
xterm_pid=''

running() { [ -r "/proc/$1/stat" ] && [ "$(cut -d' ' -f3 "/proc/$1/stat")" != Z ]; }
step() { printf '== %s\n' "$*"; }
field() {
  file=$1
  shift
  node -e 'const data=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); console.log(process.argv.slice(2).map(key=>key.split(".").reduce((value,part)=>value[part],data)).join(" "))' "$file" "$@"
}
fail() {
  printf 'FAIL: %s\n' "$*" >&2
  "$relay" logs --name "$name" >&2 2>/dev/null || true
  "$relay" down --name "$name" >/dev/null 2>&1 || true
  [ -z "$xterm_pid" ] || kill "$xterm_pid" 2>/dev/null || true
  exit 1
}

step 'engine backends'
set -- install --json
[ -z "$backend" ] || set -- "$@" --backend "$backend"
"$relay" "$@" > "$work/install.json" 2> "$work/stderr" || fail "the machine is not set up; run screen-relay install --yes: $(cat "$work/stderr")"
[ "$(field "$work/install.json" outcome)" = unchanged ] || fail 'install changed a machine that was already set up'

step 'offline help and usage errors'
"$relay" --help > "$work/help" 2> "$work/stderr" || fail 'root help'
[ -s "$work/help" ] && [ ! -s "$work/stderr" ] || fail 'help streams'
"$relay" help status > "$work/help-command" 2> "$work/stderr" || fail 'help status'
"$relay" status --help > "$work/help-option" 2> "$work/stderr" || fail 'status --help'
cmp -s "$work/help-command" "$work/help-option" || fail 'help forms differ'
"$relay" status --help --json > "$work/help.json" 2> "$work/stderr" || fail 'JSON help'
node - "$work/help.json" <<'NODE' || fail 'JSON help metadata'
const assert = require('node:assert/strict');
const help = JSON.parse(require('node:fs').readFileSync(process.argv[2], 'utf8'));
for (const key of ['path', 'summary', 'arguments', 'options', 'examples']) assert.ok(Object.hasOwn(help, key), key);
NODE
[ ! -s "$work/stderr" ] || fail 'JSON help wrote stderr'
code=0
"$relay" status --unknown-smoke-option --json > "$work/stdout" 2> "$work/error.json" || code=$?
[ "$code" = 2 ] && [ ! -s "$work/stdout" ] || fail 'unknown option exit or stdout'
node - "$work/error.json" <<'NODE' || fail 'JSON error contract'
const assert = require('node:assert/strict');
const text = require('node:fs').readFileSync(process.argv[2], 'utf8');
assert.equal(text.trim().split('\n').length, 1);
const error = JSON.parse(text);
assert.ok(['error', 'action_required'].includes(error.status));
assert.match(error.reason, /^[a-z][a-z0-9_]*$/);
assert.ok(error.message.includes('--unknown-smoke-option'));
NODE

step doctor
"$relay" doctor || fail 'doctor reported failures'

if ! command -v xterm >/dev/null 2>&1 || ! command -v xwininfo >/dev/null 2>&1; then
  step 'install xterm and xwininfo (test-only dependencies)'
  elevate=''
  [ "$(id -u)" = 0 ] || elevate='sudo -n'
  { $elevate apt-get update -qq && $elevate env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends xterm x11-utils >/dev/null; } ||
    fail 'xterm or xwininfo is missing and could not be installed'
fi

step "up -d (session $name, port $port)"
set -- up -d --name "$name" --port "$port" --json
[ -z "$backend" ] || set -- "$@" --backend "$backend"
[ -z "$wayland_display" ] || set -- "$@" --display "$wayland_display"
"$relay" "$@" > "$work/up.json" 2> "$work/stderr" || fail "up -d: $(cat "$work/stderr")"
[ ! -s "$work/stderr" ] || fail 'up JSON wrote stderr'
[ "$(field "$work/up.json" outcome session.name)" = "started $name" ] || fail 'up envelope'

step 'status --json'
"$relay" status --name "$name" --json > "$work/status.json" 2> "$work/stderr" || fail 'status reports the session is not running'
[ ! -s "$work/stderr" ] || fail 'status JSON wrote stderr'
[ "$(field "$work/status.json" session.running session.state)" = 'true ready' ] || fail "unexpected status: $(cat "$work/status.json")"
display=$(field "$work/status.json" session.display)
xauthority=$(field "$work/status.json" session.xauthority)
runtime_dir=''
if [ "$backend" = wayland ] && [ -z "$wayland_display" ]; then
  runtime_dir=$(field "$work/status.json" session.runtimeDir)
  [ -d "$runtime_dir" ] || fail "status has no runtimeDir: $(cat "$work/status.json")"
fi
logs=$(field "$work/status.json" session.logs)
export DISPLAY=$display
if [ -n "$xauthority" ]; then export XAUTHORITY=$xauthority; fi

step 'HTTP connections close after the response'
node - "$port" <<'NODE' || fail 'engine kept an HTTP connection open after its response'
const net = require('node:net');
const socket = net.connect(Number(process.argv[2]), '127.0.0.1');
let response = '';
const timer = setTimeout(() => { console.error('no close within 2 s'); process.exit(1); }, 2000);
socket.on('connect', () => socket.write('GET /capabilities HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\n\r\n'));
socket.on('data', (chunk) => { response += chunk; });
socket.on('close', () => {
  clearTimeout(timer);
  process.exit(/^HTTP\/1\.1 200/.test(response) && /\r\nconnection: close\r\n/i.test(response) ? 0 : 1);
});
NODE

step 'viewer refuses framing'
node - "$port" <<'NODE' || fail 'viewer HTML allows framing'
const assert = require('node:assert/strict');
const http = require('node:http');
const port = Number(process.argv[2]);
const headers = (path) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path }, (response) => { response.resume(); resolve(response.headers); }).on('error', reject);
});
(async () => {
  for (const path of ['/', '/index.html']) {
    const value = await headers(path);
    assert.match(value['content-security-policy'] ?? '', /(^|;)\s*frame-ancestors 'none'(\s*;|$)/);
    assert.equal(value['x-frame-options'], 'DENY');
  }
})().catch((error) => { console.error(error.message); process.exit(1); });
NODE

step screenshot
"$relay" screenshot --name "$name" --json "$work/screen.png" > "$work/screenshot.json" 2> "$work/stderr" || fail screenshot
[ ! -s "$work/stderr" ] || fail 'screenshot JSON wrote stderr'
[ "$(field "$work/screenshot.json" outcome screenshot.width screenshot.height)" = 'saved 1280 720' ] || fail "screenshot is not 1280x720: $(cat "$work/screenshot.json")"

step 'start xterm with mouse reporting'
xterm -T relay-smoke -geometry 60x8+200+150 \
  -e sh -c "printf '\\033[?1000h'; exec cat > '$work/typed'" > "$work/xterm.log" 2>&1 &
xterm_pid=$!
geometry=''
settled=''
last=''
previous=''
stable=0
for _ in $(seq 75); do
  geometry=$(xwininfo -name relay-smoke 2>/dev/null) || geometry=''
  set --
  if [ -n "$geometry" ]; then
    set -- $(printf '%s\n' "$geometry" | awk '/Absolute upper-left X/{x=$NF} /Absolute upper-left Y/{y=$NF} /Width:/{w=$NF} /Height:/{h=$NF}
      END{printf "%s %s %s %s", x, y, w, h}')
  fi
  if [ "$#" -eq 4 ]; then
    last="$1 $2 $3 $4"
    if [ "$3" -gt 1 ] && [ "$4" -gt 1 ]; then
      if [ "$last" = "$previous" ]; then
        stable=$((stable + 1))
      else
        previous=$last
        stable=1
      fi
      if [ "$stable" -ge 3 ]; then
        settled=$geometry
        break
      fi
    fi
  fi
  sleep 0.2
done
[ -n "$settled" ] || fail "xterm window did not settle at a placed geometry: ${last:-$(cat "$work/xterm.log")}"
geometry=$settled
set -- $(printf '%s\n' "$geometry" | awk '/Absolute upper-left X/{x=$NF} /Absolute upper-left Y/{y=$NF} /Width:/{w=$NF} /Height:/{h=$NF}
  END{printf "%.4f %.4f", (x+w/2)/1280, (y+h/2)/720}')
step "click $1 $2, type, key Enter"
sleep 1
"$relay" click --name "$name" "$1" "$2" > "$work/stdout" || fail click
[ ! -s "$work/stdout" ] || fail 'click wrote piped stdout'
"$relay" type --name "$name" 'hello smoke' --json > "$work/input.json" 2> "$work/stderr" || fail type
[ ! -s "$work/stderr" ] || fail 'input JSON wrote stderr'
[ "$(field "$work/input.json" outcome input.events)" = 'sent 11' ] || fail 'input envelope'
"$relay" key --name "$name" Enter || fail key
check='const d=require("fs").readFileSync(process.argv[1]); process.exit(d.includes(Buffer.from("\x1b[M")) && d.includes(Buffer.from("hello smoke\n")) ? 0 : 1);'
for _ in $(seq 25); do node -e "$check" "$work/typed" && break; sleep 0.2; done
node -e "$check" "$work/typed" || fail "xterm did not receive the click and text: $(od -c "$work/typed" | head -5)"
"$relay" screenshot --name "$name" "$work/after.png" > "$work/stdout" || fail 'screenshot after input'
[ "$(cat "$work/stdout")" = "$work/after.png" ] || fail 'screenshot did not print only its path'

step 'run shares the desktop bus and restarts apps'
node - "$relay" "$name" "$logs/session.json" <<'NODE' || fail 'run environment or restart'
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const [relay, name, record] = process.argv.slice(2);
const session = JSON.parse(fs.readFileSync(record, 'utf8'));
const environment = (pid) => {
  const result = {};
  for (const item of fs.readFileSync(`/proc/${pid}/environ`).toString().split('\0')) {
    const at = item.indexOf('=');
    if (at > 0) result[item.slice(0, at)] = item.slice(at + 1);
  }
  return result;
};
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const desktop = environment(session.components.desktop?.pid ?? session.supervisor.pid);
for (const options of [[], ['--restart']]) {
  const result = JSON.parse(execFileSync(relay, ['run', '--name', name, '--json', ...options, '--', 'xterm', '-T', `${name}-restart`], { encoding: 'utf8' }));
  if (result.outcome !== 'started' || !Number.isInteger(result.app?.pid)) throw new Error('invalid run envelope');
  const app = result.app;
  const actual = environment(app.pid);
  for (const key of ['DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'ICEAUTHORITY']) {
    if (actual[key] !== desktop[key]) throw new Error(`${key} differs: ${actual[key]} != ${desktop[key]}`);
  }
  if (session.backend === 'wayland' && actual.WAYLAND_DISPLAY !== session.waylandDisplay) {
    throw new Error(`WAYLAND_DISPLAY differs: ${actual.WAYLAND_DISPLAY} != ${session.waylandDisplay}`);
  }
  if (!options.length) continue;
  const watcher = Number(fs.readFileSync(`/proc/${app.pid}/stat`, 'utf8').split(') ')[1].split(' ')[1]);
  if (environment(watcher).SCREEN_RELAY_SESSION !== path.dirname(record)) throw new Error('watcher has no session marker');
  process.kill(app.pid, 'SIGTERM');
  const deadline = Date.now() + 10000;
  let restarted = false;
  while (Date.now() < deadline) {
    const children = fs.readFileSync(`/proc/${watcher}/task/${watcher}/children`, 'utf8').split(/\s+/).filter(Boolean);
    if (children.length && children[0] !== String(app.pid)) {
      if (environment(children[0]).DBUS_SESSION_BUS_ADDRESS !== desktop.DBUS_SESSION_BUS_ADDRESS) throw new Error('restarted app lost the bus');
      console.log(`Restarted xterm: ${app.pid} -> ${children[0]}`);
      restarted = true;
      break;
    }
    pause(100);
  }
  if (!restarted) throw new Error('xterm did not restart');
}
NODE

if [ -z "$backend" ]; then
  step 'scoped grants (token session on 127.0.0.2)'
  grant_port=$((port + 1))
  "$relay" up -d --name "$name-g" --port "$grant_port" --bind 127.0.0.2 --public https://Desktop.Example.test:443 --allow-origin "https://app.example.test,http://localhost:8081" --json > "$work/up-g.json" 2> "$work/stderr" ||
    fail "grant session up: $(cat "$work/stderr")"
  "$relay" status --name "$name-g" --show-token --json > "$work/status-g.json" 2> "$work/stderr" || fail 'grant session status'
  node "$(dirname "$0")/integration/grants.mjs" "$grant_port" "$(field "$work/status-g.json" session.token)" ||
    { "$relay" logs --name "$name-g" >&2 2>/dev/null; "$relay" down --name "$name-g" >/dev/null 2>&1; fail 'scoped grants'; }
  node "$(dirname "$0")/integration/origins.mjs" "$grant_port" "$(field "$work/status-g.json" session.token)" ||
    { "$relay" down --name "$name-g" >/dev/null 2>&1; fail 'browser origins'; }
  "$relay" down --name "$name-g" --json > "$work/down-g.json" 2> "$work/stderr" || fail 'grant session down'
fi

step 'down (twice: must be idempotent)'
"$relay" down --name "$name" --json > "$work/down.json" 2> "$work/stderr" || fail down
[ ! -s "$work/stderr" ] || fail 'down JSON wrote stderr'
[ "$(field "$work/down.json" outcome session.name)" = "stopped $name" ] || fail 'down envelope'
"$relay" down --name "$name" --json > "$work/down.json" 2> "$work/stderr" || fail 'second down'
[ ! -s "$work/stderr" ] || fail 'second down JSON wrote stderr'
[ "$(field "$work/down.json" outcome)" = unchanged ] || fail 'second down changed the session'

step 'nothing left running'
"$relay" status --name "$name" --json > "$work/status.json" 2> "$work/stderr" || fail 'stopped session status must exit 0'
[ ! -s "$work/stderr" ] || fail 'stopped status JSON wrote stderr'
[ "$(field "$work/status.json" session.running session.state)" = 'false stopped' ] || fail 'status did not report stopped'
left=$(grep -ls "SCREEN_RELAY_SESSION=$logs" /proc/[0-9]*/environ 2>/dev/null || true)
[ -z "$left" ] || fail "processes left: $left"
if [ "$backend" = wayland ]; then
  step 'wayland cleanup'
  kill "$xterm_pid" 2>/dev/null || true
  if [ -n "$wayland_display" ]; then
    [ -S "$XDG_RUNTIME_DIR/$wayland_display" ] || fail "compositor socket $XDG_RUNTIME_DIR/$wayland_display is gone after down"
  else
    [ ! -e "$runtime_dir" ] || fail "runtime directory $runtime_dir still exists after down"
  fi
else
  for _ in $(seq 25); do running "$xterm_pid" || break; sleep 0.2; done
  if running "$xterm_pid"; then fail 'xterm still running after its display stopped'; fi
  [ ! -e "/tmp/.X11-unix/X${display#:}" ] || fail "display socket $display still exists"
fi
if node -e 'const s=require("net").connect(Number(process.argv[1]), "127.0.0.1"); s.on("connect", () => { s.destroy(); process.exit(0); }); s.on("error", () => process.exit(1));' "$port"; then
  fail "port $port still accepts connections"
fi
rm -rf "$work"
printf 'PASS\n'
