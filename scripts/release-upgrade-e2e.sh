#!/usr/bin/env bash
# Pre-stable end-to-end run of the real upgrade path, on a disposable Debian or Ubuntu host as root.
#
# 1. Installs the base release with that release's own installer, completes setup through the API and
#    seeds representative state: a custom group that holds retired scope names, a user in it, an API
#    token, an uploaded certificate, a webhook with an alert rule and a test delivery, an nginx node and a
#    docker node with the base daemons, a container, a proxy host with a health check, a Route Secure Link
#    to a container on the docker node and (with the private core) a container link between two containers.
# 2. Updates to the candidate through the product (check-update, update) while probing the API and the
#    route every second, then checks version, sessions, token, effective access, certificate, rule and
#    nodes still on the base daemons; the built-in outbound alert rule, unchanged rule/webhook/deliveries,
#    and a folder-limited grant created after the update (subfolders yes, top level no).
# 3. Updates the docker and nginx daemons and the relay through the product; the container must keep
#    running and the lease watchdog must get installed. A stream, a byte-exact download and a TCP echo run
#    through the Secure Links across each daemon update; the node's report of the update (kept/cut) must
#    match what they saw, the node must show the candidate launcher and its next update must hand over.
#    From a base launcher before 2.11.4 the update has one disruption window: the daemon swap, then the
#    one-time launcher switch, two drops within ~60 s, then none.
#    No warnings or errors in the app, relay and daemon logs beyond LOG_ALLOW.
# 4. Runs the base updater's own rollback() on the migrated database, checks the base (license, node
#    creation, group scopes, Pages insert), updates again and compares effective access with step 2.
# 5. Installs the candidate fresh with the candidate's installer and completes setup and first sign-in; the
#    upgraded install's built-in groups must equal the fresh install's.
# 6. With GATEWAY_E2E_LICENSE_KEY set: activates the key on the base and checks that the candidate's
#    private core is downloaded and loaded after the update. The key is deactivated before teardown.
#
# A local release feed pins the base and candidate tags; images, manifests and signatures are the real
# ones. Unless a license key is given, a local DNS forwarder used by Docker answers NXDOMAIN for the
# license server. Gateway updates need it (the target image authorizes the update with the license
# server even on Community), so by default it is reachable only while a Gateway update runs.
# Every check prints PASS, FAIL or SKIP with evidence; the exit code is non-zero on any FAIL. Everything
# the run created is removed at the end unless --keep is given.

set -o pipefail

usage() {
  cat <<'EOF'
Usage: release-upgrade-e2e.sh --candidate vX.Y.Z[-rc.N] [options]

Run as root on a disposable Debian/Ubuntu host with Internet access, or pass --ssh to run it there.
The run takes about 25 minutes; start it under nohup, tmux or systemd-run on the host.

Options:
  --candidate TAG          Release to prove (required)
  --base TAG               Stable release to upgrade from (default: v2.10.1)
  --host-address IP        Address nodes and containers use to reach this host (default: the source
                           address of the default route)
  --public-url URL         Public URL given to setup (default: https://gateway-e2e-<run>.invalid:3000;
                           its host name is the installation name the license server sees)
  --docker-address-pool CIDR
                           default-address-pools base for the Docker the run installs (e.g. 10.201.0.0/16)
  --license-server MODE    block (default): reachable only while a Gateway update runs;
                           block-all: never reachable (Community updates must succeed without it);
                           allow: never blocked. A license key implies allow until the fresh install.
  --max-api-downtime SEC   Longest acceptable API outage during a Gateway update (default: 120)
  --workdir DIR            Working directory (default: /var/tmp/gateway-e2e-<run>)
  --logs-out FILE          Write a tar.gz of the run logs and API evidence before removing the workdir
  --keep                   Keep everything the run created
  --cleanup-only DIR       Remove what a run started with --keep created (DIR is its --workdir)
  --ssh TARGET             Stream this script to TARGET and run it there with sudo
  -h, --help               Show this help

Environment:
  GATEWAY_E2E_LICENSE_KEY  Paid license key for step 6 (optional)
EOF
}

REPO="the-square-labs/gateway"
RAW_BASE="https://raw.githubusercontent.com/${REPO}"
RELEASE_DOWNLOAD="https://github.com/${REPO}/releases/download"
REAL_FEED="https://get.opfield.dev/gateway/releases"
# The license server answers on license.opfield.dev (2.12+) and on its earlier name, which releases up to 2.11 use and
# 2.12+ fall back to; the DNS guard blocks both, the app-container lookup checks the current one.
LICENSE_HOST="license.opfield.dev"
LICENSE_HOSTS="license.opfield.dev,license.thesqlabs.com"
MAILPIT_IMAGE="docker.io/axllent/mailpit:v1.31.3"
WEB_IMAGE="nginx:1.27-alpine"
INSTALL_DIR="/opt/gateway"
API="https://127.0.0.1:3000"
FEED_PORT=18081
WEB_PORT=18088
ROUTE_DOMAIN="app.e2e.test"
ADMIN_EMAIL="admin@e2e.test"
ADMIN_PASSWORD="E2e-Admin-Passw0rd!"
OPERATOR_EMAIL="operator@e2e.test"

# Scope fixture for the 2.10 -> 2.11 catalog cleanup: retired names the base still grants, and the
# current names 2.11 must derive from them. Adjust together with the next catalog change. The group
# also gets nodes:config:edit and proxy:advanced:bypass qualified with the seeded nginx node and proxy
# host, and docker:volumes:create on the docker node.
GROUP_SCOPES_PLAIN=(
  nodes:details nodes:logs docker:containers:view docker:containers:manage proxy:view proxy:edit
  ssl:cert:view pki:cert:view settings:gateway:view
  notifications:view notifications:manage logs:manage proxy:raw:toggle proxy:templates:create
  docker:containers:folders:manage docker:containers:config ssl:cert:export pki:ca:view:root
)
OPERATOR_ADDITIONAL_SCOPES=(notifications:deliveries:view pki:ca:view:intermediate)
TOKEN_SCOPES=(nodes:details docker:containers:view proxy:view notifications:view proxy:templates:create docker:containers:folders:manage)
RETIRED_SCOPES=(
  ssl:cert:revoke ssl:cert:export notifications:view notifications:manage notifications:alerts:create
  notifications:alerts:edit notifications:alerts:delete notifications:webhooks:create
  notifications:webhooks:edit notifications:webhooks:delete notifications:deliveries:view logs:manage
  docker:containers:config nodes:config:edit pki:ca:view:root pki:ca:view:intermediate
  proxy:raw:toggle proxy:advanced:bypass proxy:raw:bypass proxy:templates:create proxy:templates:edit
  proxy:templates:delete docker:containers:folders:manage
)
EXPECTED_OPERATOR_SCOPES=(
  notifications:alerts:view notifications:webhooks:view notifications:alerts:manage
  notifications:webhooks:manage logs:environments:view proxy:templates:manage docker:folders:manage pki:ca:view
)
EXPECTED_TOKEN_SCOPES=(notifications:alerts:view notifications:webhooks:view proxy:templates:manage docker:folders:manage)

BASE="v2.10.1"
CANDIDATE=""
CHANNEL="stable"
HOST_ADDR=""
PUBLIC_URL=""
DOCKER_POOL=""
LICENSE_MODE="block"
MAX_API_DOWNTIME=120
WORK=""
LOGS_OUT=""
KEEP=0
CLEANUP_ONLY=""
SSH_TARGET=""
LICENSE_KEY="${GATEWAY_E2E_LICENSE_KEY:-}"

PHASE="0"
PASSED=0
FAILED=0
SKIPPED=0
CODE=""
RESP=""
JAR=""
CSRF=""
TOKEN=""
PROJECT=""
SETUP_CODE=""
SETUP_CSRF=""
UPDATE_SINCE=""
UPDATE_ERROR=""
CLEANED=0
declare -A FACT=()
declare -A TIMING=()

parse_args() {
  local -a remote=()
  while (($#)); do
    case "$1" in
      --candidate) CANDIDATE="${2:?missing tag}"; remote+=("$1" "$2"); shift 2 ;;
      --base) BASE="${2:?missing tag}"; remote+=("$1" "$2"); shift 2 ;;
      --host-address) HOST_ADDR="${2:?missing address}"; remote+=("$1" "$2"); shift 2 ;;
      --public-url) PUBLIC_URL="${2:?missing URL}"; remote+=("$1" "$2"); shift 2 ;;
      --docker-address-pool) DOCKER_POOL="${2:?missing CIDR}"; remote+=("$1" "$2"); shift 2 ;;
      --license-server) LICENSE_MODE="${2:?missing mode}"; remote+=("$1" "$2"); shift 2 ;;
      --max-api-downtime) MAX_API_DOWNTIME="${2:?missing seconds}"; remote+=("$1" "$2"); shift 2 ;;
      --workdir) WORK="${2:?missing directory}"; remote+=("$1" "$2"); shift 2 ;;
      --logs-out) LOGS_OUT="${2:?missing file}"; remote+=("$1" "$2"); shift 2 ;;
      --keep) KEEP=1; remote+=("$1"); shift ;;
      --cleanup-only) CLEANUP_ONLY="${2:?missing directory}"; remote+=("$1" "$2"); shift 2 ;;
      --ssh) SSH_TARGET="${2:?missing target}"; shift 2 ;;
      -h|--help) usage; exit 0 ;;
      *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
    esac
  done
  if [[ -n "$SSH_TARGET" ]]; then
    local self="${BASH_SOURCE[0]}"
    [[ -f "$self" ]] || { echo "--ssh needs the script as a file" >&2; exit 2; }
    {
      [[ -n "$LICENSE_KEY" ]] && printf 'export GATEWAY_E2E_LICENSE_KEY=%q\n' "$LICENSE_KEY"
      cat "$self"
    } | ssh "$SSH_TARGET" "sudo -n bash -s -- $(printf '%q ' "${remote[@]}")"
    exit $?
  fi
}

# ── Output ────────────────────────────────────────────────────────────

say() { printf '%s  %s\n' "$(date -u +%H:%M:%S)" "$*"; }

record() {
  local status="$1" name="$2" evidence="${3:-}" line
  line="$(printf '%-4s [%s] %s' "$status" "$PHASE" "$name")"
  [[ -n "$evidence" ]] && line+=" — ${evidence}"
  printf '%s\n' "$line"
  [[ -n "$WORK" && -d "$WORK" ]] && printf '%s\n' "$line" >>"$WORK/results.txt"
  case "$status" in
    PASS) PASSED=$((PASSED + 1)) ;;
    FAIL) FAILED=$((FAILED + 1)) ;;
    SKIP) SKIPPED=$((SKIPPED + 1)) ;;
  esac
}
pass() { record PASS "$@"; }
fail() { record FAIL "$@"; }
skip() { record SKIP "$@"; }

# check NAME EVIDENCE CONDITION... — PASS when the condition command succeeds.
check() {
  local name="$1" evidence="$2"
  shift 2
  if "$@" >/dev/null; then
    pass "$name" "$evidence"
    return 0
  fi
  # A failed request shows what the server answered.
  if [[ "$evidence" == *"HTTP ${CODE}"* && ! "$CODE" =~ ^2 && -s "$RESP" ]]; then
    evidence+=" | $(short "$RESP" 300)"
  fi
  fail "$name" "$evidence"
  return 1
}

phase() {
  PHASE="$1"
  printf '\n%s  ── %s ──\n' "$(date -u +%H:%M:%S)" "$2"
}

# wait_for TIMEOUT DESCRIPTION COMMAND... — polls every 2 s and reports progress every 30 s.
wait_for() {
  local timeout="$1" what="$2" start=$SECONDS next=$((SECONDS + 30))
  shift 2
  until "$@"; do
    if ((SECONDS - start >= timeout)); then
      say "timed out after ${timeout}s waiting for ${what}"
      return 1
    fi
    if ((SECONDS >= next)); then
      say "waiting for ${what} ($((SECONDS - start))s)"
      next=$((SECONDS + 30))
    fi
    sleep 2
  done
}

short() { tr -d '\n' <"$1" 2>/dev/null | head -c "${2:-300}"; }
now_ms() { date +%s%3N; }

# ── Helpers written to the work directory ─────────────────────────────

write_helpers() {
  mkdir -p "$WORK/py"
  cat >"$WORK/py/jx.py" <<'PY'
# jx.py FILE EXPR [ARG...]: evaluates EXPR with d (document), D (data envelope removed), items(), args.
import json, sys
def unwrap(v):
    return v['data'] if isinstance(v, dict) and 'data' in v else v
def items(v):
    v = unwrap(v)
    if isinstance(v, dict):
        for key in ('items', 'results', 'nodes', 'users', 'groups', 'tokens'):
            if isinstance(v.get(key), list):
                return v[key]
    return v if isinstance(v, list) else []
try:
    with open(sys.argv[1]) as f:
        d = json.load(f)
    r = eval(sys.argv[2], {'d': d, 'D': unwrap(d), 'items': items, 'unwrap': unwrap, 'args': sys.argv[3:], 'json': json})
except Exception:
    sys.exit(1)
if r is None:
    sys.exit(1)
if isinstance(r, bool):
    print('true' if r else 'false')
elif isinstance(r, (dict, list)):
    print(json.dumps(r, sort_keys=True))
else:
    print(r)
PY
  cat >"$WORK/py/mkjson.py" <<'PY'
# mkjson.py EXPR [ARG...]: prints EXPR as JSON; a holds the arguments, read() reads a file.
import json, sys
def read(path):
    with open(path) as f:
        return f.read()
print(json.dumps(eval(sys.argv[1], {'a': sys.argv[2:], 'read': read, 'json': json})))
PY
  cat >"$WORK/py/feed.py" <<'PY'
# Release feed mock: components pinned in the state file get exactly that tag (release notes from
# GitHub); all others are forwarded to the real feed for the state's channel without `current`, so
# they resolve to the newest release of that channel. Artifacts are never served from here.
import http.server, json, sys, threading, urllib.error, urllib.parse, urllib.request
ADDR, PORT, STATE, LOG, REAL, REPO = sys.argv[1], int(sys.argv[2]), sys.argv[3], sys.argv[4], sys.argv[5], sys.argv[6]
HEADERS = {'User-Agent': 'curl/8.14', 'Accept': 'application/json'}
cache, lock = {}, threading.Lock()

def fetch(url):
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=HEADERS), timeout=20) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()
    except Exception as e:
        return 502, json.dumps({'error': str(e)}).encode()

def release(tag):
    with lock:
        if tag in cache:
            return cache[tag]
    status, body = fetch(f'https://api.github.com/repos/{REPO}/releases/tags/{urllib.parse.quote(tag)}')
    info = json.loads(body) if status == 200 else {}
    url = info.get('html_url') or f'https://github.com/{REPO}/releases/tag/{tag}'
    notes = info.get('body') or ''
    target = {'tag_name': tag, 'name': info.get('name') or tag, 'description': notes, 'body': notes,
              'html_url': url, 'published_at': info.get('published_at'), 'prerelease': '-rc.' in tag,
              '_links': {'self': url}}
    with lock:
        cache[tag] = target
    return target

class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        query = dict(urllib.parse.parse_qsl(urllib.parse.urlparse(self.path).query))
        component = query.get('component', '')
        with open(STATE) as f:
            state = json.load(f)
        pins = state.get('pins', {})
        if component in pins:
            tag = pins[component]
            if not tag:
                return self.reply(204, b'')
            body = json.dumps({'component': component, 'current': query.get('current'), 'target': release(tag)}).encode()
            return self.reply(200, body)
        upstream = {k: v for k, v in query.items() if k != 'current'}
        upstream['channel'] = state.get('channel', 'stable')
        status, body = fetch(REAL + '?' + urllib.parse.urlencode(upstream))
        self.reply(status, body)

    def reply(self, status, body):
        self.send_response(status)
        if body:
            self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        if body:
            self.wfile.write(body)
        tag = None
        try:
            tag = json.loads(body).get('target', {}).get('tag_name')
        except Exception:
            pass
        with open(LOG, 'a') as f:
            f.write(json.dumps({'path': self.path, 'status': status, 'tag': tag}) + '\n')

    def log_message(self, *args):
        pass

http.server.ThreadingHTTPServer((ADDR, PORT), Handler).serve_forever()
PY
  cat >"$WORK/py/dns_guard.py" <<'PY'
# DNS forwarder for Docker (daemon.json "dns"): answers NXDOMAIN for the license server while the
# block file contains 1 and forwards everything else to the host's own resolvers.
import socket, socketserver, struct, sys, threading, time
ADDR, BLOCK_FILE, LOG = sys.argv[1], sys.argv[2], sys.argv[3]
BLOCKED = [h.strip() for h in sys.argv[4].lower().split(',') if h.strip()]

def upstreams():
    for path in ('/etc/resolv.conf', '/run/systemd/resolve/resolv.conf'):
        try:
            with open(path) as f:
                found = [l.split()[1] for l in f if l.startswith('nameserver') and len(l.split()) > 1]
        except OSError:
            continue
        found = [s for s in found if not s.startswith('127.') and s != '::1' and s != ADDR]
        if found:
            return found
    sys.exit('no upstream resolver found')

UPSTREAMS = upstreams()
log_lock = threading.Lock()

def log(event, name):
    with log_lock, open(LOG, 'a') as f:
        f.write(f'{time.time():.3f} {event} {name}\n')

def question(msg):
    i, labels = 12, []
    while i < len(msg) and msg[i] != 0:
        n = msg[i]
        if n & 0xC0:
            return None, None
        labels.append(msg[i + 1:i + 1 + n].decode('ascii', 'replace'))
        i += 1 + n
    return '.'.join(labels).lower(), i + 5

def blocked(name):
    if not name or not any(name == b or name.endswith('.' + b) for b in BLOCKED):
        return False
    try:
        with open(BLOCK_FILE) as f:
            on = f.read().strip() == '1'
    except OSError:
        on = True
    log('BLOCK' if on else 'ALLOW', name)
    return on

def nxdomain(msg, end):
    flags = struct.unpack('>H', msg[2:4])[0]
    flags = 0x8000 | (flags & 0x7900) | 0x0080 | 3
    return msg[:2] + struct.pack('>HHHHH', flags, 1, 0, 0, 0) + msg[12:end]

