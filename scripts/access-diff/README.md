# access-diff

A release check: what every kind of credential may do on the last stable Opfield and on a candidate. It sends one
harmless request per documented REST operation and one `tools/call` per MCP tool, for each credential, on both
installations, and compares the answers. A route a credential could use before and is refused now (like 2.13.0
answering 403 to OAuth tokens on `POST /api/inference/tokens`, which 2.12.8 answered 201) fails the run unless the
narrowing is approved in `approved.json`.

```sh
node scripts/access-diff/run.mjs \
  --baseline https://stable.example:3000 \
  --candidate https://candidate.example:3000 \
  --credentials ~/access-diff-credentials.json \
  --out ./access-diff-out
```

Exit code: `0` pass, `1` an unapproved narrowed or removed row (with `--strict` also an inconclusive one), `2` usage
or setup error. Output in `--out`:

- `diff.md`: the credentials and their sanity checks, then narrowed and removed rows that are not approved, approved
  ones, inconclusive, widened, added routes, counts, approvals that matched nothing, and what was not probed and why.
- `rows.json`: every row with the request sent and the answer of each side (status, error code, message). Tokens,
  cookies and CSRF values are redacted.

Options: `--approved <file>`, `--probes <file>`, `--concurrency <n>` (default 4 per installation), `--timeout <ms>`
(15000), `--reserve <0..1>` (0.25: the share of every rate-limit window left for other clients; the run waits for the
next window instead), `--only <regex>` (probe only matching routes, for a quick look; the gate then covers only
those), `--no-mcp`, `--strict`, `--insecure` (self-signed TLS; or start node with `NODE_EXTRA_CA_CERTS=<ca.pem>`).

## Before a stable

1. Have both installations running: the last stable (for example a throwaway install of it) and the candidate.
   Both need the same setup for a fair comparison: the same admin account, a user to impersonate, MCP enabled, AI
   enabled if inference is in scope, and one resource folder for the narrow token. Comparing an installation with
   itself must give `same` on every row; do that once if the credentials are new.
2. Get every credential below on both installations and write the credentials file. Use short expiries.
3. Run the command. Everything the run reports as narrowed or removed is either a bug to fix before the stable or a
   decision the owner makes: then add it to `approved.json` with the owner's name and the date.
4. Look at `Widened` too: a credential that may do more than before is a security question, even though it does not
   fail the run.
5. Revoke the tokens, end the impersonation, delete the OAuth clients.

Run it from a machine whose IP no one else needs at that moment: the API rate limit counts per client IP (1200
requests per minute by default; 120 on `/auth/*`). A full run is about 7 000 requests per installation.

## Credentials file

```json
{
  "baseline": {
    "session": { "cookie": "__Host-opfield_session_…=…", "csrf": "optional, fetched from /auth/csrf if left out" },
    "apiToken": "opf_…",
    "apiTokenNarrow": "opf_…",
    "oauthApi": {
      "token": "opfo_…",
      "refresh_token": "opfr_…",
      "client_id": "…",
      "expires_at": "2026-10-31T12:15:00Z"
    },
    "oauthMcp": "opfo_…",
    "inferenceKey": "opfi_…",
    "impersonation": { "cookie": "…" }
  },
  "candidate": { "…": "the same kinds, minted on the candidate" }
}
```

Every kind is optional: a kind missing on either side is skipped and listed as missing in `diff.md`. Further keys are
compared too (a string or `{"token": …}` is a bearer token, `{"cookie": …}` a browser session), for example a second
narrow token. Requests without any credential (`anonymous`) are always part of the run. Each credential is checked
first (signed in on `GET /health`; `opfi_` on `GET /api/inference/v1/models`; the MCP token on `initialize`): one
rejected on both sides is skipped, one rejected on one side is warned about, as every row then reads as narrowed or
widened.

How to get each, on each installation, signed in as the same admin:

- **session**: sign in in a browser, copy the session cookie (`__Host-opfield_session_<id>_https`, or
  `opfield_session_<id>_http` over plain HTTP) from the developer tools as `name=value`. The CSRF token is fetched by
  the tool. The run never calls logout, so the session stays signed in.
- **apiToken**: create one with every scope on the API tokens page, or `POST /api/tokens`
  `{"name": "access-diff-full", "scopes": [<scopes_supported of /.well-known/oauth-protected-resource/api>], "exactScopes": true, "expiresAt": "<in 3 h>"}`
  with the session.
- **apiTokenNarrow**: the same with a folder grant, for example
  `"scopes": ["proxy:view:folder/<folderId>", "acl:view:folder/<folderId>"]`.
- **oauthApi**: `RESOURCE=<url>/api SCOPES="<scopes>" AUTH_SERVER_URL=<url> scripts/test-oauth-flow.sh`, approve in the
  browser; the script prints the `opfo_` access token only (good for runs under 15 minutes). For refresh, use the
  flow without a browser and keep `refresh_token` and `client_id` from the token response. Without a browser: `POST /api/oauth/register`, then
  `GET /api/oauth/authorize?…&resource=<url>/api` with the session cookie (redirects to `/oauth/consent?request=<id>`),
  `POST /api/oauth/consent/<id>/approve` `{}` with session and CSRF (answers the redirect URL with the code), and
  `POST /api/oauth/token` with the code and the PKCE verifier.
- **oauthMcp**: the same with `RESOURCE=<url>/api/mcp` and the scopes of
  `/.well-known/oauth-protected-resource/api/mcp`.
- **inferenceKey**: create one on the inference keys page, or `POST /api/inference/tokens`
  `{"name": "access-diff", "expiresAt": "<in 3 h>"}` with the session.
