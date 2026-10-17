#!/usr/bin/env sh
set -eu

RESOURCE_BASE_URL="${RESOURCE_BASE_URL:-http://localhost:5173}"
AUTH_SERVER_URL="${AUTH_SERVER_URL:-${BASE_URL:-$RESOURCE_BASE_URL}}"
CALLBACK_HOST="${CALLBACK_HOST:-127.0.0.1}"
CALLBACK_PORT="${CALLBACK_PORT:-8765}"
CALLBACK_PATH="${CALLBACK_PATH:-/callback}"
CLIENT_NAME="${CLIENT_NAME:-Opfield OAuth CLI Test}"
SCOPES="${SCOPES:-nodes:details proxy:view}"
RESOURCE="${RESOURCE:-$RESOURCE_BASE_URL/api}"
TIMEOUT_SECONDS="${TIMEOUT_SECONDS:-180}"
OPEN_BROWSER="${OPEN_BROWSER:-1}"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

json_get() {
  node -e "
const input = require('fs').readFileSync(0, 'utf8');
const key = process.argv[1];
const value = JSON.parse(input)[key];
if (value === undefined || value === null) process.exit(1);
process.stdout.write(String(value));
" "$1"
}

urlencode() {
  node -e "process.stdout.write(encodeURIComponent(process.argv[1]));" "$1"
}

require_cmd curl
require_cmd node

CALLBACK_URI="http://$CALLBACK_HOST:$CALLBACK_PORT$CALLBACK_PATH"
TMP_DIR="${TMPDIR:-/tmp}"
CODE_FILE="$(mktemp "$TMP_DIR/opfield-oauth-code.XXXXXX")"
STATE="$(node -e "process.stdout.write(require('crypto').randomBytes(16).toString('base64url'))")"

cleanup() {
  if [ "${SERVER_PID:-}" ]; then
    kill "$SERVER_PID" >/dev/null 2>&1 || true
  fi
  rm -f "$CODE_FILE"
}
trap cleanup EXIT INT TERM

echo "Registering OAuth client at $AUTH_SERVER_URL/api/oauth/register"
REGISTER_BODY="$(node -e "
process.stdout.write(JSON.stringify({
  client_name: process.argv[1],
  redirect_uris: [process.argv[2]]
}));
" "$CLIENT_NAME" "$CALLBACK_URI")"

REGISTER_RESPONSE="$(curl -sS "$AUTH_SERVER_URL/api/oauth/register" \
  -H "Content-Type: application/json" \
  -d "$REGISTER_BODY")"

CLIENT_ID="$(printf '%s' "$REGISTER_RESPONSE" | json_get client_id)"
echo "Client ID: $CLIENT_ID"

PKCE="$(node -e "
const crypto = require('crypto');
const verifier = crypto.randomBytes(32).toString('base64url');
const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
console.log(verifier);
console.log(challenge);
")"
CODE_VERIFIER="$(printf '%s\n' "$PKCE" | sed -n '1p')"
CODE_CHALLENGE="$(printf '%s\n' "$PKCE" | sed -n '2p')"

node - "$CALLBACK_PORT" "$CALLBACK_PATH" "$CODE_FILE" "$STATE" <<'NODE' &
const http = require('http');
const fs = require('fs');

const port = Number(process.argv[2]);
const callbackPath = process.argv[3];
const codeFile = process.argv[4];
const expectedState = process.argv[5];

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  if (url.pathname !== callbackPath) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
    return;
  }

  const error = url.searchParams.get('error');
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');

  if (error) {
    fs.writeFileSync(codeFile, `ERROR:${error}`);
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end(`OAuth denied or failed: ${error}`);
    server.close();
    return;
  }

  if (!code || state !== expectedState) {
    fs.writeFileSync(codeFile, 'ERROR:invalid_callback');
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Invalid OAuth callback');
    server.close();
    return;
  }

  fs.writeFileSync(codeFile, code);
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('OAuth code received. You can return to the terminal.');
  server.close();
});

server.listen(port, '127.0.0.1');
NODE
SERVER_PID="$!"