def forward(msg, tcp):
    for server in UPSTREAMS:
        family = socket.AF_INET6 if ':' in server else socket.AF_INET
        try:
            with socket.socket(family, socket.SOCK_STREAM if tcp else socket.SOCK_DGRAM) as s:
                s.settimeout(4)
                if tcp:
                    s.connect((server, 53))
                    s.sendall(struct.pack('>H', len(msg)) + msg)
                    size = struct.unpack('>H', s.recv(2))[0]
                    data = b''
                    while len(data) < size:
                        chunk = s.recv(size - len(data))
                        if not chunk:
                            break
                        data += chunk
                    return data
                s.sendto(msg, (server, 53))
                return s.recvfrom(65535)[0]
        except OSError:
            continue
    return None

def answer(msg, tcp):
    if len(msg) < 12:
        return None
    name, end = question(msg)
    if blocked(name):
        return nxdomain(msg, end)
    return forward(msg, tcp)

class UDP(socketserver.BaseRequestHandler):
    def handle(self):
        data, sock = self.request
        reply = answer(data, False)
        if reply:
            sock.sendto(reply, self.client_address)

class TCP(socketserver.BaseRequestHandler):
    def handle(self):
        head = self.request.recv(2)
        if len(head) < 2:
            return
        size = struct.unpack('>H', head)[0]
        data = b''
        while len(data) < size:
            chunk = self.request.recv(size - len(data))
            if not chunk:
                return
            data += chunk
        reply = answer(data, True)
        if reply:
            self.request.sendall(struct.pack('>H', len(reply)) + reply)

class ThreadingUDP(socketserver.ThreadingMixIn, socketserver.UDPServer):
    daemon_threads = True

class ThreadingTCP(socketserver.ThreadingMixIn, socketserver.TCPServer):
    daemon_threads = True
    allow_reuse_address = True

udp, tcp = ThreadingUDP((ADDR, 53), UDP), ThreadingTCP((ADDR, 53), TCP)
threading.Thread(target=tcp.serve_forever, daemon=True).start()
udp.serve_forever()
PY
  cat >"$WORK/py/probes.py" <<'PY'
# probes.py LOG START_MS END_MS: API outage and route failures in the window, as JSON.
import json, sys
start, end = int(sys.argv[2]), int(sys.argv[3])
api, route = [], []
with open(sys.argv[1]) as f:
    for line in f:
        parts = line.split()
        if len(parts) != 3 or not parts[0].isdigit():
            continue
        ts = int(parts[0])
        if start <= ts <= end:
            api.append((ts, parts[1]))
            if parts[2] != '-':
                route.append((ts, parts[2]))
down = [ts for ts, code in api if code != '200']
recovered = not down or any(code == '200' and ts > down[-1] for ts, code in api)
outage = 0.0
if down:
    after = [ts for ts, code in api if code == '200' and ts > down[-1]]
    outage = ((after[0] if after else end) - down[0]) / 1000
print(json.dumps({'apiSamples': len(api), 'apiFailures': len(down), 'apiOutageSeconds': round(outage, 1),
                  'apiRecovered': recovered, 'routeSamples': len(route),
                  'routeFailures': len([1 for _, c in route if c != '200']), 'routeCodes': sorted({c for _, c in route})}))
PY
  cat >"$WORK/py/sidecar-render.cjs" <<'JS'