- **impersonation**: impersonate a non-admin user from the users admin page in a private browser window, copy that window's
  session cookie. Or `POST /api/admin/users/<userId>/impersonate` with the admin session and CSRF, and take the
  session cookie it sets (do it with a copy of the cookie jar, never the jar other tools use). Do not stop the
  impersonation until the run is over.

### OAuth refresh

Opfield OAuth access tokens for the API resource live 900 s, and a full run takes longer. Give an OAuth credential as
an object, and the tool keeps it valid:

| Field | |
|---|---|
| `token` | the `opfo_` access token |
| `refresh_token` | the refresh token from the same token response (`opfr_…`) |
| `client_id` | the OAuth client the grant belongs to (required with a refresh token) |
| `client_secret` | confidential clients only; sent in the form body. Opfield's own clients are public and have none. |
| `token_endpoint` | default `<installation>/api/oauth/token` |
| `resource` | optional; sent with the refresh |
| `expires_at` | optional ISO date or epoch seconds (obtained time + `expires_in`) |

The token is refreshed 60 s before a known expiry, and on a 401 that says the token expired (REST: `Invalid or
expired bearer token`) or carries a `WWW-Authenticate` `invalid_token` challenge (MCP). The request is then sent once
more with the new token. Each request is refreshed and retried at most once. Refresh tokens rotate, and reusing an old
one revokes the whole grant, so concurrent requests share one refresh. A grant used on both sides (an installation
compared with itself) is refreshed once for both. A failed refresh is not tried again: its rows then show the 401s, and
the credentials table says `refresh failed: …`. Successful refreshes are counted there too. New tokens are redacted
like the old ones. Opfield MCP tokens do not expire and come without a refresh token; a plain string still works for
them and for anything else.

## What it sends

The route list is the union of both installations' `GET /api/openapi.json` (read with the first credential that signs
in) plus the union of `tools/list` over `POST /api/mcp` for each credential that gets into MCP. Path parameters are
matched by position, so a renamed parameter (`{id}` → `{nodeId}`) is the same route.

Every request is chosen so that the answer is decided by authentication, scopes and validation, never by a side
effect:

- `GET`: as documented, without query parameters; path ids are a UUID that no installation holds
  (`00000000-0000-4000-8000-00000000ad1f`) or `access-diff-nonexistent-0000`. Streams are cut after the headers.
- `POST`, `PUT`, `PATCH`, `DELETE`: always the same malformed JSON body, which every JSON route refuses with 400
  before it acts, plus path ids that point at nothing. A write with no path id is sent only when its JSON body is
  required and has required fields (so even a handler that reads the body itself and falls back to `{}` stops), and
  never when the path names an installation-wide action (update, restart, install, gc, sync, …). Deletes therefore
  never meet an existing id.
- Not sent at all: logout, impersonation stop, sign-in and setup flows (they spend the per-IP sign-in budget other
  people share), OAuth authorize, writes that nothing would stop. They are listed under "Not probed".
- MCP: every argument of the tool gets a value of the wrong type (and an unknown argument when the schema forbids
  extra ones), so a tool the token may use answers "Invalid tool arguments" and one it may not use answers "unavailable
  for this MCP token". A read-only tool without arguments is called as it is; a tool whose arguments cannot be made
  invalid is not called.
- `probes.json`: hand-written deeper probes with valid arguments on the non-existent id, for refusals that sit after
  validation (2.13.0 refused remote MCP changing `opfi_` keys and access service tokens only once the arguments were
  valid). Each probe must reference the non-existent UUID; the tool refuses to start otherwise. Add one when a
  refusal is found that the generic probes cannot see, and keep it pointing at nothing.

Refused calls appear in the audit log of both installations (`mcp.tool.denied` and failed requests).

## How rows are classified

Each answer becomes an outcome: `allowed` (2xx/3xx), `validation` (400/422, MCP "Invalid tool arguments"),
`not_found` (404 of a lookup), `other` (409 and the like, plan or feature refusals such as
`LICENSE_ENTITLEMENT_REQUIRED`), `denied` (401, 403, MCP refusals), `missing` (the installation serves no such route:
`No API endpoint at …`, 405), `error` (timeout, network, 5xx, 429 after retries).

| Row | When |
|---|---|
| narrowed | baseline got past authentication (allowed, validation, not found, other), candidate `denied` |
| widened | baseline `denied`, candidate got past authentication |
| removed | in the baseline's OpenAPI document or tool list but not the candidate's, or the candidate answers `missing` |
| added | the reverse |
| inconclusive | outcomes differ and one side is `error` |
| same | anything else (also 404 → 400: access did not change) |

What it cannot see: a refusal a route makes only after it has validated a correct body (the probes never send one)
unless a probe in `probes.json` covers it.

## approved.json

```json
{
  "approvals": [
    {
      "route": "POST /api/inference/tokens",
      "credential": "oauthApi",
      "change": "narrowed",
      "reason": "Inference keys are made from a browser session only",
      "approvedBy": "owner name",
      "date": "2026-10-31"
    }
  ]
}
```

`route` is `METHOD /path` as in the OpenAPI document (parameter names do not matter), `MCP <tool>`, `MCP initialize`
or `PROBE <id>`. `credential` is a credential key or `*`. `change` is optional (`narrowed` or `removed`) and limits the
approval to that class. `reason`, `approvedBy` and `date` (YYYY-MM-DD) are required. An approval only matters while
the compared pair differs, so old entries are harmless; `diff.md` lists the ones that matched nothing.

## Tests

`node --test scripts/access-diff/access-diff.test.mjs scripts/access-diff/oauth-refresh.test.mjs`: the classifier, the
request planner, one run of the CLI against two small in-process fake installations, and the OAuth refresh against a
fake token endpoint with rotating refresh tokens. The fake-server tests need a local port and are skipped where
listening is not allowed.