AUTH_URL="$AUTH_SERVER_URL/api/oauth/authorize?response_type=code&client_id=$(urlencode "$CLIENT_ID")&redirect_uri=$(urlencode "$CALLBACK_URI")&code_challenge=$(urlencode "$CODE_CHALLENGE")&code_challenge_method=S256&scope=$(urlencode "$SCOPES")&resource=$(urlencode "$RESOURCE")&state=$(urlencode "$STATE")"

echo
echo "Open this URL and approve the request:"
echo "$AUTH_URL"
echo

if [ "$OPEN_BROWSER" = "1" ]; then
  if command -v open >/dev/null 2>&1; then
    open "$AUTH_URL" >/dev/null 2>&1 || true
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$AUTH_URL" >/dev/null 2>&1 || true
  fi
fi

echo "Waiting up to $TIMEOUT_SECONDS seconds for callback on $CALLBACK_URI ..."
elapsed=0
while [ ! -s "$CODE_FILE" ]; do
  if ! kill -0 "$SERVER_PID" >/dev/null 2>&1; then
    echo "Callback server stopped before receiving a code." >&2
    exit 1
  fi
  if [ "$elapsed" -ge "$TIMEOUT_SECONDS" ]; then
    echo "Timed out waiting for OAuth callback." >&2
    exit 1
  fi
  sleep 1
  elapsed=$((elapsed + 1))
done

CODE="$(cat "$CODE_FILE")"
case "$CODE" in
  ERROR:*)
    echo "OAuth callback failed: ${CODE#ERROR:}" >&2
    exit 1
    ;;
esac

echo "Received authorization code. Exchanging for token..."
TOKEN_BODY="$(node -e "
process.stdout.write(JSON.stringify({
  grant_type: 'authorization_code',
  client_id: process.argv[1],
  code: process.argv[2],
  redirect_uri: process.argv[3],
  code_verifier: process.argv[4],
  resource: process.argv[5]
}));
" "$CLIENT_ID" "$CODE" "$CALLBACK_URI" "$CODE_VERIFIER" "$RESOURCE")"

TOKEN_RESPONSE="$(curl -sS "$AUTH_SERVER_URL/api/oauth/token" \
  -H "Content-Type: application/json" \
  -d "$TOKEN_BODY")"

ACCESS_TOKEN="$(printf '%s' "$TOKEN_RESPONSE" | json_get access_token)"
TOKEN_SCOPE="$(printf '%s' "$TOKEN_RESPONSE" | json_get scope)"

echo
echo "Access token:"
echo "$ACCESS_TOKEN"
echo
echo "Granted scopes:"
echo "$TOKEN_SCOPE"
echo

if [ "$RESOURCE" = "$RESOURCE_BASE_URL/api" ]; then
  echo "Testing API access with GET $AUTH_SERVER_URL/api/nodes"
  API_RESPONSE_FILE="$(mktemp "$TMP_DIR/opfield-oauth-api-response.XXXXXX")"
  API_STATUS="$(curl -sS -o "$API_RESPONSE_FILE" -w "%{http_code}" "$AUTH_SERVER_URL/api/nodes" -H "Authorization: Bearer $ACCESS_TOKEN")"
  if [ "$API_STATUS" -ge 200 ] && [ "$API_STATUS" -lt 300 ]; then
    NODE_COUNT="$(node -e "
const fs = require('fs');
const body = fs.readFileSync(process.argv[1], 'utf8');
const parsed = JSON.parse(body);
const items = Array.isArray(parsed) ? parsed : Array.isArray(parsed.items) ? parsed.items : Array.isArray(parsed.data) ? parsed.data : [];
process.stdout.write(String(items.length));
" "$API_RESPONSE_FILE" 2>/dev/null || printf 'unknown')"
    echo "API test passed ($API_STATUS, nodes: $NODE_COUNT)"
  else
    echo "API test failed with HTTP $API_STATUS" >&2
    cat "$API_RESPONSE_FILE" >&2
    echo >&2
    exit 1
  fi
  rm -f "$API_RESPONSE_FILE"
else
  echo "Skipping sample API call because RESOURCE is not $RESOURCE_BASE_URL/api"
fi