// sidecar-render.cjs SOURCE PROJECT DIR: renders the base updater's sidecar script (through its EXIT trap) the way the
// base itself does: its template literal and the module functions it calls are evaluated with node, so the result is
// exactly what the base runs. Prints {"script": ..., "image": ...}; any value the template needs beyond its own
// parameters and functions stops it with the name.
const fs = require('fs');
const [src, composeProject, composeDir] = process.argv.slice(2);
const text = fs.readFileSync(src, 'utf8');
function skipString(t, i) {
  const quote = t[i];
  i += 1;
  while (i < t.length) {
    if (t[i] === '\\') { i += 2; continue; }
    if (t[i] === quote) return i + 1;
    if (quote === '`' && t[i] === '$' && t[i + 1] === '{') { i = skipBlock(t, i + 1); continue; }
    i += 1;
  }
  throw new Error('unterminated string');
}
function skipBlock(t, i) {
  let depth = 0;
  while (i < t.length) {
    const c = t[i];
    if (c === '"' || c === "'" || c === '`') { i = skipString(t, i); continue; }
    if (c === '/' && t[i + 1] === '/') { i = t.indexOf('\n', i); if (i < 0) break; continue; }
    if (c === '/' && t[i + 1] === '*') { i = t.indexOf('*/', i) + 2; continue; }
    if (c === '{') depth += 1;
    else if (c === '}' && --depth === 0) return i + 1;
    i += 1;
  }
  throw new Error('unbalanced block');
}
const start = text.indexOf('`set -eu\ncompose() {');
if (start < 0) throw new Error('sidecar template not found');
const template = text.slice(start, skipString(text, start));
const helpers = [];
for (const name of new Set([...template.matchAll(/\$\{\s*([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1]))) {
  const at = text.search(new RegExp(`function\\s+${name.replace(/\$/g, '\\$')}\\s*\\(`));
  if (at < 0) throw new Error(`template function ${name} not found`);
  helpers.push(text.slice(at, skipBlock(text, text.indexOf('{', text.indexOf(')', at)))));
}
const rendered = new Function('composeProject', 'composeDir', `${helpers.join('\n')}\nreturn ${template};`)(
  composeProject,
  composeDir
);
const trap = 'trap on_exit EXIT';
const cut = rendered.indexOf(trap);
if (cut < 0) throw new Error('sidecar trap not found');
const script = rendered.slice(0, cut + trap.length);
for (const marker of ['rollback() {', 'on_exit() {']) if (!script.includes(marker)) throw new Error(`missing ${marker}`);
const image = /docker\.io\/library\/docker:[0-9A-Za-z._-]+@sha256:[0-9a-f]{64}/.exec(text);
if (!image) throw new Error('sidecar image not found');
process.stdout.write(JSON.stringify({ script, image: image[0] }));
JS
  cat >"$WORK/py/access.py" <<'PY'
# access.py snapshot GROUP USERS TOKENS OPERATOR_EMAIL TOKEN_NAME OUT
# access.py compare A B eq|superset      access.py retired SNAP SCOPE...
# access.py expect SNAP FIELD SCOPE...
import json, sys
def load(path):
    with open(path) as f:
        return json.load(f)
def unwrap(v):
    return v['data'] if isinstance(v, dict) and 'data' in v else v
def items(v):
    v = unwrap(v)
    if isinstance(v, dict):
        for key in ('items', 'results', 'users', 'groups', 'tokens'):
            if isinstance(v.get(key), list):
                return v[key]
    return v if isinstance(v, list) else []
FIELDS = ('group', 'operatorGroupScopes', 'operatorScopes', 'token')
mode = sys.argv[1]
if mode == 'snapshot':
    group, users, tokens, email, token_name, out = sys.argv[2:8]
    group = unwrap(load(group))
    user = next(u for u in items(load(users)) if u.get('email') == email)
    token = next(t for t in items(load(tokens)) if t.get('name') == token_name)
    snap = {'group': sorted(group.get('scopes') or []), 'operatorGroupScopes': sorted(user.get('groupScopes') or []),
            'operatorScopes': sorted(user.get('scopes') or []),
            'operatorAdditional': sorted(user.get('additionalScopes') or []), 'token': sorted(token.get('scopes') or [])}
    with open(out, 'w') as f:
        json.dump(snap, f, indent=1, sort_keys=True)
    print(' '.join(f'{k}={len(snap[k])}' for k in FIELDS))
elif mode == 'compare':
    a, b, how = load(sys.argv[2]), load(sys.argv[3]), sys.argv[4]
    problems = []
    for k in FIELDS:
        missing = sorted(set(a[k]) - set(b[k]))
        extra = sorted(set(b[k]) - set(a[k]))
        if missing:
            problems.append(f'{k} lost {missing}')
        if how == 'eq' and extra:
            problems.append(f'{k} gained {extra}')
    print('; '.join(problems) if problems else 'identical' if how == 'eq' else 'nothing lost')
    sys.exit(1 if problems else 0)
elif mode == 'retired':
    snap, retired = load(sys.argv[2]), set(sys.argv[3:])
    found = sorted({s for k in FIELDS for s in snap[k] for r in retired if s == r or s.startswith(r + ':')})
    print(' '.join(found) if found else 'none')
    sys.exit(1 if found else 0)
elif mode == 'expect':
    snap, field = load(sys.argv[2]), sys.argv[3]
    missing = [s for s in sys.argv[4:] if s not in snap[field]]
    print('missing ' + ' '.join(missing) if missing else f'all {len(sys.argv) - 4} present')
    sys.exit(1 if missing else 0)
PY
  cat >"$WORK/py/journal-tag.py" <<'PY'
# journal-tag.py "PID ...": journalctl -o json lines as `daemon: MESSAGE`, or `daemon(base): MESSAGE` for the given PIDs.
import json, sys
base = set(sys.argv[1].split())
for line in sys.stdin:
    try:
        entry = json.loads(line)
    except ValueError:
        continue
    message = entry.get('MESSAGE')
    if isinstance(message, list):
        message = bytes(message).decode('utf-8', 'replace')
    if not isinstance(message, str):
        continue
    print(('daemon(base): ' if entry.get('_PID') in base else 'daemon: ') + message)
PY
  cat >"$WORK/py/apthist.py" <<'PY'
# apthist.py START_EPOCH MARKER_REGEX: packages installed by apt runs since START whose command line
# matches MARKER (the installers this run started), without architecture suffixes.
import datetime, re, sys
start, marker = float(sys.argv[1]), re.compile(sys.argv[2])
found, entry = set(), {}
def flush():
    if entry.get('start', 0) >= start - 5 and marker.search(entry.get('cmd', '')):
        found.update(re.findall(r'([A-Za-z0-9][A-Za-z0-9+.-]*)(?::[A-Za-z0-9]+)? \([^)]*\)', entry.get('install', '')))
try:
    with open('/var/log/apt/history.log', errors='replace') as f:
        for line in f:
            key, _, value = line.rstrip('\n').partition(': ')
            if key == 'Start-Date':
                flush()
                entry = {'start': datetime.datetime.strptime(' '.join(value.split()), '%Y-%m-%d %H:%M:%S').timestamp()}
            elif key == 'Commandline':
                entry['cmd'] = value
            elif key == 'Install':
                entry['install'] = entry.get('install', '') + ', ' + value
    flush()
except OSError:
    pass
print('\n'.join(sorted(found)))
PY
}

jx() { python3 "$WORK/py/jx.py" "$@" 2>/dev/null; }
mkjson() { python3 "$WORK/py/mkjson.py" "$@"; }
keep_json() { cp "$RESP" "$WORK/json/$1.json" 2>/dev/null; }

# ── Gateway API ───────────────────────────────────────────────────────

curl_code() {
  local code
  code="$(curl "$@" 2>>"$WORK/logs/curl.log")"
  [[ "$code" =~ ^[0-9]{3}$ ]] || code="000"
  printf '%s' "$code"
}

refresh_csrf() {
  curl_code -ksS -m 30 -o "$WORK/csrf.json" -w '%{http_code}' -b "$JAR" -c "$JAR" "$API/auth/csrf" >/dev/null
  CSRF="$(jx "$WORK/csrf.json" 'D["csrfToken"]')"
}

# api METHOD PATH [BODY]: admin session request; status in CODE, body in RESP.
api() {
  local method="$1" path="$2" body="${3:-}" attempt
  RESP="$WORK/resp.json"
  for attempt in 1 2; do
    local -a args=(-ksS -m 120 -o "$RESP" -w '%{http_code}' -X "$method" -b "$JAR" -c "$JAR" -H 'Accept: application/json')
    if [[ "$method" != GET ]]; then
      args+=(-H "X-CSRF-Token: ${CSRF}")
      if [[ "$method" != DELETE || -n "$body" ]]; then
        [[ -n "$body" ]] || body='{}'
        args+=(-H 'Content-Type: application/json' --data-binary "$body")
      fi
    fi
    CODE="$(curl_code "${args[@]}" "$API$path")"
    if [[ "$CODE" == 403 && "$attempt" == 1 ]] && grep -qi csrf "$RESP" 2>/dev/null; then
      refresh_csrf
      continue
    fi
    break
  done
  printf '%s %s %s -> %s\n' "$(date -u +%T)" "$method" "$path" "$CODE" >>"$WORK/logs/api.log"
}

# tapi METHOD PATH: API token request.
tapi() {
  RESP="$WORK/resp.json"
  CODE="$(curl_code -ksS -m 60 -o "$RESP" -w '%{http_code}' -X "$1" -H "Authorization: Bearer ${TOKEN}" -H 'Accept: application/json' "$API$2")"
}

login_admin() {
  : >"$JAR"
  RESP="$WORK/resp.json"
  CODE="$(curl_code -ksS -m 30 -o "$RESP" -w '%{http_code}' -c "$JAR" -b "$JAR" -H 'Content-Type: application/json' \
    --data-binary "$(mkjson '{"email": a[0], "password": a[1]}' "$ADMIN_EMAIL" "$ADMIN_PASSWORD")" "$API/auth/password/login")"
  [[ "$CODE" == 200 ]] || return 1
  refresh_csrf
  [[ -n "$CSRF" ]]
}

ensure_session() {
  api GET /auth/me
  [[ "$CODE" == 200 ]] || login_admin
}

api_healthy() { [[ "$(curl_code -ks -m 5 -o /dev/null -w '%{http_code}' "$API/health")" == 200 ]]; }

gateway_version() {
  tapi GET /api/system/version
  [[ "$CODE" == 200 ]] && jx "$RESP" 'D["currentVersion"]'
}
version_is() { [[ "$(gateway_version)" == "$1" ]] && api_healthy; }

dc() { docker compose --project-name "$PROJECT" --project-directory "$INSTALL_DIR" -f "$INSTALL_DIR/docker-compose.yml" "$@"; }
service_id() { dc ps -q "$1" 2>/dev/null | head -n1; }
psql_gateway() { dc exec -T postgres psql -U gateway -d gateway -v ON_ERROR_STOP=1 -Atc "$1" 2>&1; }
container_identity() {
  local id="${1:-}"
  [[ -n "$id" ]] || { echo "missing"; return 0; }
  docker inspect -f '{{.Id}} {{.State.StartedAt}} restarts={{.RestartCount}}' "$id" 2>/dev/null || echo "missing"
}

env_set() {
  local key="$1" value="$2" file="$INSTALL_DIR/.env" tmp
  tmp="$(mktemp)"
  grep -v "^${key}=" "$file" >"$tmp"
  [[ -s "$tmp" && -n "$(tail -c1 "$tmp")" ]] && echo >>"$tmp"
  printf '%s=%s\n' "$key" "$value" >>"$tmp"
  cat "$tmp" >"$file"
  rm -f "$tmp"
}

license_block() {
  echo "$1" >"$WORK/license-block"
  say "license server $([[ "$1" == 1 ]] && echo blocked || echo reachable) for Docker containers"
}

# Resolves the license server inside the app container; prints ENOTFOUND while blocked.
license_lookup_from_app() {
  local app
  app="$(service_id app)"
  [[ -n "$app" ]] || { echo "no app container"; return 0; }
  docker exec "$app" node -e "require('node:dns').lookup('${LICENSE_HOST}',(e,a)=>{console.log(e?e.code:'resolved '+a)})" 2>&1 | tail -n1
}

check_license_guard() {
  local result
  result="$(license_lookup_from_app)"
  if [[ "$(cat "$WORK/license-block" 2>/dev/null)" == 1 ]]; then
    check "license server unreachable from Gateway" "lookup of ${LICENSE_HOST} in the app container: ${result}" \
      test "$result" = "ENOTFOUND"
  else
    check "license server reachable from Gateway" "lookup of ${LICENSE_HOST}: ${result}" grep -q '^resolved' <<<"$result"
  fi
}

feed_pin() {
  python3 - "$WORK/feed-state.json" "$@" <<'PY'
import json, sys
path, channel, pins = sys.argv[1], sys.argv[2], sys.argv[3:]
with open(path, 'w') as f:
    json.dump({'channel': channel, 'pins': dict(p.split('=', 1) for p in pins)}, f)
PY
  say "release feed: ${1} channel, pinned: ${*:2}"
}

start_background() {
  local name="$1"
  shift
  setsid "$@" </dev/null >>"$WORK/logs/${name}.out" 2>&1 &
  echo "$!" >"$WORK/pids/${name}"
}

# stop_background [NAME...]: stops the named background processes, or all of them.
stop_background() {
  local file pid
  for file in "$WORK"/pids/*; do
    [[ -f "$file" ]] || continue
    (($#)) && [[ " $* " != *" $(basename "$file") "* ]] && continue
    pid="$(cat "$file")"
    kill -- "-$pid" 2>/dev/null || kill "$pid" 2>/dev/null
    rm -f "$file"
  done
}

probe_window() { python3 "$WORK/py/probes.py" "$WORK/logs/probes.log" "$1" "$2"; }

window_value() {
  local window="$1" expr="$2"
  shift 2
  python3 "$WORK/py/jx.py" /dev/stdin "$expr" "$@" <<<"$window" 2>/dev/null
}

# ── Host snapshot and cleanup ─────────────────────────────────────────

SNAPSHOT_DIRS=(/etc /var/lib /opt /run /var/log /var/cache /usr/local/bin /usr/local/lib /etc/systemd/system
  /etc/systemd/system/multi-user.target.wants /etc/systemd/system/sockets.target.wants /etc/apt/sources.list.d
  /etc/apt/keyrings /usr/share/keyrings)
PRODUCT_ENTRY='^(docker|docker\..*|docker-.*|containerd|containerd\..*|nginx|nginx\..*|nginx-.*|monitoring-daemon.*|gateway|gateway-.*|runsc.*|containerd-shim-runsc.*|lease-watchdog.*|gvisor.*|buildkit)$'
PACKAGE_MARKER='docker-ce|containerd|nginx|gnupg|lsb-release|ca-certificates|curl|iptables|uidmap'

entry_list() { ls -A1 "$1" 2>/dev/null | sort; }
installed_packages() { dpkg-query -W -f='${Package}\t${db:Status-Status}\n' 2>/dev/null | awk '$2=="installed"{print $1}' | sort -u; }
host_links() { ip -o link show | awk -F': ' '{print $2}' | cut -d@ -f1 | sort; }
normalized_ruleset() { sed -E 's/counter packets [0-9]+ bytes [0-9]+/counter/' "$@"; }

snapshot_host() {
  local dir
  mkdir -p "$WORK/snapshot"
  date +%s >"$WORK/snapshot/start-epoch"
  installed_packages >"$WORK/snapshot/packages"
  cut -d: -f1 /etc/passwd | sort >"$WORK/snapshot/users"
  cut -d: -f1 /etc/group | sort >"$WORK/snapshot/groups"
  host_links >"$WORK/snapshot/links"
  sysctl -n net.ipv4.ip_forward >"$WORK/snapshot/ip_forward" 2>/dev/null
  for dir in "${SNAPSHOT_DIRS[@]}"; do
    entry_list "$dir" >"$WORK/snapshot/dir$(tr '/' '_' <<<"$dir")"
  done
  if command -v docker >/dev/null && docker info >/dev/null 2>&1; then
    echo 1 >"$WORK/snapshot/docker-preexisting"
    docker image ls -q --no-trunc | sort -u >"$WORK/snapshot/docker-images"
    docker volume ls -q | sort >"$WORK/snapshot/docker-volumes"
    docker network ls -q | sort >"$WORK/snapshot/docker-networks"
    [[ -f /etc/docker/daemon.json ]] && cp -p /etc/docker/daemon.json "$WORK/snapshot/daemon.json"
  else
    echo 0 >"$WORK/snapshot/docker-preexisting"
  fi
  [[ -d /etc/docker ]] && touch "$WORK/snapshot/etc-docker-existed"
  # Product-named entries that exist before the run (earlier installs, other work on the host) are
  # put back exactly as they were; a Docker that was already there keeps its own state.
  : >"$WORK/snapshot/preexisting"
  for dir in "${SNAPSHOT_DIRS[@]}"; do
    for entry in $(grep -E "$PRODUCT_ENTRY" "$WORK/snapshot/dir$(tr '/' '_' <<<"$dir")"); do
      [[ "$(cat "$WORK/snapshot/docker-preexisting")" == 1 && "$entry" =~ ^(docker|containerd) ]] && continue
      echo "${dir#/}/${entry}" >>"$WORK/snapshot/preexisting"
    done
  done
  if [[ -s "$WORK/snapshot/preexisting" ]]; then
    tar -C / -cpf "$WORK/snapshot/preexisting.tar" -T "$WORK/snapshot/preexisting" 2>/dev/null
    preexisting_manifest >"$WORK/snapshot/preexisting.manifest"
  fi
  if command -v nft >/dev/null; then
    nft list ruleset >"$WORK/snapshot/ruleset.nft" 2>/dev/null
  elif command -v iptables-save >/dev/null; then
    iptables-save >"$WORK/snapshot/ruleset.iptables" 2>/dev/null
  fi
}

preexisting_manifest() {
  local -a paths
  mapfile -t paths <"$WORK/snapshot/preexisting"
  (cd / && find "${paths[@]}" -printf '%p %y %m %s\n' 2>/dev/null | sort)
}

new_entries() { comm -13 "$WORK/snapshot/dir$(tr '/' '_' <<<"$1")" <(entry_list "$1"); }

cleanup_host() {
  local leftovers=() unit entry dir pkg port link user group installed_by_run
  local -a purge=() removed=()
  phase cleanup "Cleanup"
  stop_background
  if [[ -n "$LICENSE_KEY" && "${FACT[license_activated]}" == 1 ]] && api_healthy && ensure_session; then
    api DELETE /api/system/license/key
    check "license key deactivated" "DELETE /api/system/license/key -> HTTP ${CODE}" test "$CODE" = 200
  fi

  # Node daemons, the lease watchdog and other product units.
  for unit in $(new_entries /etc/systemd/system | grep -E '^(docker-daemon|nginx-daemon|monitoring-daemon|gateway-)'); do
    [[ "$unit" == *.service ]] && systemctl disable --now "$unit" >/dev/null 2>&1
    rm -rf "/etc/systemd/system/${unit}"
  done
  systemctl daemon-reload 2>/dev/null

  if command -v docker >/dev/null && docker info >/dev/null 2>&1; then
    if [[ "$(cat "$WORK/snapshot/docker-preexisting" 2>/dev/null)" == 1 ]]; then
      [[ -f "$INSTALL_DIR/docker-compose.yml" ]] && dc down -v --remove-orphans >/dev/null 2>&1
      docker ps -aq --filter name=gateway-e2e- | xargs -r docker rm -f >/dev/null 2>&1
      docker rm -f e2e-web >/dev/null 2>&1
      comm -13 "$WORK/snapshot/docker-volumes" <(docker volume ls -q | sort) | xargs -r docker volume rm -f >/dev/null 2>&1
      comm -13 "$WORK/snapshot/docker-networks" <(docker network ls -q | sort) | xargs -r docker network rm >/dev/null 2>&1
      comm -13 "$WORK/snapshot/docker-images" <(docker image ls -q --no-trunc | sort -u) | xargs -r docker image rm -f >/dev/null 2>&1
      if [[ -f "$WORK/snapshot/daemon.json" ]]; then
        cp -p "$WORK/snapshot/daemon.json" /etc/docker/daemon.json
      else
        rm -f /etc/docker/daemon.json
      fi
      systemctl restart docker >/dev/null 2>&1
    else
      docker ps -aq | xargs -r docker rm -f >/dev/null 2>&1
      docker system prune -af --volumes >/dev/null 2>&1
    fi
  fi
  if [[ "$(cat "$WORK/snapshot/docker-preexisting" 2>/dev/null)" != 1 ]]; then
    systemctl stop docker.socket docker containerd >/dev/null 2>&1
    awk '$2 ~ "^/(run/docker|var/lib/docker|run/containerd|var/lib/containerd)" {print $2}' /proc/mounts | sort -r |
      xargs -r -n1 umount -l 2>/dev/null
  fi

  # Packages that the installers this run started put on the host.
  installed_by_run="$(python3 "$WORK/py/apthist.py" "$(cat "$WORK/snapshot/start-epoch")" "$PACKAGE_MARKER")"
  for pkg in $(comm -13 "$WORK/snapshot/packages" <(installed_packages)); do
    grep -qx "$pkg" <<<"$installed_by_run" && purge+=("$pkg")
  done
  if ((${#purge[@]})); then
    say "purging ${#purge[@]} packages: ${purge[*]}"
    DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=300 purge -y -qq "${purge[@]}" >>"$WORK/logs/cleanup-apt.log" 2>&1 ||
      leftovers+=("apt purge failed (logs/cleanup-apt.log)")
  fi
  mapfile -t removed < <(comm -23 "$WORK/snapshot/packages" <(installed_packages))
  if ((${#removed[@]})); then
    say "reinstalling packages the run removed: ${removed[*]}"
    DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=300 install -y -qq "${removed[@]}" >>"$WORK/logs/cleanup-apt.log" 2>&1 ||
      leftovers+=("packages removed by the run: ${removed[*]}")
  fi

  # Files, directories, units, apt sources, users and groups the product created.
  rm -rf "$INSTALL_DIR"
  for dir in "${SNAPSHOT_DIRS[@]}"; do
    for entry in $(new_entries "$dir" | grep -E "$PRODUCT_ENTRY"); do
      rm -rf "${dir:?}/${entry}"
    done
  done
  for entry in $(new_entries /usr/local/bin | grep -E '^(docker-daemon|nginx-daemon|monitoring-daemon|gateway-|runsc|containerd-shim-runsc)'); do
    rm -f "/usr/local/bin/${entry}"
  done
  for dir in /etc/apt/sources.list.d /etc/apt/keyrings /usr/share/keyrings; do
    for entry in $(new_entries "$dir" | grep -E 'docker|nginx'); do
      rm -f "${dir:?}/${entry}"
    done
  done
  [[ -f "$WORK/snapshot/etc-docker-existed" ]] || rm -rf /etc/docker
  systemctl daemon-reload 2>/dev/null
  for user in $(comm -13 "$WORK/snapshot/users" <(cut -d: -f1 /etc/passwd | sort) | grep -E '^(nginx|docker|gateway.*)$'); do
    userdel "$user" >/dev/null 2>&1
  done
  for group in $(comm -13 "$WORK/snapshot/groups" <(cut -d: -f1 /etc/group | sort) | grep -E '^(nginx|docker|gateway.*)$'); do
    groupdel "$group" >/dev/null 2>&1
  done
  DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=300 update -qq >>"$WORK/logs/cleanup-apt.log" 2>&1

  # Network state: interfaces, firewall rules, forwarding.
  for link in $(comm -13 "$WORK/snapshot/links" <(host_links) | grep -E '^(docker0|br-|veth)'); do
    ip link delete "$link" >/dev/null 2>&1
  done
  if [[ -f "$WORK/snapshot/ruleset.nft" ]] && command -v nft >/dev/null; then
    if [[ "$(nft list ruleset 2>/dev/null | normalized_ruleset)" != "$(normalized_ruleset "$WORK/snapshot/ruleset.nft")" ]]; then
      { echo 'flush ruleset'; cat "$WORK/snapshot/ruleset.nft"; } >"$WORK/restore.nft"
      nft -f "$WORK/restore.nft" || leftovers+=("nftables ruleset restore failed")
    fi
  elif [[ -f "$WORK/snapshot/ruleset.iptables" ]] && command -v iptables-restore >/dev/null; then
    iptables-restore <"$WORK/snapshot/ruleset.iptables" || leftovers+=("iptables restore failed")
  fi
  if [[ -s "$WORK/snapshot/ip_forward" && "$(sysctl -n net.ipv4.ip_forward 2>/dev/null)" != "$(cat "$WORK/snapshot/ip_forward")" ]]; then
    sysctl -qw "net.ipv4.ip_forward=$(cat "$WORK/snapshot/ip_forward")"
  fi

  if [[ -s "$WORK/snapshot/preexisting" ]]; then
    (cd / && xargs -r -d '\n' rm -rf <"$WORK/snapshot/preexisting")
    tar -C / -xpf "$WORK/snapshot/preexisting.tar" 2>>"$WORK/logs/cleanup-restore.log" ||
      leftovers+=("restoring pre-existing product files failed")
  fi

  # Verify.
  if [[ -s "$WORK/snapshot/preexisting" && "$(preexisting_manifest)" != "$(cat "$WORK/snapshot/preexisting.manifest")" ]]; then
    leftovers+=("pre-existing product files differ: $(diff <(cat "$WORK/snapshot/preexisting.manifest") <(preexisting_manifest) | grep '^[<>]' | head -n 5 | tr '\n' ' ')")
  fi
  for pkg in "${purge[@]}"; do
    [[ "$(dpkg-query -W -f='${db:Status-Status}' "$pkg" 2>/dev/null)" == installed ]] && leftovers+=("package ${pkg}")
  done
  for dir in "${SNAPSHOT_DIRS[@]}"; do
    for entry in $(new_entries "$dir" | grep -E "$PRODUCT_ENTRY"); do
      leftovers+=("${dir}/${entry}")
    done
  done
  [[ -e "$INSTALL_DIR" ]] && leftovers+=("$INSTALL_DIR")
  for link in $(comm -13 "$WORK/snapshot/links" <(host_links)); do
    leftovers+=("interface ${link}")
  done
  if [[ -f "$WORK/snapshot/ruleset.nft" ]] && command -v nft >/dev/null &&
    [[ "$(nft list ruleset 2>/dev/null | normalized_ruleset)" != "$(normalized_ruleset "$WORK/snapshot/ruleset.nft")" ]]; then
    leftovers+=("nftables ruleset differs")
  fi
  free_run_ports
  for port in 3000 9443 80 443 "$WEB_PORT" "$FEED_PORT" 53; do
    port_conflicts "$port" && leftovers+=("listener on port ${port}")
  done
  if ((${#leftovers[@]})); then
    fail "host restored" "left: ${leftovers[*]}"
  else
    pass "host restored" "purged ${#purge[@]} packages; product files, units, Docker state and network rules removed; $(grep -c . "$WORK/snapshot/preexisting") pre-existing product entries put back"
  fi
  CLEANED=1
}

# ── Preflight ─────────────────────────────────────────────────────────

# Whether a listener takes a port this run binds. The DNS guard binds only HOST_ADDR:53, so a resolver stub that listens
# on a loopback address alone (systemd-resolved on 127.0.0.53 and 127.0.0.54) is no conflict; every other port is
# bound on all addresses. Every return names its status: the cleanup runs this from the EXIT trap, where a bare
# `return` gives the status of the command before the trap (the run's `exit 0`), which made every port look taken.
port_conflicts() {
  local port="$1" address listeners
  if [[ "$port" != 53 ]]; then
    listeners="$(ss -Hltnu "( sport = :${port} )" 2>/dev/null)"
    [[ -n "$listeners" ]] && return 0
    return 1
  fi
  while read -r address; do
    address="${address%:53}"
    address="${address#[}"
    address="${address%]}"
    address="${address%%%*}"
    case "$address" in
      127.* | ::1) ;;
      *) return 0 ;;
    esac
  done < <(ss -Hltnu "( sport = :53 )" 2>/dev/null | awk '{print $5}')
  return 1
}

# Waits (at most 60 s) until nothing listens on a port this run binds any more, once everything else is torn down:
# docker-proxy, nginx or the run's own background servers can take a few seconds to exit after their service stopped
# or their package was purged. A listener that stays and was started after the run began (a rollback that left the
# stack half-replaced) is stopped; nothing that was on the host before is touched. Every pass is logged.
free_run_ports() {
  local port pid started now start_epoch deadline busy log="$WORK/logs/cleanup-ports.log"
  start_epoch="$(cat "$WORK/snapshot/start-epoch" 2>/dev/null || echo 0)"
  deadline=$((SECONDS + 60))
  echo "$(date -u +%T) listeners when the cleanup checks the run's ports:" >>"$log"
  ss -Hltnup >>"$log" 2>&1
  while :; do
    busy=()
    for port in 3000 9443 80 443 "$WEB_PORT" "$FEED_PORT" 53; do
      port_conflicts "$port" && busy+=("$port")
    done
    if ((${#busy[@]} == 0)); then
      echo "$(date -u +%T) all of the run's ports are free" >>"$log"
      return 0
    fi
    ((SECONDS < deadline)) || break
    now="$(date +%s)"
    for port in "${busy[@]}"; do
      for pid in $(ss -Hltnup "( sport = :${port} )" 2>/dev/null | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u); do
        started=$((now - $(ps -o etimes= -p "$pid" 2>/dev/null || echo "$now")))
        ((started >= start_epoch)) || continue
        echo "$(date -u +%T) port ${port}: stopping pid ${pid} ($(ps -o comm= -p "$pid" 2>/dev/null))" >>"$log"
        kill "$pid" 2>/dev/null
      done
    done
    sleep 2
  done
  echo "$(date -u +%T) still listening after 60 s on ${busy[*]}:" >>"$log"
  ss -Hltnup >>"$log" 2>&1
  for port in "${busy[@]}"; do
    echo "port ${port}: $(ss -Hltnu "( sport = :${port} )" 2>&1 | head -n 3)" >>"$log"
  done
}

# Whether the base release rewrites retired scope names to their current ones when they are granted (from 2.11.0).
base_translates_retired_scopes() {
  local major minor
  IFS=. read -r major minor _ <<<"${BASE#v}"
  ((major > 2 || (major == 2 && minor >= 11)))
}

preflight() {
  local tool port missing=()
  [[ "$(id -u)" == 0 ]] || { echo "Run as root (or use --ssh)." >&2; exit 2; }
  [[ "$CANDIDATE" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-rc\.[0-9]+)?$ ]] || { echo "--candidate vX.Y.Z[-rc.N] is required." >&2; exit 2; }
  [[ "$BASE" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "--base must be a stable vX.Y.Z tag." >&2; exit 2; }
  [[ "$LICENSE_MODE" =~ ^(block|block-all|allow)$ ]] || { echo "--license-server must be block, block-all or allow." >&2; exit 2; }
  for tool in python3 curl openssl dpkg-query apt-get systemctl ip ss setsid tar sha256sum; do
    command -v "$tool" >/dev/null || missing+=("$tool")
  done
  ((${#missing[@]} == 0)) || { echo "Missing tools: ${missing[*]}" >&2; exit 2; }
  if [[ -z "$HOST_ADDR" ]]; then
    HOST_ADDR="$(ip -o -4 route get 1.1.1.1 2>/dev/null | sed -nE 's/.* src ([0-9.]+).*/\1/p')"
  fi
  [[ "$HOST_ADDR" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "Cannot determine the host address; pass --host-address." >&2; exit 2; }
  [[ ! -e "$INSTALL_DIR" ]] || { echo "${INSTALL_DIR} exists; this run needs a host without Gateway." >&2; exit 2; }
  for port in 3000 9443 80 443 "$WEB_PORT" "$FEED_PORT" 53; do
    if port_conflicts "$port"; then
      echo "Port ${port} is in use; this run needs it." >&2
      exit 2
    fi
  done
}

# ── Install and setup ─────────────────────────────────────────────────

setup_request() {
  local path="$1" body="${2:-}"
  [[ -n "$body" ]] || body='{}'
  RESP="$WORK/resp.json"
  CODE="$(curl_code -ksS -m 120 -o "$RESP" -w '%{http_code}' -b "$WORK/setup.jar" -c "$WORK/setup.jar" \
    -H 'Content-Type: application/json' -H "X-CSRF-Token: ${SETUP_CSRF}" --data-binary "$body" "$API/api/setup$path")"
}

run_installer() {
  local label="$1" script="$2" start=$SECONDS status app
  say "running the ${label} installer (log: logs/install-${label}.out)"
  env TERM=dumb RELEASES_API_URL="http://${HOST_ADDR}:${FEED_PORT}/releases" GATEWAY_INSTALL_DIR="$INSTALL_DIR" \
    GATEWAY_INSTALL_LOG_FILE="$WORK/logs/install-${label}.detail.log" \
    timeout 1500 bash "$script" --https </dev/null >"$WORK/logs/install-${label}.out" 2>&1
  status=$?
  TIMING["install ${label}"]="$((SECONDS - start)) s"
  sed -i 's/\x1b\[[0-9;]*[A-Za-z]//g' "$WORK/logs/install-${label}.out"
  SETUP_CODE="$(grep -oE 'gws_[A-Za-z0-9_-]+' "$WORK/logs/install-${label}.out" | tail -n1)"
  check "${label} installer" "exit ${status} in $((SECONDS - start)) s; $(grep -oE '(Version|Mode): +[^│]+' "$WORK/logs/install-${label}.out" | tr -s ' ' | tr '\n' ';')" \
    test "$status" = 0 || { tail -n 15 "$WORK/logs/install-${label}.out"; return 1; }
  app="$(docker ps -q --filter label=com.docker.compose.service=app --filter "label=com.docker.compose.project.working_dir=${INSTALL_DIR}" | head -n1)"
  PROJECT="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$app" 2>/dev/null)"
  [[ -n "$PROJECT" ]] || PROJECT="$(basename "$INSTALL_DIR")"
  echo "$PROJECT" >"$WORK/project"
  check "setup code printed" "${SETUP_CODE:0:8}…" test -n "$SETUP_CODE"
}

# The wizard needs a verified SMTP server for password sign-in: Mailpit with its own CA, trusted
# through NODE_EXTRA_CA_CERTS. The app reads releases from the local feed.
prepare_stack() {
  local app net
  app="$(service_id app)"
  net="$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{"\n"}}{{end}}' "$app" | head -n1)"
  docker rm -f gateway-e2e-mailpit >/dev/null 2>&1
  docker run -d --name gateway-e2e-mailpit --restart unless-stopped --network "$net" --network-alias mailpit \
    -v "$WORK/smtp:/certs:ro" -e MP_SMTP_TLS_CERT=/certs/cert.pem -e MP_SMTP_TLS_KEY=/certs/key.pem \
    -e MP_SMTP_REQUIRE_STARTTLS=true -e MP_SMTP_AUTH_ACCEPT_ANY=true "$MAILPIT_IMAGE" >/dev/null 2>>"$WORK/logs/docker.log" ||
    { fail "Mailpit started" "see logs/docker.log"; return 1; }
  docker cp "$WORK/smtp/ca.pem" "${app}:/var/lib/gateway/e2e-smtp-ca.pem" >/dev/null || { fail "SMTP CA copied" "$app"; return 1; }
  env_set RELEASES_API_URL "http://${HOST_ADDR}:${FEED_PORT}/releases"
  env_set NODE_EXTRA_CA_CERTS /var/lib/gateway/e2e-smtp-ca.pem
  dc up -d app >>"$WORK/logs/compose.log" 2>&1
  wait_for 300 "Gateway health" api_healthy || { fail "Gateway healthy after the .env change" ""; return 1; }
}

complete_setup() {
  local label="$1"
  : >"$WORK/setup.jar"
  SETUP_CSRF=""
  setup_request /unlock "$(mkjson '{"code": a[0]}' "$SETUP_CODE")"
  SETUP_CSRF="$(jx "$RESP" 'D["csrfToken"]')"
  check "${label} setup unlock" "HTTP ${CODE}" test "$CODE" = 200 -a -n "$SETUP_CSRF" || return 1
  setup_request /wizard/apply "$(mkjson '{"publicUrl": a[0], "network": {"grpcPublicTarget": a[1] + ":9443", "grpcLocalIp": a[1]},
    "auth": {"methods": {"oidc": False, "password": True, "emailOtp": False},
             "smtp": {"host": "mailpit", "port": 1025, "tlsMode": "starttls", "username": "e2e", "password": "e2e-smtp-password",
                      "senderName": "Gateway E2E", "senderEmail": "gateway@e2e.test"}},
    "administrator": {"name": "E2E Admin", "email": a[2], "authMethod": "password", "password": a[3]},
    "logging": {"mode": "disabled"}}' "$PUBLIC_URL" "$HOST_ADDR" "$ADMIN_EMAIL" "$ADMIN_PASSWORD")"
  check "${label} setup apply" "HTTP ${CODE} $(short "$RESP" 200)" test "$CODE" = 200 || return 1
  setup_request /wizard/license/community '{}'
  check "${label} setup chooses Community" "HTTP ${CODE}; status $(jx "$RESP" 'D["status"]'), registration $(jx "$RESP" 'D["registrationStatus"]')" \
    test "$CODE" = 200 || return 1
  setup_request /wizard/complete '{"status":"skipped"}'
  check "${label} setup complete" "HTTP ${CODE} $(short "$RESP" 120)" test "$CODE" = 200 || return 1
  sleep 5
  wait_for 300 "Gateway health after setup" api_healthy || { fail "${label} healthy after setup" ""; return 1; }
  wait_for 120 "administrator sign-in" login_admin
  api GET /auth/me
  check "${label} first sign-in" "HTTP ${CODE}; group $(jx "$RESP" 'D["groupName"]'), $(jx "$RESP" 'len(D["groupScopes"])') scopes" \
    test "$CODE" = 200
}

node_status() {
  api GET "/api/nodes/$1"
  [[ "$CODE" == 200 ]] || return 1
  printf '%s %s\n' "$(jx "$RESP" 'D["status"]')" "$(jx "$RESP" 'D.get("daemonVersion")')"
}
node_online() { [[ "$(node_status "$1" | cut -d' ' -f1)" == online ]]; }
node_online_with() { [[ "$(node_status "$1")" == "online $2" ]]; }

install_node() {
  local type="$1" label="$2" script="$3" start=$SECONDS id token fp status
  shift 3
  api POST /api/nodes "$(mkjson '{"type": a[0], "hostname": a[1], "displayName": a[2]}' "$type" "e2e-${type}" "E2E ${label}")"
  keep_json "node-${type}"
  id="$(jx "$RESP" 'D["node"]["id"]')"
  token="$(jx "$RESP" 'D["enrollmentToken"]')"
  fp="$(jx "$RESP" 'D["gatewayCertSha256"]')"
  check "${label} node created" "HTTP ${CODE}" test "$CODE" = 201 -a -n "$id" || return 1
  FACT["${type}_node"]="$id"
  say "installing the ${BASE} ${label} node daemon (log: logs/node-${type}.out)"
  env TERM=dumb timeout 1500 bash "$script" -y --no-logo --version "$BASE" "$@" --gateway "${HOST_ADDR}:9443" \
    --token "$token" --gateway-cert-sha256 "$fp" </dev/null >"$WORK/logs/node-${type}.out" 2>&1
  status=$?
  sed -i 's/\x1b\[[0-9;]*[A-Za-z]//g' "$WORK/logs/node-${type}.out"
  check "${label} node installer" "exit ${status} in $((SECONDS - start)) s" test "$status" = 0 ||
    { tail -n 15 "$WORK/logs/node-${type}.out"; return 1; }
  wait_for 180 "${label} node online" node_online_with "$id" "$BASE"
  check "${label} node online on ${BASE}" "$(node_status "$id")" node_online_with "$id" "$BASE"
}

route_ok() {
  [[ "$(curl_code -ks -m 5 -o /dev/null -w '%{http_code}' --resolve "${ROUTE_DOMAIN}:443:127.0.0.1" "https://${ROUTE_DOMAIN}/")" == 200 ]]
}

proxy_health() {
  api GET "/api/proxy-hosts/${FACT[proxy]}"
  jx "$RESP" 'D.get("effectiveHealthStatus") or D.get("healthStatus")'
}
proxy_online() { [[ "$(proxy_health)" == online ]]; }

access_snapshot() {
  local out="$1"
  api GET "/api/admin/groups/${FACT[group]}"
  cp "$RESP" "$WORK/json/${out}-group.json"
  api GET /api/admin/users
  cp "$RESP" "$WORK/json/${out}-users.json"
  api GET /api/tokens
  cp "$RESP" "$WORK/json/${out}-tokens.json"
  python3 "$WORK/py/access.py" snapshot "$WORK/json/${out}-group.json" "$WORK/json/${out}-users.json" \
    "$WORK/json/${out}-tokens.json" "$OPERATOR_EMAIL" e2e-token "$WORK/json/access-${out}.json"
}

# ── Phase 1: base install and seed ────────────────────────────────────

phase1_base() {
  local installer="$WORK/install-${BASE}.sh" docker_script="$WORK/setup-docker-node-${BASE}.sh" nginx_script="$WORK/setup-node-${BASE}.sh"
  local requested missing cid src
  phase 1 "Install ${BASE} and seed state"
  # A base without a relay release of its own (2.11.3) installs the newest stable relay, as a customer's install did.
  if curl -fsS -m 20 -o /dev/null -H 'Accept: application/vnd.github+json' "https://api.github.com/repos/${REPO}/releases/tags/${BASE}-relay" 2>/dev/null; then
    feed_pin stable "gateway=${BASE}" "relay=${BASE}-relay"
  else
    feed_pin stable "gateway=${BASE}"
  fi
  curl -fsSL "${RAW_BASE}/${BASE}/scripts/install.sh" -o "$installer" &&
    curl -fsSL "${RELEASE_DOWNLOAD}/${BASE}/setup-docker-node.sh" -o "$docker_script" &&
    curl -fsSL "${RELEASE_DOWNLOAD}/${BASE}/setup-node.sh" -o "$nginx_script"
  check "${BASE} installers downloaded" "install.sh sha256 $(sha256sum "$installer" | cut -c1-12), setup-docker-node.sh, setup-node.sh" \
    test -s "$installer" -a -s "$docker_script" -a -s "$nginx_script" || return 1

  run_installer base "$installer" || return 1
  FACT[base_image]="$(grep '^GATEWAY_IMAGE_REF=' "$INSTALL_DIR/.env" | cut -d= -f2-)"
  prepare_stack || return 1
  check_license_guard
  complete_setup base || return 1
  api GET /api/system/version
  check "API reports ${BASE}" "currentVersion $(jx "$RESP" 'D["currentVersion"]'), relay $(jx "$RESP" 'D["relay"]["currentVersion"]')" \
    test "$(jx "$RESP" 'D["currentVersion"]')" = "$BASE"

  # The base updater's own rollback for phase 4, taken from the code the base runs.
  # Rendered by the base's own code with node in its app container, so phase 4 runs exactly what the base runs.
  docker cp "$WORK/py/sidecar-render.cjs" "$(service_id app):/tmp/gateway-e2e-sidecar-render.cjs" >/dev/null 2>&1
  for src in $(docker exec "$(service_id app)" sh -c 'grep -rl "trap on_exit EXIT" /app/packages/backend/dist 2>/dev/null' | grep -v '\.test\.js$' | grep '\.js$'); do
    docker exec "$(service_id app)" node /tmp/gateway-e2e-sidecar-render.cjs "$src" "$PROJECT" "$INSTALL_DIR" \
      >"$WORK/json/base-sidecar.json" 2>"$WORK/logs/sidecar-extract.log" &&
      FACT[sidecar_image]="$(jx "$WORK/json/base-sidecar.json" 'D["image"]')" &&
      jx "$WORK/json/base-sidecar.json" 'D["script"]' >"$WORK/rollback-functions-${BASE}.sh" &&
      break
    FACT[sidecar_image]=""
  done
  # The update body is replaced by a forced failure. A base that snapshots the database before the update (2.11.0 on)
  # restores the snapshot the update really took (captured in phase 2), as it does after a failed health gate.
  if grep -q '^snapshot_database()' "$WORK/rollback-functions-${BASE}.sh" 2>/dev/null; then
    FACT[base_snapshots]=1
  fi
  check "base rollback() rendered by the base" "${src#/app/packages/backend/} -> rollback-functions-${BASE}.sh; sidecar image ${FACT[sidecar_image]%%@*}; database snapshot: ${FACT[base_snapshots]:-0} $(tail -n 3 "$WORK/logs/sidecar-extract.log" 2>/dev/null)" \
    test -n "${FACT[sidecar_image]}"

  if [[ -n "$LICENSE_KEY" ]]; then
    api POST /api/system/license/activate "$(mkjson '{"licenseKey": a[0]}' "$LICENSE_KEY")"
    [[ "$CODE" == 200 ]] && FACT[license_activated]=1
    check "paid license activated on ${BASE}" "HTTP ${CODE}; plan $(jx "$RESP" 'D["plan"]'), status $(jx "$RESP" 'D["status"]')" \
      test "$CODE" = 200 -a "$(jx "$RESP" 'D["plan"]')" != community || return 1
  fi
  if [[ "$CHANNEL" == preview ]]; then
    api PUT /api/admin/auth-settings '{"generalSettings":{"updateChannel":"preview"}}'
    check "update channel set to preview" "HTTP ${CODE}" test "$CODE" = 200 || return 1
  fi

  install_node docker Docker "$docker_script" || return 1
  install_node nginx Nginx "$nginx_script" --nginx-mode managed || return 1
  check "node installers kept the license guard in daemon.json" \
    "$(python3 -c 'import json;c=json.load(open("/etc/docker/daemon.json"));print("dns", c.get("dns"), "runtimes", sorted(c.get("runtimes", {})))' 2>&1)" \
    grep -q "\"${HOST_ADDR}\"" /etc/docker/daemon.json

  api POST "/api/docker/nodes/${FACT[docker_node]}/images/pull-sync" "$(mkjson '{"imageRef": a[0]}' "$WEB_IMAGE")"
  check "image pulled through Gateway" "HTTP ${CODE} ${WEB_IMAGE}" test "$CODE" = 200 || return 1
  api POST "/api/docker/nodes/${FACT[docker_node]}/containers" "$(mkjson '{"image": a[0], "name": "e2e-web",
    "ports": [{"hostPort": int(a[1]), "containerPort": 80}], "restartPolicy": "unless-stopped", "env": {"E2E": "1"}}' "$WEB_IMAGE" "$WEB_PORT")"
  cid="$(jx "$RESP" 'D["id"]')"
  check "container created through Gateway" "HTTP ${CODE} ${cid:0:12}" test "$CODE" = 201 -a -n "$cid" || return 1
  FACT[container]="$cid"
  api POST "/api/docker/nodes/${FACT[docker_node]}/containers/${cid}/start"
  wait_for 60 "container port ${WEB_PORT}" curl -fs -m 3 -o /dev/null "http://127.0.0.1:${WEB_PORT}/"
  FACT[container_identity]="$(container_identity e2e-web)"
  check "container serves" "start HTTP ${CODE}; $(cut -c1-12 <<<"${FACT[container_identity]}")" \
    curl -fs -m 3 -o /dev/null "http://127.0.0.1:${WEB_PORT}/" || return 1

  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 90 -subj "/CN=${ROUTE_DOMAIN}" \
    -addext "subjectAltName=DNS:${ROUTE_DOMAIN}" -keyout "$WORK/site.key" -out "$WORK/site.pem" 2>/dev/null
  api POST /api/ssl-certificates/upload "$(mkjson '{"name": "e2e-app-cert", "certificatePem": read(a[0]), "privateKeyPem": read(a[1])}' "$WORK/site.pem" "$WORK/site.key")"
  FACT[cert]="$(jx "$RESP" 'D["id"]')"
  check "certificate uploaded" "HTTP ${CODE} ${FACT[cert]}" test -n "${FACT[cert]}" || return 1

  api POST /api/proxy-hosts "$(mkjson '{"type": "proxy", "nodeId": a[0], "domainNames": [a[1]], "upstreamKind": "manual",
    "forwardHost": a[2], "forwardPort": int(a[3]), "forwardScheme": "http", "sslEnabled": True, "sslCertificateId": a[4],
    "healthCheckEnabled": True, "healthCheckUrl": "/", "healthCheckInterval": 30, "healthCheckExpectedStatus": 200}' \
    "${FACT[nginx_node]}" "$ROUTE_DOMAIN" "$HOST_ADDR" "$WEB_PORT" "${FACT[cert]}")"
  FACT[proxy]="$(jx "$RESP" 'D["id"]')"
  check "proxy host created" "HTTP ${CODE} ${FACT[proxy]}" test -n "${FACT[proxy]}" || return 1
  wait_for 120 "route ${ROUTE_DOMAIN}" route_ok
  check "route serves through the nginx node" "https://${ROUTE_DOMAIN} via 127.0.0.1:443" route_ok || return 1
  touch "$WORK/route-ready"
  wait_for 150 "proxy host health" proxy_online
  check "proxy host health check online" "$(proxy_health)" proxy_online
  seed_secure_links

  requested=("${GROUP_SCOPES_PLAIN[@]}" "nodes:config:edit:${FACT[nginx_node]}" "docker:volumes:create:${FACT[docker_node]}"
    "proxy:advanced:bypass:${FACT[proxy]}")
  api POST /api/admin/groups "$(mkjson '{"name": "e2e-operators", "description": "E2E group with retired scope names", "scopes": a}' "${requested[@]}")"
  FACT[group]="$(jx "$RESP" 'D["id"]')"
  if base_translates_retired_scopes; then
    # A base from 2.11.0 on stores the current names of the retired ones it is given (scopes-aliases.ts): it keeps
    # every other requested scope as it is and no retired name; the later checks then prove the derived names.
    missing="$(jx "$RESP" '[s for s in args[:args.index("--")] if not any(s == r or s.startswith(r + ":") for r in args[args.index("--") + 1:]) and s not in D["scopes"]] + [s for s in D["scopes"] if any(s == r or s.startswith(r + ":") for r in args[args.index("--") + 1:])]' \
      "${requested[@]}" -- "${RETIRED_SCOPES[@]}")"
  else
    missing="$(jx "$RESP" '[s for s in args if s not in D["scopes"]]' "${requested[@]}")"
  fi
  check "custom group created with retired scopes" "HTTP ${CODE}; ${#requested[@]} scopes, not stored as expected: ${missing:-unknown}" \
    test -n "${FACT[group]}" -a "$missing" = "[]" || return 1

  api POST /api/admin/users "$(mkjson '{"email": a[0], "name": "E2E Operator", "groupIds": [a[1]], "authMethod": "password"}' "$OPERATOR_EMAIL" "${FACT[group]}")"
  FACT[operator]="$(jx "$RESP" 'D["id"]')"
  check "operator user created in the group" "HTTP ${CODE} ${FACT[operator]}" test -n "${FACT[operator]}" || return 1
  api PUT "/api/admin/users/${FACT[operator]}/additional-permissions" "$(mkjson '{"additionalScopes": a}' "${OPERATOR_ADDITIONAL_SCOPES[@]}")"
  check "operator additional scopes" "HTTP ${CODE}: ${OPERATOR_ADDITIONAL_SCOPES[*]}" test "$CODE" = 200 || return 1

  api POST /api/tokens "$(mkjson '{"name": "e2e-token", "scopes": a}' "${TOKEN_SCOPES[@]}")"
  TOKEN="$(jx "$RESP" 'D["token"]')"
  check "API token created" "HTTP ${CODE} ${TOKEN:0:10}… $([[ -n "$TOKEN" ]] || short "$RESP" 200)" test -n "$TOKEN" || return 1

  api POST /api/notifications/webhooks '{"name":"e2e-webhook","url":"https://example.com/gateway-e2e-webhook","method":"POST","enabled":true,"signingSecret":"e2e-signing-secret-123"}'
  FACT[webhook]="$(jx "$RESP" 'D["id"]')"
  check "webhook created" "HTTP ${CODE} ${FACT[webhook]}" test -n "${FACT[webhook]}" || return 1
  api POST /api/notifications/alert-rules "$(mkjson '{"name": "e2e-node-offline", "enabled": True, "type": "event", "category": "node",
    "severity": "critical", "eventPattern": "offline", "webhookIds": [a[0]], "cooldownSeconds": 300}' "${FACT[webhook]}")"
  FACT[rule]="$(jx "$RESP" 'D["id"]')"
  check "alert rule bound to the webhook" "HTTP ${CODE} ${FACT[rule]}" test -n "${FACT[rule]}" || return 1
  seed_alert_history

  say "base access: $(access_snapshot base)"
  check_license_guard
  pass "base state seeded" "group, operator, token, certificate, webhook + rule + delivery, 2 nodes, containers, proxy host, Route Secure Link$([[ -n "${FACT[echo_link]}" ]] && echo ', container link')"
}

# ── 2.11.4 path: Secure Link, alerts, folders, launcher, logs ─────────

# One script for every helper workload (MODE): `http` serves /ok, a deterministic /blob at ?rate= bytes per second and
# a chunked /stream of numbered lines; `echo` echoes TCP on 7000; `echo-client` keeps one TCP connection to
# TARGET:7000, checks every echo and prints CUT <epoch> on each failure (then reconnects).
WORKLOAD_IMAGE="python:3.12-alpine"
SECURE_LINK_DOMAIN="sl.e2e.test"
BLOB_BYTES=33554432
BLOB_SEED=20261010
BLOB_RATE=196608
# Warnings and errors this environment causes on purpose; every other warning or error line fails the log check.
LOG_ALLOW=(
  # The DNS guard answers NXDOMAIN for the license server outside update windows (see --license-server).
  'license[^"]*(ENOTFOUND|EAI_AGAIN|getaddrinfo|fetch failed|unreachable)'
  'ENOTFOUND license\.(thesqlabs\.com|opfield\.dev)'
  # The seeded webhook points at example.com, which does not accept the POST.
  'gateway-e2e-webhook'
  # The run's own refusal probes: a folder-limited token at the top level, a daemon update to the version it runs.
  'Managing top-level folders and ungrouped items requires proxy:folders:manage'
  '"path":"/api/proxy-host-folders".*"status":403'
  'NO_UPDATE_AVAILABLE'
  '"path":"/api/system/daemon-updates/[^"]*".*"status":409'
  # An unprivileged LXC host has no loop devices for disk-image volumes.
  'disk-image volume support unavailable.*loop-control'
  # The base daemons' own warnings while they are replaced (old code; lines of base processes are tagged
  # `daemon(base):` by check_logs, so the same warning from a candidate process still fails).
  '^daemon\(base\): .*"msg":"relay endpoint registration disconnected".*endpoint policy was revoked'
  '^daemon\(base\): .*"msg":"proxy secure-link streams failing".*resume rejected'
)

workload_script() {
  cat <<'PY'
import os, random, socket, threading, time
MODE = os.environ['MODE']
if MODE == 'http':
    import http.server
    SIZE = int(os.environ['BLOB_BYTES'])
    DATA = random.Random(int(os.environ['BLOB_SEED'])).randbytes(SIZE)
    class H(http.server.BaseHTTPRequestHandler):
        protocol_version = 'HTTP/1.1'
        def log_message(self, *a):
            pass
        def head(self, length=None, kind='text/plain'):
            self.send_response(200)
            self.send_header('Content-Type', kind)
            self.send_header('X-Accel-Buffering', 'no')
            if length is None:
                self.send_header('Transfer-Encoding', 'chunked')
            else:
                self.send_header('Content-Length', str(length))
            self.end_headers()
        def do_GET(self):
            path, _, query = self.path.partition('?')
            args = dict(p.split('=', 1) for p in query.split('&') if '=' in p)
            if path == '/ok':
                self.head(3)
                self.wfile.write(b'ok\n')
            elif path == '/blob':
                rate = int(args.get('rate', '262144'))
                chunk = max(4096, rate // 10)
                self.head(SIZE, 'application/octet-stream')
                for i in range(0, SIZE, chunk):
                    self.wfile.write(DATA[i:i + chunk])
                    time.sleep(chunk / rate)
            elif path == '/stream':
                end = time.time() + int(args.get('seconds', '600'))
                self.head()
                n = 0
                while time.time() < end:
                    line = ('%d %.3f\n' % (n, time.time())).encode()
                    self.wfile.write(b'%x\r\n%s\r\n' % (len(line), line))
                    self.wfile.flush()
                    n += 1
                    time.sleep(0.5)
                self.wfile.write(b'0\r\n\r\n')
            else:
                self.send_response(404)
                self.send_header('Content-Length', '0')
                self.end_headers()
    http.server.ThreadingHTTPServer(('', 8080), H).serve_forever()
elif MODE == 'echo':
    s = socket.socket()
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.bind(('', 7000))
    s.listen(64)
    def serve(c):
        with c:
            while True:
                d = c.recv(65536)
                if not d:
                    return
                c.sendall(d)
    while True:
        c, _ = s.accept()
        threading.Thread(target=serve, args=(c,), daemon=True).start()
else:
    n = 0
    while True:
        try:
            c = socket.create_connection((os.environ['TARGET'], 7000), timeout=5)
            c.settimeout(10)
            print('CONNECTED %.3f' % time.time(), flush=True)
            while True:
                msg = ('%d\n' % n).encode()
                c.sendall(msg)
                got = b''
                while len(got) < len(msg):
                    d = c.recv(len(msg) - len(got))
                    if not d:
                        raise OSError('closed by peer')
                    got += d
                if got != msg:
                    raise OSError('echo mismatch')
                n += 1
                if n % 120 == 0:
                    print('OK %d %.3f' % (n, time.time()), flush=True)
                time.sleep(0.5)
        except Exception as e:
            print('CUT %.3f %s' % (time.time(), e), flush=True)
            time.sleep(1)
PY
}

# create_workload NAME MODE [KEY=VALUE...]: creates and starts a helper container on the docker node through Gateway.
create_workload() {
  local name="$1" mode="$2" script
  shift 2
  script="$(workload_script | base64 -w0)"
  api POST "/api/docker/nodes/${FACT[docker_node]}/containers" "$(mkjson '{"image": a[0], "name": a[1], "restartPolicy": "unless-stopped",
    "env": dict([("MODE", a[2]), ("E2E_SCRIPT", a[3]), ("BLOB_BYTES", a[4]), ("BLOB_SEED", a[5])] + [p.split("=", 1) for p in a[6:]]),
    "command": ["sh", "-c", "echo \"$E2E_SCRIPT\" | base64 -d > /tmp/e2e.py && exec python3 -u /tmp/e2e.py"]}' \
    "$WORKLOAD_IMAGE" "$name" "$mode" "$script" "$BLOB_BYTES" "$BLOB_SEED" "$@")"
  [[ "$CODE" == 201 ]] || return 1
  api POST "/api/docker/nodes/${FACT[docker_node]}/containers/$(jx "$RESP" 'D["id"]')/start"
  [[ "$CODE" =~ ^2 ]]
}

sl_get() { curl -fsS -m "${2:-5}" --resolve "${SECURE_LINK_DOMAIN}:80:127.0.0.1" "http://${SECURE_LINK_DOMAIN}$1"; }
sl_ok() { [[ "$(sl_get /ok 2>/dev/null)" == ok ]]; }

# Base: a Route Secure Link (proxy host -> container on the docker node, no host port) and a container link between
# two containers. Failures here are recorded and the run goes on without the live Secure Link checks.
seed_secure_links() {
  local rc
  api POST "/api/docker/nodes/${FACT[docker_node]}/images/pull-sync" "$(mkjson '{"imageRef": a[0]}' "$WORKLOAD_IMAGE")"
  check "helper image pulled through Gateway" "HTTP ${CODE} ${WORKLOAD_IMAGE}" test "$CODE" = 200 || return 1
  create_workload e2e-sl http
  rc=$?
  check "Secure Link target container started" "HTTP ${CODE} e2e-sl (python, port 8080, no host port) $(short "$RESP" 160)" test "$rc" = 0 || return 1
  api POST /api/proxy-hosts "$(mkjson '{"type": "proxy", "nodeId": a[0], "domainNames": [a[1]], "upstreamKind": "docker_container",
    "dockerNodeId": a[2], "dockerContainerName": "e2e-sl", "dockerContainerPort": 8080, "forwardScheme": "http",
    "sslEnabled": False, "websocketSupport": True}' "${FACT[nginx_node]}" "$SECURE_LINK_DOMAIN" "${FACT[docker_node]}")"
  FACT[sl_proxy]="$(jx "$RESP" 'D["id"]')"
  check "Route Secure Link created (proxy host -> container e2e-sl:8080)" "HTTP ${CODE} ${FACT[sl_proxy]} $([[ -n "${FACT[sl_proxy]}" ]] || short "$RESP" 200)" \
    test -n "${FACT[sl_proxy]}" || return 1
  wait_for 180 "route ${SECURE_LINK_DOMAIN}" sl_ok
  check "Route Secure Link serves" "http://${SECURE_LINK_DOMAIN}/ok via the nginx node -> relay -> docker node" sl_ok || return 1
  FACT[sl_ready]=1
  FACT[sl_identity]="$(container_identity e2e-sl)"
  FACT[blob_sha]="$(python3 -c 'import hashlib,random,sys;print(hashlib.sha256(random.Random(int(sys.argv[2])).randbytes(int(sys.argv[1]))).hexdigest())' "$BLOB_BYTES" "$BLOB_SEED")"

  create_workload e2e-echo echo
  rc=$?
  check "container link target started" "HTTP ${CODE} e2e-echo (TCP echo on 7000) $(short "$RESP" 160)" test "$rc" = 0 ||
    { FACT[echo_skip]="the echo target did not start"; return 0; }
  create_workload e2e-echo-client echo-client TARGET=e2e-echo
  rc=$?
  check "container link consumer started" "HTTP ${CODE} e2e-echo-client $(short "$RESP" 160)" test "$rc" = 0 ||
    { FACT[echo_skip]="the echo client did not start"; return 0; }
  api POST /api/docker/container-links "$(mkjson '{"sourceNodeId": a[0], "sourceType": "container", "sourceResourceId": "e2e-echo-client",
    "targetNodeId": a[0], "targetType": "container", "targetResourceId": "e2e-echo", "targetPort": 7000, "alias": "e2e-echo"}' "${FACT[docker_node]}")"
  if grep -q COMMERCIAL_MODULE_UNAVAILABLE "$RESP" 2>/dev/null; then
    FACT[echo_skip]="container links need the private core (Community answers COMMERCIAL_MODULE_UNAVAILABLE); set GATEWAY_E2E_LICENSE_KEY"
    skip "container link between two containers" "${FACT[echo_skip]}"
    return 0
  fi
  FACT[echo_link]="$(jx "$RESP" 'D["id"]')"
  check "container link created (e2e-echo-client -> e2e-echo:7000)" "HTTP ${CODE} ${FACT[echo_link]} $(short "$RESP" 160)" \
    test -n "${FACT[echo_link]}" || { FACT[echo_skip]="the container link was not created"; return 0; }
  wait_for 120 "echo through the container link" echo_flowing
  check "TCP echo flows through the container link" "$(docker logs e2e-echo-client 2>&1 | grep -E '^(CONNECTED|OK)' | tail -n1)" echo_flowing ||
    FACT[echo_skip]="echo never flowed on the base"
}

echo_flowing() { docker logs e2e-echo-client 2>&1 | grep -q '^OK '; }

# echo_cuts START_MS END_MS: echo failures the client saw in the window.
echo_cuts() {
  docker logs e2e-echo-client 2>&1 | awk -v s="$1" -v e="$2" '$1 == "CUT" && $2 * 1000 >= s && $2 * 1000 <= e' | wc -l
}

# live_start LABEL: a long chunked stream and a throttled byte-exact download through the Route Secure Link.
live_start() {
  local label="$1"
  mkdir -p "$WORK/live"
  rm -f "$WORK/live/${label}".*
  start_background "stream-${label}" sh -c 'curl -sS -N -m 3000 --resolve "$1:80:127.0.0.1" "http://$1/stream?seconds=2400" -o "$2.stream" 2>"$2.stream.err"
    echo "$? $(date +%s%3N)" >"$2.stream.status"' sh "$SECURE_LINK_DOMAIN" "$WORK/live/${label}"
  start_background "blob-${label}" sh -c 'curl -sS -m 1800 --resolve "$1:80:127.0.0.1" "http://$1/blob?rate=$3" -o "$2.blob" 2>"$2.blob.err"
    echo "$? $(date +%s%3N)" >"$2.blob.status"' sh "$SECURE_LINK_DOMAIN" "$WORK/live/${label}" "$BLOB_RATE"
  sleep 5
  FACT["live_${label}_start"]="$(now_ms)"
}

last_update_connections() {
  api GET "/api/nodes/$1"
  jx "$RESP" '(D.get("metadata") or {}).get("lastUpdate", {}).get("connections")'
}
last_update_settled() {
  api GET "/api/nodes/$1"
  [[ "$(jx "$RESP" '(lambda c: bool(c) and str(c.get("toVersion", "")).lstrip("v") == args[0].lstrip("v"))((D.get("metadata") or {}).get("lastUpdate", {}).get("connections"))' "$2")" == true ]]
}

# live_verdict LABEL NODE TARGET: what the clients saw across the update against what the node's last update reports.
live_verdict() {
  local label="$1" node="$2" target="$3" base="$WORK/live/$1" end_ms stream blob echo report seen=0 live=0 sum
  if [[ "${FACT[sl_ready]}" != 1 ]]; then
    skip "${label} daemon update: live Secure Link traffic" "the base Route Secure Link was not set up"
    return 0
  fi
  wait_for 240 "${label} node last update report" last_update_settled "$node" "$target"
  end_ms="$(now_ms)"
  # Stream: still running = kept; ended = cut (it asks for 40 minutes).
  if [[ -f "${base}.stream.status" ]]; then
    stream="cut: curl exit $(cut -d' ' -f1 "${base}.stream.status") after $(wc -l <"${base}.stream" 2>/dev/null) lines ($(short "${base}.stream.err" 120))"
    seen=$((seen + 1))
  else
    stream="kept: $(wc -l <"${base}.stream" 2>/dev/null) lines, last $(tail -n1 "${base}.stream" 2>/dev/null | cut -d' ' -f1), still open"
    live=$((live + 1))
  fi
  # Download: finished byte-exact, visibly cut, or (FAIL) finished with other bytes.
  wait_for 300 "${label} download" test -f "${base}.blob.status"
  sum="$(sha256sum "${base}.blob" 2>/dev/null | cut -d' ' -f1)"
  if [[ "$(cut -d' ' -f1 "${base}.blob.status" 2>/dev/null)" == 0 ]]; then
    blob="complete, $(stat -c %s "${base}.blob") bytes, sha256 ${sum:0:12} (expected ${FACT[blob_sha]:0:12})"
    # A download still running when the node came back was carried across the update.
    [[ "$(cut -d' ' -f2 "${base}.blob.status")" -ge "${FACT[live_${label}_online_ms]:-0}" ]] && live=$((live + 1))
    check "${label} daemon update: download through the Route Secure Link is byte-exact" "$blob" test "$sum" = "${FACT[blob_sha]}"
  else
    blob="cut: curl exit $(cut -d' ' -f1 "${base}.blob.status" 2>/dev/null) after $(stat -c %s "${base}.blob" 2>/dev/null || echo 0) of ${BLOB_BYTES} bytes ($(short "${base}.blob.err" 120))"
    seen=$((seen + 1))
    pass "${label} daemon update: download through the Route Secure Link ended visibly (not silently truncated)" "$blob"
  fi
  if [[ -n "${FACT[echo_link]}" && -z "${FACT[echo_skip]}" ]]; then
    echo="$(echo_cuts "${FACT[live_${label}_start]}" "$end_ms")"
    if [[ "$label" == docker* ]]; then
      if ((echo > 0)); then seen=$((seen + 1)); else live=$((live + 1)); fi
    fi
    echo="container link echo: ${echo} cuts in the window"
  else
    echo="container link echo: not checked (${FACT[echo_skip]:-no link})"
  fi
  stop_background "stream-${label}" "blob-${label}"
  report="$(last_update_connections "$node")"
  echo "$report" >"$WORK/json/last-update-${label}.json"
  api GET "/api/nodes/${node}"
  keep_json "node-${label}-after-update"
  say "${label} update: stream ${stream}; download ${blob}; ${echo}; node reports ${report:-nothing}; serviceRestart: $(jx "$RESP" '(D.get("metadata") or {}).get("lastUpdate", {}).get("serviceRestart")')"
  check "${label} daemon update: node reports its last update's connections" "${report:-no metadata.lastUpdate.connections}" test -n "$report" || return 0
  # Clients cut -> the report counts at least that many cut and never only kept; clients kept -> at least that many kept.
  check "${label} daemon update: reported kept/cut matches the clients (${seen} cut, ${live} kept)" \
    "kept $(window_value "$report" 'D["kept"]'), cut $(window_value "$report" 'D["cut"]'), handover $(window_value "$report" 'D["handover"]')" \
    test "$(window_value "$report" '((D["cut"].get("uncounted", 0) > 0 or sum(D["cut"].values()) >= int(args[0])) and not (D["kept"] > 0 and sum(D["cut"].values()) == 0)) if int(args[0]) else D["kept"] >= int(args[1])' "$seen" "$live")" = true
  if ! base_has_launcher_report; then
    # The base launcher predates launcher self-update: this first update restarts the whole service once.
    check "${label} daemon update from the ${BASE} launcher reported as cuts, not kept" \
      "kept $(window_value "$report" 'D["kept"]'), cut $(window_value "$report" 'D["cut"]'); clients: ${seen} cut, ${live} kept" \
      test "$(window_value "$report" 'D["kept"] == 0 and sum(D["cut"].values()) > 0')" = true
    restart_window "$label" "$node"
  fi
  check "Secure Link target not restarted by the ${label} daemon update" "$(container_identity e2e-sl | cut -d' ' -f2-)" \
    test "$(container_identity e2e-sl)" = "${FACT[sl_identity]}"
}

# restart_window LABEL NODE: after an update from a launcher before 2.11.4 the service restarts once more for the new
# launcher (accepted: one disruption window, two drops ~30 s apart). A stream opened right after the update's cut may
# be cut by that restart, but within RESTART_WINDOW_S of it; a stream opened after the launcher switch is not cut.
RESTART_WINDOW_S=60
restart_window() {
  local label="$1" node="$2" base="$WORK/live/$1-after" opened elapsed
  rm -f "${base}".* "${base}-next".*
  start_background "after-${label}" sh -c 'curl -sS -N -m 900 --resolve "$1:80:127.0.0.1" "http://$1/stream?seconds=600" -o "$2.stream" 2>"$2.stream.err"
    echo "$? $(date +%s%3N)" >"$2.stream.status"' sh "$SECURE_LINK_DOMAIN" "$base"
  opened="$(now_ms)"
  wait_for 150 "${label} launcher switch" launcher_is "$node" "$CANDIDATE"
  sleep 10
  api GET "/api/nodes/${node}"
  keep_json "node-${label}-after-launcher-switch"
  say "${label} after the launcher switch: lastUpdate $(jx "$RESP" '(D.get("metadata") or {}).get("lastUpdate")')"
  if [[ -f "${base}.stream.status" ]]; then
    elapsed=$(( ($(cut -d' ' -f2 "${base}.stream.status") - opened) / 1000 ))
    check "${label} daemon update: one disruption window (the launcher-switch drop within ${RESTART_WINDOW_S} s of the update's cut)" \
      "second drop ${elapsed} s after the first: curl exit $(cut -d' ' -f1 "${base}.stream.status") after $(wc -l <"${base}.stream") lines; launcher $(jx "$RESP" '(D.get("capabilities") or {}).get("launcherVersion")')" \
      test "$elapsed" -le "$RESTART_WINDOW_S"
  else
    pass "${label} daemon update: one disruption window (the launcher-switch drop within ${RESTART_WINDOW_S} s of the update's cut)" \
      "no second drop: $(wc -l <"${base}.stream") lines, still open; launcher $(jx "$RESP" '(D.get("capabilities") or {}).get("launcherVersion")')"
  fi
  check "${label} daemon update: the record shows the launcher-switch restart" \
    "serviceRestart: $(jx "$RESP" '(D.get("metadata") or {}).get("lastUpdate", {}).get("serviceRestart")'); cut $(jx "$RESP" '(D.get("metadata") or {}).get("lastUpdate", {}).get("connections", {}).get("cut")')" \
    test -n "$(jx "$RESP" '(lambda u: u.get("serviceRestart") or ((u.get("connections") or {}).get("cut") or {}).get("service_restart") or None)((D.get("metadata") or {}).get("lastUpdate") or {})')"
  stop_background "after-${label}"
  # No third drop: a stream opened after the launcher switch stays open.
  start_background "next-${label}" sh -c 'curl -sS -N -m 900 --resolve "$1:80:127.0.0.1" "http://$1/stream?seconds=600" -o "$2.stream" 2>"$2.stream.err"
    echo "$? $(date +%s%3N)" >"$2.stream.status"' sh "$SECURE_LINK_DOMAIN" "${base}-next"
  sleep 20
  check "${label} daemon update: no drop after the launcher switch" \
    "$(wc -l <"${base}-next.stream" 2>/dev/null || echo 0) lines in 20 s$([[ -f "${base}-next.stream.status" ]] && echo ", ended: curl exit $(cut -d' ' -f1 "${base}-next.stream.status")")" \
    test ! -f "${base}-next.stream.status"
  stop_background "next-${label}"
}

# Whether the base daemons report their launcher (from 2.11.4 on).
base_has_launcher_report() {
  local major minor patch
  IFS=. read -r major minor patch <<<"${BASE#v}"
  ((major > 2 || (major == 2 && (minor > 11 || (minor == 11 && ${patch%%-*} >= 4)))))
}

# After the daemon updates: the launcher the node runs and whether the next update keeps connections.
check_launcher() {
  local type id launcher handover
  for type in docker nginx; do
    id="${FACT[${type}_node]}"
    wait_for 120 "${type} launcher ${CANDIDATE}" launcher_is "$id" "$CANDIDATE"
    api GET "/api/nodes/${id}"
    launcher="$(jx "$RESP" '(D.get("capabilities") or {}).get("launcherVersion")')"
    check "${type} node details show the ${CANDIDATE#v} launcher" "launcherVersion ${launcher:-unreported}, daemon $(jx "$RESP" 'D.get("daemonVersion")')" \
      test "${launcher#v}" = "${CANDIDATE#v}"
    wait_for 90 "${type} update preview" update_preview_reported "$id"
    handover="$(jx "$RESP" '((D.get("lastHealthReport") or {}).get("updateConnections") or {}).get("handoverAvailable")')"
    check "${type} node: the next daemon update hands connections over" \
      "updateConnections $(jx "$RESP" '{k: v for k, v in ((D.get("lastHealthReport") or {}).get("updateConnections") or {}).items() if k != "lastUpdate"}')" \
      test "$handover" = true
  done
  api POST "/api/system/daemon-updates/${FACT[docker_node]}"
  if [[ "$CODE" =~ ^2 ]]; then
    local target
    target="$(jx "$RESP" 'D["targetVersion"]')"
    [[ "${FACT[sl_ready]}" == 1 ]] && live_start docker-again
    wait_for 300 "docker daemon ${target} again" node_online_with "${FACT[docker_node]}" "$target"
    FACT[live_docker-again_online_ms]="$(now_ms)"
    live_verdict docker-again "${FACT[docker_node]}" "$target"
  else
    skip "re-run the docker daemon update to ${CANDIDATE} (in place)" "the product refuses it: HTTP ${CODE} $(short "$RESP" 160); the next update is judged by handoverAvailable above"
  fi
}

launcher_is() {
  api GET "/api/nodes/$1"
  [[ "$(jx "$RESP" '(D.get("capabilities") or {}).get("launcherVersion")')" == "$2" || "v$(jx "$RESP" '(D.get("capabilities") or {}).get("launcherVersion")')" == "$2" ]]
}

# kill_cut_check LABEL UNIT PATH: a request through the Route Secure Link is running when UNIT is killed (SIGKILL to
# every process of the service). A cut mid-response must reach the client as an error (curl non-zero), never as a
# clean end of a shorter body; a connection the kill does not cut is a SKIP (nothing to judge).
kill_cut_check() {
  local label="$1" unit="$2" path="$3" base="$WORK/live/kill-$1" node="${FACT[${2%-daemon}_node]}" before status
  mkdir -p "$WORK/live"
  rm -f "${base}".*
  start_background "kill-${label}" sh -c 'curl -sS -N -m 900 --resolve "$1:80:127.0.0.1" "http://$1$3" -o "$2.out" 2>"$2.err"
    echo "$? $(date +%s%3N)" >"$2.status"' sh "$SECURE_LINK_DOMAIN" "$base" "$path"
  sleep 8
  before="$(stat -c %s "${base}.out" 2>/dev/null || echo 0)"
  if [[ -f "${base}.status" ]]; then
    fail "${label}: request running before the kill" "ended early: $(cat "${base}.status") $(short "${base}.err" 160)"
    return 0
  fi
  systemctl kill --signal=SIGKILL "$unit"
  say "${label}: killed ${unit} with ${before} bytes received"
  wait_for 90 "${label} client to end" test -f "${base}.status"
  if [[ -f "${base}.status" ]]; then
    status="$(cut -d' ' -f1 "${base}.status")"
    check "${label}: cut mid-response reaches the client as an error"       "curl exit ${status} after $(stat -c %s "${base}.out") bytes ($(short "${base}.err" 140)); $(tail -c 60 "${base}.out" | LC_ALL=C tr -cd '0-9. \n' | tail -n1)"       test "$status" != 0
  else
    skip "${label}: cut mid-response reaches the client as an error" "the kill of ${unit} did not cut the request ($(stat -c %s "${base}.out") bytes, still receiving)"
  fi
  stop_background "kill-${label}"
  wait_for 180 "${unit} back online" node_online "$node"
  check "${label}: node back online after the kill" "$(node_status "$node")" node_online "$node"
  wait_for 120 "route ${SECURE_LINK_DOMAIN}" sl_ok
  check "${label}: Route Secure Link serves again" "http://${SECURE_LINK_DOMAIN}/ok" sl_ok
}

update_preview_reported() {
  api GET "/api/nodes/$1"
  [[ -n "$(jx "$RESP" '((D.get("lastHealthReport") or {}).get("updateConnections") or {}).get("handoverAvailable")')" ]]
}

# Alerts on the base: a test delivery for the history, and the rule and webhook as the base stores them.
seed_alert_history() {
  api POST "/api/notifications/webhooks/${FACT[webhook]}/test"
  say "base webhook test delivery: HTTP ${CODE} $(short "$RESP" 120)"
  api GET "/api/notifications/deliveries?webhookId=${FACT[webhook]}&limit=100"
  jx "$RESP" 'sorted(x["id"] for x in items(d))' >"$WORK/json/base-delivery-ids.json"
  check "base delivery history recorded" "$(jx "$WORK/json/base-delivery-ids.json" 'len(d)') deliveries for e2e-webhook" \
    test "$(jx "$WORK/json/base-delivery-ids.json" 'len(d)')" -ge 1
  alert_snapshot base
}

alert_snapshot() {
  api GET "/api/notifications/alert-rules"
  jx "$RESP" '[{k: r.get(k) for k in ("name", "enabled", "type", "category", "severity", "eventPattern", "webhookIds", "cooldownSeconds")} for r in items(d) if r["id"] == args[0]]' \
    "${FACT[rule]}" >"$WORK/json/rule-$1.json"
  api GET "/api/notifications/webhooks/${FACT[webhook]}"
  jx "$RESP" '{k: D.get(k) for k in ("name", "url", "method", "enabled")}' >"$WORK/json/webhook-$1.json"
}

check_alerts_migrated() {
  local label="$1" rule
  api GET "/api/notifications/alert-rules"
  keep_json "alert-rules-${label// /-}"
  rule="$(jx "$RESP" '[r for r in items(d) if r.get("category") == "gateway" and r.get("eventPattern") == "outbound.unavailable"]')"
  check "${label}: built-in \"Gateway lost outbound connectivity\" rule exists once" \
    "$(window_value "$rule" '[(r.get("name"), r.get("isBuiltin")) for r in D]')" \
    test "$(window_value "$rule" 'len(D) == 1 and D[0].get("name") == "Gateway lost outbound connectivity"')" = true
  check "${label}: built-in rule enabled, marked built-in, bound to the proxy/node rules' webhooks" \
    "$(window_value "$rule" '[(r.get("enabled"), r.get("isBuiltin"), r.get("webhookIds")) for r in D]'), expected webhook ${FACT[webhook]}" \
    test "$(window_value "$rule" 'len(D) == 1 and D[0].get("enabled") is True and D[0].get("isBuiltin") is True and sorted(D[0].get("webhookIds") or []) == [args[0]]' "${FACT[webhook]}")" = true
  alert_snapshot "${label// /-}"
  check "${label}: existing alert rule unchanged" "$(cat "$WORK/json/rule-${label// /-}.json")" \
    cmp -s "$WORK/json/rule-base.json" "$WORK/json/rule-${label// /-}.json"
  check "${label}: existing webhook unchanged" "$(cat "$WORK/json/webhook-${label// /-}.json")" \
    cmp -s "$WORK/json/webhook-base.json" "$WORK/json/webhook-${label// /-}.json"
  api GET "/api/notifications/deliveries?webhookId=${FACT[webhook]}&limit=100"
  check "${label}: delivery history preserved" \
    "base ids missing now: $(jx "$RESP" '[i for i in json.load(open(args[0])) if i not in [x["id"] for x in items(d)]]' "$WORK/json/base-delivery-ids.json")" \
    test "$(jx "$RESP" '[i for i in json.load(open(args[0])) if i not in [x["id"] for x in items(d)]]' "$WORK/json/base-delivery-ids.json")" = "[]"
}

builtin_groups_snapshot() {
  api GET /api/admin/groups
  jx "$RESP" '{g["name"]: sorted(g.get("scopes") or []) for g in items(d) if g.get("isBuiltin")}' >"$WORK/json/builtin-groups-$1.json"
}

# compare_builtin_groups SNAP: the upgraded install's built-in groups against the candidate's fresh install.
compare_builtin_groups() {
  local result
  result="$(python3 - "$WORK/json/builtin-groups-$1.json" "$WORK/json/builtin-groups-fresh.json" <<'PY'
import json, sys
a, b = (json.load(open(p)) for p in sys.argv[1:3])
out = []
for name in sorted(set(a) | set(b)):
    lost, extra = sorted(set(b.get(name, [])) - set(a.get(name, []))), sorted(set(a.get(name, [])) - set(b.get(name, [])))
    if name not in a or name not in b:
        out.append(f'{name}: only in {"fresh" if name in b else "upgraded"}')
    elif lost or extra:
        out.append(f'{name}: missing {lost} extra {extra}')
print('; '.join(out) or f'identical ({", ".join(f"{n} {len(b[n])}" for n in sorted(b))})')
sys.exit(1 if out else 0)
PY
)"
  check "built-in groups after the ${1} match ${CANDIDATE}'s definitions (fresh install)" "$result" \
    python3 -c 'import json,sys;sys.exit(json.load(open(sys.argv[1])) != json.load(open(sys.argv[2])))' \
    "$WORK/json/builtin-groups-$1.json" "$WORK/json/builtin-groups-fresh.json"
}

# A folder-scoped grant created after the update: a token that manages one route folder creates a subfolder in it
# (and one level deeper) and is refused at the top level.
check_folder_grant() {
  local label="$1" folder ftoken sub code
  api POST /api/proxy-host-folders '{"name":"e2e-folder"}'
  folder="$(jx "$RESP" 'D["id"]')"
  check "${label}: route folder created" "HTTP ${CODE} ${folder}" test -n "$folder" || return 0
  api POST /api/tokens "$(mkjson '{"name": "e2e-folder-token", "scopes": ["proxy:view", "proxy:folders:manage:folder/" + a[0]]}' "$folder")"
  ftoken="$(jx "$RESP" 'D["token"]')"
  check "${label}: folder-limited token created" "HTTP ${CODE} scopes $(jx "$RESP" 'D.get("scopes")') $([[ -n "$ftoken" ]] || short "$RESP" 200)" \
    test -n "$ftoken" || return 0
  fapi() { CODE="$(curl_code -ksS -m 30 -o "$WORK/resp.json" -w '%{http_code}' -X POST -H "Authorization: Bearer ${ftoken}" \
    -H 'Content-Type: application/json' --data-binary "$1" "$API/api/proxy-host-folders")"; RESP="$WORK/resp.json"; }
  fapi "$(mkjson '{"name": "e2e-sub", "parentId": a[0]}' "$folder")"
  sub="$(jx "$RESP" 'D["id"]')"
  check "${label}: folder-limited manager creates a subfolder" "HTTP ${CODE} ${sub} $([[ -n "$sub" ]] || short "$RESP" 160)" test -n "$sub"
  if [[ -n "$sub" ]]; then
    fapi "$(mkjson '{"name": "e2e-sub-sub", "parentId": a[0]}' "$sub")"
    check "${label}: folder grant reaches the subfolder's subfolders" "HTTP ${CODE} $(short "$RESP" 160)" test "$CODE" = 201
  fi
  fapi '{"name":"e2e-root-refused"}'
  code="$CODE"
  check "${label}: folder-limited manager refused at the top level" "HTTP ${code} $(short "$RESP" 160)" test "$code" = 403
}

# PIDs of daemon processes that run the base release: those that logged their start on BASE, and those that staged a
# self-update (the process an update replaces; every update this run makes starts from the base).
base_daemon_pids() {
  journalctl -u docker-daemon -u nginx-daemon --no-pager -o json 2>/dev/null | python3 -c '
import json, sys
base, pids = sys.argv[1], set()
for line in sys.stdin:
    try:
        entry = json.loads(line)
    except ValueError:
        continue
    message = entry.get("MESSAGE")
    if not isinstance(message, str):
        continue
    if ("\"msg\":\"starting " in message and ("\"version\":\"%s\"" % base) in message) or "\"msg\":\"starting self-update\"" in message:
        pids.add(entry.get("_PID"))
print(" ".join(sorted(p for p in pids if p)))' "$BASE"
}

# check_logs LABEL SINCE_EPOCH: warnings and errors of the app, the relay and the daemons since SINCE, against LOG_ALLOW.
check_logs() {
  local label="$1" since="$2" out="$WORK/logs/warnings-${1// /-}.txt" bad
  {
    docker logs --since "$since" "$(service_id app)" 2>&1 | sed 's/^/app: /'
    docker logs --since "$since" "$(service_id relay)" 2>&1 | sed 's/^/relay: /'
    journalctl -u docker-daemon -u nginx-daemon -u gateway-lease-watchdog --since "@${since}" --no-pager -o json 2>/dev/null |
      python3 "$WORK/py/journal-tag.py" "$(base_daemon_pids)"
  } | grep -aiE '"level":"?(warn|warning|error|fatal|40|50|60)("|,)|level=(WARN|ERROR)' >"$out"
  bad="$(python3 - "$out" "${LOG_ALLOW[@]}" 2>"${out%.txt}-grouped.txt" <<'PY'
import collections, json, re, sys
allow = [re.compile(p, re.I) for p in sys.argv[2:]]
groups = collections.OrderedDict()
for line in open(sys.argv[1], errors='replace'):
    line = line.rstrip('\n')
    source, _, body = line.partition(': ')
    key = body
    try:
        j = json.loads(body)
        key = '%s %s' % (j.get('level'), j.get('msg') or j.get('message'))
    except Exception:
        key = re.sub(r'time=\S+|\d{4}-\d\d-\d\dT[\d:.]+Z?|[0-9a-f]{8}-[0-9a-f-]{27}', '', body)[:200]
    allowed = any(p.search(line) for p in allow)
    g = groups.setdefault((source, key, allowed), [0, allowed, body[:400]])
    g[0] += 1
bad = 0
for (source, key, _), (n, allowed, sample) in groups.items():
    print(('ALLOWED  ' if allowed else 'UNEXPECTED ') + '%s x%d: %s' % (source, n, sample), file=sys.stderr)
    bad += 0 if allowed else 1
print(bad)
PY
)"
  sed 's/^/    /' "${out%.txt}-grouped.txt" | head -n 40
  check "${label}: no warnings or errors in app, relay and daemon logs beyond the allow-list" \
    "$(grep -c . "$out") lines, ${bad:-?} unexpected kinds (logs/$(basename "${out%.txt}-grouped.txt"))" test "${bad:-1}" = 0
}

# ── Phase 2: product update to the candidate ──────────────────────────

record_foundation() {
  local svc
  for svc in relay postgres redis registry; do
    FACT["identity_${svc}"]="$(container_identity "$(service_id "$svc")")"
  done
  FACT[container_identity]="$(container_identity e2e-web)"
}

check_foundation_kept() {
  local svc now
  for svc in relay postgres redis registry; do
    now="$(container_identity "$(service_id "$svc")")"
    [[ "${FACT[identity_${svc}]}" == missing && "$now" == missing ]] && continue
    check "${svc} not recreated by the update" "$(cut -c1-12 <<<"$now") $(cut -d' ' -f3 <<<"$now")" test "$now" = "${FACT[identity_${svc}]}"
  done
  now="$(container_identity e2e-web)"
  check "workload container untouched" "$(cut -c1-12 <<<"$now") $(cut -d' ' -f2- <<<"$now")" test "$now" = "${FACT[container_identity]}"
}

# The update either brings the candidate up or the old updater logs why it gave up.
update_settled() {
  local app
  version_is "$CANDIDATE" && return 0
  app="$(service_id app)"
  [[ -n "$app" ]] || return 1
  UPDATE_ERROR="$(docker logs --since "$UPDATE_SINCE" "$app" 2>&1 | grep -E '"message":"(Update failed|Self-update failed)"' | tail -n1 | cut -c1-500)"
  [[ -n "$UPDATE_ERROR" ]]
}

# gateway_update LABEL: check-update and update through the product, timed against the probes.
gateway_update() {
  local label="$1" start_ms end_ms latest window sidecar
  if [[ "$LICENSE_MODE" == block && -z "$LICENSE_KEY" ]]; then
    license_block 0
    check_license_guard
    api POST /api/system/license/check
    say "license check: HTTP ${CODE}, registration $(jx "$RESP" 'D["registrationStatus"]'), installation $(jx "$RESP" 'D["installationName"]')"
  fi
  api POST /api/system/check-update
  latest="$(jx "$RESP" 'D["latestVersion"]')"
  check "${label}: check-update offers ${CANDIDATE}" "HTTP ${CODE}; latest ${latest}, available $(jx "$RESP" 'D["updateAvailable"]')" \
    test "$latest" = "$CANDIDATE" || return 1
  record_foundation
  start_ms="$(now_ms)"
  UPDATE_SINCE="$(date +%s)"
  UPDATE_ERROR=""
  api POST /api/system/update "$(mkjson '{"version": a[0]}' "$CANDIDATE")"
  check "${label}: update accepted" "HTTP ${CODE} $(short "$RESP" 160)" test "$CODE" = 200 || return 1
  wait_for 900 "Gateway ${CANDIDATE}" update_settled
  end_ms="$(now_ms)"
  if [[ -n "$UPDATE_ERROR" ]]; then
    fail "${label}: Gateway runs ${CANDIDATE}" "the ${BASE} updater gave up: ${UPDATE_ERROR}"
    [[ "$LICENSE_MODE" == block && -z "$LICENSE_KEY" ]] && license_block 1
    return 1
  fi
  sleep 10
  TIMING["${label}"]="$(((end_ms - start_ms) / 1000)) s"
  window="$(probe_window "$start_ms" "$((end_ms + 10000))")"
  echo "$window" >"$WORK/json/probes-${label// /-}.json"
  sidecar="$(docker ps -a --filter "ancestor=${FACT[sidecar_image]:-docker.io/library/docker:27-cli}" --format '{{.Names}} {{.Status}}' | head -n1)"
  check "${label}: Gateway runs ${CANDIDATE}" "$(((end_ms - start_ms) / 1000)) s from the update request; sidecar ${sidecar:-not found}" \
    version_is "$CANDIDATE" || { docker logs "$(service_id app)" 2>&1 | tail -n 20; return 1; }
  TIMING["${label} API outage"]="$(window_value "$window" 'D["apiOutageSeconds"]') s"
  check "${label}: API outage within ${MAX_API_DOWNTIME} s" \
    "$(window_value "$window" '"%s s, %s of %s probes failed" % (D["apiOutageSeconds"], D["apiFailures"], D["apiSamples"])')" \
    test "$(window_value "$window" 'D["apiRecovered"] and D["apiOutageSeconds"] <= float(args[0])' "$MAX_API_DOWNTIME")" = true
  check "${label}: route served throughout" \
    "$(window_value "$window" '"%s of %s probes failed, codes %s" % (D["routeFailures"], D["routeSamples"], D["routeCodes"])')" \
    test "$(window_value "$window" 'D["routeSamples"] > 0 and D["routeFailures"] == 0')" = true
  if [[ "$LICENSE_MODE" == block && -z "$LICENSE_KEY" ]]; then
    sleep 20
    license_block 1
  fi
}

check_upgraded_state() {
  local label="$1" snap="$2" errors cookie_code
  # docker:volumes:create became docker:volumes:edit in the 2.10 -> 2.11 migration (0200); a 2.11 base keeps it as given.
  local volumes=edit
  base_translates_retired_scopes && volumes=create
  local expected=("${EXPECTED_OPERATOR_SCOPES[@]}" "nodes:manage:${FACT[nginx_node]}" "proxy:unrestricted:${FACT[proxy]}"
    "docker:volumes:${volumes}:${FACT[docker_node]}")
  cookie_code="$(curl_code -ks -m 10 -o /dev/null -w '%{http_code}' -b "$JAR" "$API/auth/me")"
  check "${label}: admin session survived" "GET /auth/me with the pre-update cookie -> HTTP ${cookie_code}" test "$cookie_code" = 200
  ensure_session
  tapi GET /api/nodes
  check "${label}: API token works" "GET /api/nodes with the ${BASE} token -> HTTP ${CODE}" test "$CODE" = 200
  say "${label} access: $(access_snapshot "$snap")"
  check "${label}: no retired scope names in effective access" \
    "$(python3 "$WORK/py/access.py" retired "$WORK/json/access-${snap}.json" "${RETIRED_SCOPES[@]}")" \
    python3 "$WORK/py/access.py" retired "$WORK/json/access-${snap}.json" "${RETIRED_SCOPES[@]}"
  check "${label}: operator keeps access under current names" \
    "$(python3 "$WORK/py/access.py" expect "$WORK/json/access-${snap}.json" operatorScopes "${expected[@]}")" \
    python3 "$WORK/py/access.py" expect "$WORK/json/access-${snap}.json" operatorScopes "${expected[@]}"
  check "${label}: token keeps access under current names" \
    "$(python3 "$WORK/py/access.py" expect "$WORK/json/access-${snap}.json" token "${EXPECTED_TOKEN_SCOPES[@]}")" \
    python3 "$WORK/py/access.py" expect "$WORK/json/access-${snap}.json" token "${EXPECTED_TOKEN_SCOPES[@]}"
  api GET /api/ssl-certificates
  check "${label}: certificate active" "$(jx "$RESP" '[(c["name"], c.get("status")) for c in items(d) if c["id"] == args[0]]' "${FACT[cert]}")" \
    test "$(jx "$RESP" '[c.get("status") for c in items(d) if c["id"] == args[0]][0]' "${FACT[cert]}")" = active
  api GET /api/notifications/alert-rules
  check "${label}: alert rule and webhook binding kept" \
    "$(jx "$RESP" '[(r["name"], r["enabled"], r.get("webhookIds")) for r in items(d) if r["id"] == args[0]]' "${FACT[rule]}")" \
    test "$(jx "$RESP" '[args[1] in (r.get("webhookIds") or []) for r in items(d) if r["id"] == args[0]][0]' "${FACT[rule]}" "${FACT[webhook]}")" = true
  wait_for 150 "proxy host health" proxy_online
  check "${label}: proxy host online" "$(proxy_health)" proxy_online
  errors="$(docker logs "$(service_id app)" 2>&1 | grep -c '"level":"error"')"
  check "${label}: no errors in the app log" \
    "${errors} error lines $(docker logs "$(service_id app)" 2>&1 | grep '"level":"error"' | head -n 3 | cut -c1-200 | tr '\n' ' ')" \
    test "$errors" = 0
  api GET /api/ui/bootstrap
  if [[ -n "$LICENSE_KEY" ]]; then
    check "${label}: private core loaded" "commercialModule $(jx "$RESP" 'D["commercialModule"]'), plan $(jx "$RESP" 'D["license"]["plan"]')" \
      test "$(jx "$RESP" 'D["commercialModule"]')" = ready
    check "${label}: private core prepared through the license server" "$(cat "$INSTALL_DIR/.gateway-commercial/prepared/${CANDIDATE}.json" 2>/dev/null)" \
      grep -q '"edition":"commercial"' "$INSTALL_DIR/.gateway-commercial/prepared/${CANDIDATE}.json"
  else
    check "${label}: Community edition" "commercialModule $(jx "$RESP" 'D["commercialModule"]'), license $(jx "$RESP" 'D["license"]["status"]')" \
      test "$(jx "$RESP" 'D["commercialModule"]')" = community
  fi
}

phase2_update() {
  local id
  phase 2 "Update ${BASE} -> ${CANDIDATE} through the product"
  feed_pin "$CHANNEL" "gateway=${CANDIDATE}"
  ensure_session
  # A base that snapshots the database before an update removes the snapshot once the update succeeded; phase 4
  # needs it for the base's own restore, so its inode is kept by a hard link while the update runs.
  start_background dump-capture sh -c 'while :; do for f in "$1"/.gateway-foundation-backups/pre-update-*/gateway-db.dump; do
      [ -s "$f" ] && ln -f "$f" "$2/pre-update-db.dump" 2>/dev/null; done; sleep 0.2; done' sh "$INSTALL_DIR" "$WORK"
  gateway_update "update"
  local updated=$?
  stop_background dump-capture
  ((updated == 0)) || return 1
  check "database migrated" "$(psql_gateway 'select count(*) from drizzle.__drizzle_migrations') applied migrations" true
  check_foundation_kept
  check_upgraded_state "after update" upgrade1
  check_alerts_migrated "after update"
  builtin_groups_snapshot upgrade1
  check_folder_grant "after update"
  if [[ "${FACT[sl_ready]}" == 1 ]]; then
    wait_for 120 "route ${SECURE_LINK_DOMAIN}" sl_ok
    check "after update: Route Secure Link serves" "http://${SECURE_LINK_DOMAIN}/ok" sl_ok
  fi
  for id in "${FACT[docker_node]}" "${FACT[nginx_node]}"; do
    wait_for 120 "node ${id} online" node_online_with "$id" "$BASE"
    check "node stays online on the ${BASE} daemon" "$(node_status "$id") (${id})" node_online_with "$id" "$BASE"
  done
}

# ── Phase 3: daemons and relay ────────────────────────────────────────

watchdog_ready() {
  systemctl is-active --quiet gateway-lease-watchdog 2>/dev/null || return 1
  api GET "/api/nodes/${FACT[docker_node]}"
  [[ "$(jx "$RESP" '"availability_lease_watchdog_missing_v1" in (D.get("capabilities") or {}).get("capabilities", [])')" == false ]]
}

relay_updated() {
  api GET /api/system/version
  [[ "$(jx "$RESP" 'D["relay"]["currentVersion"]')" == "$1" && "$(jx "$RESP" 'D["relay"].get("operation") is None')" == true ]]
}

phase3_components() {
  local id target type start before relay_target start_ms window
  phase 3 "Update daemons and relay through the product"
  FACT[phase3_epoch]="$(date +%s)"
  ensure_session
  api POST /api/system/daemon-updates/check
  keep_json daemon-updates
  for type in docker nginx; do
    id="${FACT[${type}_node]}"
    target="$(jx "$WORK/json/daemon-updates.json" '[x["latestVersion"] for x in D if x["daemonType"] == args[0]][0]' "$type")"
    check "${type} daemon update offered" "latest ${target:-none} for the ${BASE} node" \
      test -n "$target" -a "$(jx "$WORK/json/daemon-updates.json" '[n["updateAvailable"] for x in D for n in x["nodes"] if n["nodeId"] == args[0]][0]' "$id")" = true || continue
    [[ "${FACT[sl_ready]}" == 1 ]] && live_start "$type"
    start=$SECONDS
    start_ms="$(now_ms)"
    api POST "/api/system/daemon-updates/${id}"
    target="$(jx "$RESP" 'D["targetVersion"]')"
    check "${type} daemon update scheduled" "HTTP ${CODE} -> ${target}" test "$CODE" = 200 -a -n "$target" || continue
    wait_for 300 "${type} daemon ${target}" node_online_with "$id" "$target"
    FACT[live_${type}_online_ms]="$(now_ms)"
    TIMING["${type} daemon update"]="$((SECONDS - start)) s"
    check "${type} daemon updated and online" "$(node_status "$id") after $((SECONDS - start)) s" node_online_with "$id" "$target"
    live_verdict "$type" "$id" "$target"
    window="$(probe_window "$start_ms" "$(now_ms)")"
    check "route served during the ${type} daemon update" \
      "$(window_value "$window" '"%s of %s probes failed" % (D["routeFailures"], D["routeSamples"])')" \
      test "$(window_value "$window" 'D["routeFailures"] == 0')" = true
    api POST /api/system/daemon-updates/check
    keep_json daemon-updates
  done
  check "workload container not restarted by the daemon updates" "$(container_identity e2e-web | cut -d' ' -f2-)" \
    test "$(container_identity e2e-web)" = "${FACT[container_identity]}"
  check_launcher
  wait_for 240 "lease watchdog installed by the docker daemon" watchdog_ready
  check "lease watchdog installed" \
    "unit $(systemctl is-active gateway-lease-watchdog 2>/dev/null) $(journalctl -u gateway-lease-watchdog --no-pager -o cat 2>/dev/null | grep -o '"version":"[^"]*"' | tail -n1)" \
    watchdog_ready

  api POST /api/system/check-update
  relay_target="$(jx "$RESP" 'D["relay"]["latestVersion"]')"
  before="$(jx "$RESP" 'D["relay"]["currentVersion"]')"
  check "relay update offered" "${before} -> ${relay_target:-none}" test "$(jx "$RESP" 'D["relay"]["updateAvailable"]')" = true || return 0
  start=$SECONDS
  api POST /api/system/relay-update "$(mkjson '{"version": a[0]}' "$relay_target")"
  check "relay update accepted" "HTTP ${CODE}" test "$CODE" = 200 || return 0
  wait_for 300 "relay ${relay_target}" relay_updated "$relay_target"
  TIMING["relay update"]="$((SECONDS - start)) s"
  check "relay updated" "$(jx "$RESP" 'D["relay"]["currentVersion"]') after $((SECONDS - start)) s; $(docker inspect -f '{{.State.Health.Status}}' "$(service_id relay)" 2>/dev/null)" \
    relay_updated "$relay_target"
  for id in "${FACT[docker_node]}" "${FACT[nginx_node]}"; do
    wait_for 180 "node ${id} online after the relay update" node_online "$id"
    check "node online after the relay update" "$(node_status "$id")" node_online "$id"
  done
  check "route serves after the relay update" "https://${ROUTE_DOMAIN}" route_ok
  if [[ "${FACT[sl_ready]}" == 1 ]]; then
    wait_for 120 "route ${SECURE_LINK_DOMAIN}" sl_ok
    check "Route Secure Link serves after the relay update" "http://${SECURE_LINK_DOMAIN}/ok" sl_ok
  fi
  check_logs "after the daemon and relay updates" "${FACT[phase3_epoch]}"
  # After the log check: the kills log warnings on purpose.
  if [[ "${FACT[sl_ready]}" == 1 ]]; then
    kill_cut_check "docker daemon killed mid-download" docker-daemon "/blob?rate=${BLOB_RATE}"
    kill_cut_check "docker daemon killed mid-stream" docker-daemon "/stream?seconds=600"
    kill_cut_check "nginx daemon killed mid-stream" nginx-daemon "/stream?seconds=600"
  else
    skip "Route Secure Link cut on a daemon kill" "the base Route Secure Link was not set up"
  fi
}

# ── Phase 4: forced rollback with the base updater's rollback() ───────

sidecar_exited() { [[ "$(docker inspect -f '{{.State.Status}}' gateway-e2e-rollback 2>/dev/null)" == exited ]]; }

phase4_rollback() {
  local backup start=$SECONDS status code license_state probe_id pages id
  phase 4 "Forced rollback to ${BASE}, then update again"
  [[ -s "$WORK/rollback-functions-${BASE}.sh" ]] || { fail "rollback script available" "the base rollback() was not rendered"; return 1; }
  for backup in "$INSTALL_DIR"/.gateway-foundation-backups/*/; do
    if grep -qxF "GATEWAY_IMAGE_REF=${FACT[base_image]}" "${backup}.env" 2>/dev/null; then
      FACT[backup]="${backup%/}"
      break
    fi
  done
  check "foundation backup of the update found" "${FACT[backup]:-none}" test -n "${FACT[backup]}" || return 1
  {
    printf '#!/bin/sh\n# Base updater sidecar functions; the update body is replaced by a forced failure.\n'
    cat "$WORK/rollback-functions-${BASE}.sh"
    printf '\n'
    if [[ "${FACT[base_snapshots]}" == 1 ]]; then
      # The snapshot the update took is back where the base updater wrote it, as if the health gate had failed.
      printf 'db_snapshot_ready=1\n'
    fi
    printf 'echo "gateway-e2e: forced update failure, running rollback()"\nexit 1\n'
  } >"$WORK/rollback-${BASE}.sh"
  if [[ "${FACT[base_snapshots]}" == 1 ]]; then
    check "pre-update database snapshot of the update captured" "$(stat -c '%s bytes' "$WORK/pre-update-db.dump" 2>/dev/null || echo missing)" \
      test -s "$WORK/pre-update-db.dump" || return 1
    cp "$WORK/pre-update-db.dump" "${FACT[backup]}/gateway-db.dump" && chmod 600 "${FACT[backup]}/gateway-db.dump"
  fi
  docker rm -f gateway-e2e-rollback >/dev/null 2>&1
  docker run -d --name gateway-e2e-rollback -e "FOUNDATION_BACKUP_DIR=${FACT[backup]}" -v "${INSTALL_DIR}:${INSTALL_DIR}" \
    -v /var/run/docker.sock:/var/run/docker.sock -v "$WORK/rollback-${BASE}.sh:/rollback.sh:ro" \
    "${FACT[sidecar_image]}" sh /rollback.sh >/dev/null
  wait_for 420 "rollback sidecar" sidecar_exited
  status="$(docker inspect -f '{{.State.ExitCode}}' gateway-e2e-rollback 2>/dev/null)"
  docker logs gateway-e2e-rollback >"$WORK/logs/rollback-sidecar.log" 2>&1
  wait_for 300 "${BASE} after the rollback" version_is "$BASE"
  TIMING["rollback"]="$((SECONDS - start)) s"
  check "rollback() brought ${BASE} back" "sidecar exit ${status} (1 = forced failure), $(gateway_version) healthy after $((SECONDS - start)) s" \
    version_is "$BASE" || { tail -n 20 "$WORK/logs/rollback-sidecar.log"; return 1; }
  sleep 15
  ensure_session
  api GET /api/ui/bootstrap
  license_state="$(jx "$RESP" 'D["license"]["status"]')"
  check "${BASE} license state valid after the rollback" \
    "policy status ${license_state}; license:cached_state entitlementsVersion $(psql_gateway "select value->>'entitlementsVersion' from settings where key='license:cached_state'")" \
    test -n "$license_state" -a "$license_state" != invalid
  check "no invalid license policy in the ${BASE} log" \
    "$(docker logs "$(service_id app)" 2>&1 | grep -c 'License policy state is invalid') occurrences" \
    test "$(docker logs "$(service_id app)" 2>&1 | grep -c 'License policy state is invalid')" = 0
  api POST /api/nodes '{"type":"docker","hostname":"e2e-rollback-probe"}'
  code="$CODE"
  probe_id="$(jx "$RESP" 'D["node"]["id"]')"
  check "${BASE} creates a node after the rollback" "POST /api/nodes -> HTTP ${code} $(short "$RESP" 120)" test "$code" = 201
  [[ -n "$probe_id" ]] && api DELETE "/api/nodes/${probe_id}"
  say "rollback access: $(access_snapshot rollback)"
  check "group, operator and token keep their ${BASE} scopes" \
    "$(python3 "$WORK/py/access.py" compare "$WORK/json/access-base.json" "$WORK/json/access-rollback.json" superset)" \
    python3 "$WORK/py/access.py" compare "$WORK/json/access-base.json" "$WORK/json/access-rollback.json" superset
  # The insert the base's ORM issues for a Pages project: columns it knows, no preview_hash.
  pages="$(psql_gateway "insert into page_projects (name, slug, description, node_id, folder_id, sort_order, max_deployments, storage_quota_bytes, created_by_id, updated_by_id) select 'e2e-rollback', 'e2e-rollback', null, null, null, 0, 20, 1073741824, id, id from users where email = '${ADMIN_EMAIL}' returning preview_hash" | head -n1)"
  check "Pages project insert with the ${BASE} column set" "preview_hash ${pages}" grep -qE '^[a-z2-7]{12}$' <<<"$pages"
  psql_gateway "delete from page_projects where slug = 'e2e-rollback'" >/dev/null
  check "route serves after the rollback" "https://${ROUTE_DOMAIN}" route_ok
  check "workload container untouched by the rollback" "$(container_identity e2e-web | cut -d' ' -f2-)" \
    test "$(container_identity e2e-web)" = "${FACT[container_identity]}"

  gateway_update "update after rollback" || return 1
  ensure_session
  say "second update access: $(access_snapshot upgrade2)"
  check "effective access equals the first update" \
    "$(python3 "$WORK/py/access.py" compare "$WORK/json/access-upgrade1.json" "$WORK/json/access-upgrade2.json" eq)" \
    python3 "$WORK/py/access.py" compare "$WORK/json/access-upgrade1.json" "$WORK/json/access-upgrade2.json" eq
  for id in "${FACT[docker_node]}" "${FACT[nginx_node]}"; do
    wait_for 180 "node ${id} online" node_online "$id"
    check "node online after the second update" "$(node_status "$id")" node_online "$id"
  done
  check "route serves after the second update" "https://${ROUTE_DOMAIN}" route_ok
  check_alerts_migrated "after the second update"
  builtin_groups_snapshot upgrade2
  check_logs "after the second update" "$UPDATE_SINCE"
}

# ── Phase 5: fresh install of the candidate ───────────────────────────

teardown_stack() {
  local unit
  rm -f "$WORK/route-ready"
  if [[ -n "$LICENSE_KEY" && "${FACT[license_activated]}" == 1 ]] && api_healthy && ensure_session; then
    api DELETE /api/system/license/key
    check "license key deactivated before teardown" "HTTP ${CODE}" test "$CODE" = 200 && FACT[license_activated]=0
  fi
  for unit in docker-daemon nginx-daemon gateway-lease-watchdog; do
    systemctl stop "$unit" >/dev/null 2>&1
  done
  docker rm -f e2e-web e2e-sl e2e-echo e2e-echo-client gateway-e2e-mailpit gateway-e2e-rollback >/dev/null 2>&1
  [[ -f "$INSTALL_DIR/docker-compose.yml" ]] && dc down -v --remove-orphans >>"$WORK/logs/compose.log" 2>&1
  docker ps -aq --filter "ancestor=${FACT[sidecar_image]:-docker.io/library/docker:27-cli}" | xargs -r docker rm -f >/dev/null 2>&1
  rm -rf "$INSTALL_DIR"
}

phase5_fresh() {
  local installer="$WORK/install-${CANDIDATE}.sh" patched snap
  phase 5 "Fresh install of ${CANDIDATE}"
  command -v docker >/dev/null && teardown_stack
  [[ "$LICENSE_MODE" == allow ]] || license_block 1
  feed_pin "$CHANNEL" "gateway=${CANDIDATE}"
  curl -fsSL "${RAW_BASE}/${CANDIDATE}/scripts/install.sh" -o "$installer"
  check "${CANDIDATE} installer downloaded" "install.sh sha256 $(sha256sum "$installer" 2>/dev/null | cut -c1-12)" test -s "$installer" || return 1
  if [[ "$CANDIDATE" == *-rc.* ]]; then
    # The installer resolves stable tags only; let it take the release candidate the feed returns.
    cp "$installer" "${installer}.orig"
    sed -i -E 's/\^v\?\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+\$/^v?[0-9]+\\.[0-9]+\\.[0-9]+(-rc\\.[0-9]+)?$/g; s/\^v\?\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+-relay\$/^v?[0-9]+\\.[0-9]+\\.[0-9]+(-rc\\.[0-9]+)?-relay$/g' "$installer"
    patched="$(diff "${installer}.orig" "$installer" | grep -c '^>')"
    check "installer accepts -rc.N tags (test-only patch)" "${patched} version patterns widened" test "$patched" -gt 0 || return 1
  fi
  run_installer fresh "$installer" || return 1
  check "fresh install runs ${CANDIDATE}" "$(grep '^GATEWAY_VERSION=' "$INSTALL_DIR/.env")" \
    grep -qx "GATEWAY_VERSION=${CANDIDATE}" "$INSTALL_DIR/.env"
  prepare_stack || return 1
  check_license_guard
  complete_setup fresh || return 1
  api GET /api/ui/bootstrap
  check "fresh install is Community" "commercialModule $(jx "$RESP" 'D["commercialModule"]'), license $(jx "$RESP" 'D["license"]["status"]')/$(jx "$RESP" 'D["license"]["plan"]')" \
    test "$(jx "$RESP" 'D["commercialModule"]')" = community
  api GET /api/system/version
  check "fresh install API version" "currentVersion $(jx "$RESP" 'D["currentVersion"]'), relay $(jx "$RESP" 'D["relay"]["currentVersion"]')" \
    test "$(jx "$RESP" 'D["currentVersion"]')" = "$CANDIDATE"
  builtin_groups_snapshot fresh
  for snap in upgrade1 upgrade2; do
    [[ -s "$WORK/json/builtin-groups-${snap}.json" ]] && compare_builtin_groups "$snap"
  done
}

# ── Main ──────────────────────────────────────────────────────────────

start_services() {
  mkdir -p "$WORK/pids" "$WORK/logs" "$WORK/json" "$WORK/smtp"
  if [[ "$LICENSE_MODE" == allow || -n "$LICENSE_KEY" ]]; then echo 0 >"$WORK/license-block"; else echo 1 >"$WORK/license-block"; fi
  start_background dns-guard python3 "$WORK/py/dns_guard.py" "$HOST_ADDR" "$WORK/license-block" "$WORK/logs/dns-guard.log" "$LICENSE_HOSTS"
  feed_pin stable
  start_background feed python3 "$WORK/py/feed.py" "$HOST_ADDR" "$FEED_PORT" "$WORK/feed-state.json" "$WORK/logs/feed.log" "$REAL_FEED" "$REPO"
  sleep 2
  check "local release feed and DNS guard running" "feed http://${HOST_ADDR}:${FEED_PORT}/releases, resolver ${HOST_ADDR}:53" \
    kill -0 "$(cat "$WORK/pids/feed")" "$(cat "$WORK/pids/dns-guard")" || return 1

  mkdir -p /etc/docker
  python3 - /etc/docker/daemon.json "$HOST_ADDR" "$DOCKER_POOL" <<'PY'
import json, os, sys
path, dns, pool = sys.argv[1:4]
config = {}
if os.path.exists(path):
    with open(path) as f:
        config = json.load(f)
config['dns'] = [dns]
if pool:
    config['default-address-pools'] = [{'base': pool, 'size': 24}]
with open(path, 'w') as f:
    json.dump(config, f, indent=2)
PY
  if [[ "$(cat "$WORK/snapshot/docker-preexisting")" == 1 ]]; then
    systemctl restart docker
    wait_for 60 "Docker" docker info
  fi

  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 7 -subj "/CN=Gateway E2E SMTP CA" \
    -keyout "$WORK/smtp/ca.key" -out "$WORK/smtp/ca.pem" 2>/dev/null
  openssl req -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -subj "/CN=mailpit" \
    -keyout "$WORK/smtp/key.pem" -out "$WORK/smtp/req.csr" 2>/dev/null
  printf 'subjectAltName=DNS:mailpit\nextendedKeyUsage=serverAuth\n' >"$WORK/smtp/ext.cnf"
  openssl x509 -req -in "$WORK/smtp/req.csr" -CA "$WORK/smtp/ca.pem" -CAkey "$WORK/smtp/ca.key" -CAcreateserial -days 7 \
    -extfile "$WORK/smtp/ext.cnf" -out "$WORK/smtp/cert.pem" 2>/dev/null
  chmod 644 "$WORK/smtp/"*.pem

  cat >"$WORK/probe.sh" <<EOF
#!/usr/bin/env bash
# One API probe and, once the route exists, one route probe per second.
while :; do
  ts=\$(date +%s%3N)
  api=\$(curl -ks -m 2 -o /dev/null -w '%{http_code}' ${API}/health)
  route=-
  if [[ -f ${WORK}/route-ready ]]; then
    route=\$(curl -ks -m 2 -o /dev/null -w '%{http_code}' --resolve ${ROUTE_DOMAIN}:443:127.0.0.1 https://${ROUTE_DOMAIN}/)
  fi
  echo "\$ts \${api:-000} \${route:-000}" >>${WORK}/logs/probes.log
  sleep 1
done
EOF
  start_background probes bash "$WORK/probe.sh"
}

summary() {
  local key
  printf '\n%s  ── Summary ──\n' "$(date -u +%H:%M:%S)"
  printf 'base %s -> candidate %s (%s channel); license server: %s%s\n' "$BASE" "$CANDIDATE" "$CHANNEL" \
    "$LICENSE_MODE" "$([[ -n "$LICENSE_KEY" ]] && echo ', paid key')"
  for key in "${!TIMING[@]}"; do printf '  %-34s %s\n' "$key" "${TIMING[$key]}"; done | sort
  if [[ -f "$WORK/logs/dns-guard.log" ]]; then
    printf '  license server lookups from Docker: %s blocked, %s allowed during update windows\n' \
      "$(grep -c ' BLOCK ' "$WORK/logs/dns-guard.log")" "$(grep -c ' ALLOW ' "$WORK/logs/dns-guard.log")"
  fi
  printf 'PASS %s  FAIL %s  SKIP %s\n' "$PASSED" "$FAILED" "$SKIPPED"
}

on_exit() {
  local code=$? app
  trap - EXIT INT TERM HUP
  [[ -n "$WORK" && -d "$WORK/snapshot" ]] || exit "$code"
  if [[ -n "$LOGS_OUT" ]] && command -v docker >/dev/null; then
    for app in $(docker ps -aq --filter label=com.docker.compose.service=app 2>/dev/null); do
      docker logs "$app" >"$WORK/logs/app-${app:0:12}.log" 2>&1
    done
  fi
  if ((KEEP)); then
    # The DNS guard keeps serving Docker and the feed keeps serving the app until --cleanup-only.
    stop_background probes
    say "kept everything; remove it later with: release-upgrade-e2e.sh --cleanup-only ${WORK}"
  elif ((!CLEANED)); then
    cleanup_host
  fi
  summary | tee "$WORK/summary.txt"
  if [[ -n "$LOGS_OUT" ]]; then
    tar -czf "$LOGS_OUT" -C "$WORK" logs json results.txt summary.txt 2>/dev/null && say "logs written to ${LOGS_OUT}"
  fi
  ((KEEP)) || rm -rf "$WORK"
  ((FAILED == 0 && code == 0)) && exit 0
  exit 1
}

main() {
  parse_args "$@"
  if [[ -n "$CLEANUP_ONLY" ]]; then
    WORK="$CLEANUP_ONLY"
    [[ -d "$WORK/snapshot" ]] || { echo "${WORK} has no host snapshot." >&2; exit 2; }
    PROJECT="$(cat "$WORK/project" 2>/dev/null)"
    PROJECT="${PROJECT:-$(basename "$INSTALL_DIR")}"
    KEEP=0
    write_helpers
    trap on_exit EXIT
    trap 'exit 130' INT TERM HUP
    cleanup_host
    exit 0
  fi
  preflight
  RUN_ID="$(date -u +%Y%m%d%H%M%S)"
  WORK="${WORK:-/var/tmp/gateway-e2e-${RUN_ID}}"
  PUBLIC_URL="${PUBLIC_URL:-https://gateway-e2e-${RUN_ID}.invalid:3000}"
  [[ "$CANDIDATE" == *-rc.* ]] && CHANNEL="preview"
  [[ ! -e "$WORK" ]] || { echo "${WORK} exists." >&2; exit 2; }
  mkdir -p "$WORK"
  JAR="$WORK/admin.jar"
  : >"$WORK/results.txt"
  write_helpers
  snapshot_host
  PROJECT="$(basename "$INSTALL_DIR")"
  echo "$PROJECT" >"$WORK/project"
  trap on_exit EXIT
  trap 'exit 130' INT TERM HUP
  say "Gateway release E2E ${BASE} -> ${CANDIDATE}; host ${HOST_ADDR}; public URL ${PUBLIC_URL}; work dir ${WORK}"

  phase 0 "Preparation"
  start_services || exit 1

  if phase1_base; then
    if phase2_update; then
      phase3_components
      phase4_rollback
    else
      PHASE=3; skip "daemon and relay updates" "the Gateway update did not complete"
      PHASE=4; skip "forced rollback" "the Gateway update did not complete"
    fi
  else
    PHASE=2; skip "product update" "the base installation did not complete"
    PHASE=3; skip "daemon and relay updates" "the base installation did not complete"
    PHASE=4; skip "forced rollback" "the base installation did not complete"
  fi
  phase5_fresh
  if [[ -z "$LICENSE_KEY" ]]; then
    PHASE=6
    skip "paid path" "GATEWAY_E2E_LICENSE_KEY is not set"
  fi
}

main "$@" </dev/null
