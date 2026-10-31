import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { describe, it } from 'node:test';
import { Installation, parseInstallationCredentials } from './lib/client.mjs';

// A fake Opfield OAuth surface: access tokens with an expiry, rotating refresh tokens whose reuse revokes the grant
// (as Opfield does), a REST route and an MCP route that answer 401 for an expired token the way Opfield does.
function fakeOAuthServer({ ttlSeconds = 900, failRefresh = false } = {}) {
  const access = new Map();
  const refresh = new Map();
  const stats = { refreshCalls: 0, unauthorized: 0, grantRevoked: false, refreshBodies: [] };
  let counter = 0;
  const issue = (ttl) => {
    counter += 1;
    const accessToken = `opfo_fake${counter}aaaaaaaa`;
    const refreshToken = `opfr_fake${counter}bbbbbbbb`;
    access.set(accessToken, Date.now() + ttl * 1000);
    refresh.set(refreshToken, 'active');
    return { accessToken, refreshToken };
  };
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const send = (status, value, headers = {}) => {
        res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
        res.end(JSON.stringify(value));
      };
      if (req.url === '/api/oauth/token' && req.method === 'POST') {
        stats.refreshCalls += 1;
        const form = new URLSearchParams(body);
        stats.refreshBodies.push(Object.fromEntries(form));
        const state = refresh.get(form.get('refresh_token'));
        if (failRefresh || form.get('grant_type') !== 'refresh_token' || form.get('client_id') !== 'client-1') {
          return send(400, { error: 'invalid_grant', error_description: 'Invalid refresh token' });
        }
        if (state !== 'active') {
          stats.grantRevoked = true; // reuse of a rotated refresh token
          return send(400, { error: 'invalid_grant', error_description: 'Invalid refresh token' });
        }
        refresh.set(form.get('refresh_token'), 'used');
        const next = issue(ttlSeconds);
        return send(200, {
          access_token: next.accessToken,
          token_type: 'Bearer',
          expires_in: ttlSeconds,
          refresh_token: next.refreshToken,
        });
      }
      const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
      const expiresAt = access.get(token);
      const valid = expiresAt !== undefined && expiresAt > Date.now();
      if (req.url === '/api/never') {
        return send(401, { code: 'UNAUTHORIZED', message: 'Authentication required' });
      }
      if (!valid) {
        stats.unauthorized += 1;
        if (req.url === '/api/mcp') {
          return send(
            401,
            { code: 'UNAUTHORIZED', message: 'Invalid OAuth access token' },
            { 'WWW-Authenticate': 'Bearer error="invalid_token", error_description="Invalid OAuth access token"' }
          );
        }
        return send(401, { code: 'UNAUTHORIZED', message: 'Invalid or expired bearer token' });
      }
      return send(200, { ok: true });
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () =>
      resolve({
        server,
        stats,
        url: `http://127.0.0.1:${server.address().port}`,
        expiredGrant: () => {
          const tokens = issue(ttlSeconds);
          access.set(tokens.accessToken, Date.now() - 1000);
          return tokens;
        },
        freshGrant: (ttl) => issue(ttl),
      })
    );
  });
}

const options = () => ({ timeoutMs: 5000, reserve: 0.25, maxRetries: 0, log: () => {}, onSecret: () => {} });

function oauthCredential(grant, extra = {}) {
  const parsed = parseInstallationCredentials({
    oauthApi: { token: grant.accessToken, refresh_token: grant.refreshToken, client_id: 'client-1', ...extra },
  });
  assert.deepEqual(parsed.problems, []);
  return parsed.credentials.find((credential) => credential.id === 'oauthApi');
}

async function withServer(t, serverOptions, run) {
  let fake;
  try {
    fake = await fakeOAuthServer(serverOptions);
  } catch (error) {
    t.skip(`cannot listen on 127.0.0.1 here: ${error.message}`);
    return;
  }
  try {
    await run(fake);
  } finally {
    fake.server.close();
  }
}

describe('OAuth refresh', () => {
  it('reads the refresh fields and refuses a refresh token without a client id', () => {
    const parsed = parseInstallationCredentials({
      oauthApi: {
        token: 'opfo_x',
        refreshToken: 'opfr_y',
        clientId: 'c',
        client_secret: 's',
        token_endpoint: 'https://auth.example/token',
        expires_at: 1_900_000_000,
      },
      oauthMcp: { token: 'opfo_z', refresh_token: 'opfr_w' },
    });
    const api = parsed.credentials.find((credential) => credential.id === 'oauthApi');
    assert.equal(api.oauthRefresh.clientSecret, 's');
    assert.equal(api.oauthRefresh.tokenEndpoint, 'https://auth.example/token');
    assert.equal(api.oauthRefresh.expiresAt, 1_900_000_000_000);
    assert.ok(parsed.problems.some((problem) => problem.startsWith('oauthMcp: a refresh token needs client_id')));
  });

  it('refreshes once on an expired 401, retries every waiting request, and shares the grant across both sides', async (t) => {
    await withServer(t, {}, async (fake) => {
      const grant = fake.expiredGrant();
      // A run comparing an installation with itself parses the same grant for both sides.
      const baseline = new Installation('baseline', fake.url, options());
      const candidate = new Installation('candidate', fake.url, options());
      const baselineCredential = oauthCredential(grant);
      const candidateCredential = oauthCredential(grant);
      const results = await Promise.all([
        ...Array.from({ length: 6 }, () => baseline.rest(baselineCredential, 'GET', '/api/thing', {})),
        ...Array.from({ length: 6 }, () => candidate.rest(candidateCredential, 'GET', '/api/thing', {})),
      ]);
      assert.deepEqual(
        results.map((result) => result.status),
        Array(12).fill(200)
      );
      assert.equal(fake.stats.refreshCalls, 1, 'one refresh for all waiting requests');
      assert.equal(fake.stats.grantRevoked, false, 'the rotated refresh token was never reused');
      assert.equal(baselineCredential.refreshState, candidateCredential.refreshState);
      assert.equal(baselineCredential.refreshState.refreshes, 1);
    });
  });

  it('refreshes before a known expiry, using the rotated refresh token the next time', async (t) => {
    await withServer(t, { ttlSeconds: 30 }, async (fake) => {
      const grant = fake.freshGrant(30);
      // 30 s left is inside the refresh margin: the token is renewed before the request.
      const credential = oauthCredential(grant, { expires_at: new Date(Date.now() + 30_000).toISOString() });
      const installation = new Installation('baseline', fake.url, options());
      assert.equal((await installation.rest(credential, 'GET', '/api/thing', {})).status, 200);
      assert.equal(fake.stats.unauthorized, 0, 'no request went out with the old token');
      assert.equal(fake.stats.refreshCalls, 1);
      // expires_in 30 s is again inside the margin: the next request refreshes with the rotated token.
      assert.equal((await installation.rest(credential, 'GET', '/api/thing', {})).status, 200);
      assert.equal(fake.stats.refreshCalls, 2);
      assert.notEqual(fake.stats.refreshBodies[1].refresh_token, fake.stats.refreshBodies[0].refresh_token);
      assert.notEqual(fake.stats.refreshBodies[1].refresh_token, grant.refreshToken);
      assert.equal(fake.stats.grantRevoked, false);
    });
  });

  it('refreshes on an MCP invalid_token challenge', async (t) => {
    await withServer(t, {}, async (fake) => {
      const credential = oauthCredential(fake.expiredGrant());
      const installation = new Installation('baseline', fake.url, options());
      const answer = await installation.mcp(credential, { jsonrpc: '2.0', id: 1, method: 'initialize' });
      assert.equal(answer.httpStatus, 200);
      assert.equal(fake.stats.refreshCalls, 1);
    });
  });

  it('retries a request only once, and never refreshes on a 401 that is not about the token', async (t) => {
    await withServer(t, { ttlSeconds: 0 }, async (fake) => {
      const installation = new Installation('baseline', fake.url, options());
      const credential = oauthCredential(fake.expiredGrant());
      // The refreshed token is refused too (expires at once): the answer is the 401, after one refresh.
      const result = await installation.rest(credential, 'GET', '/api/thing', {});
      assert.equal(result.status, 401);
      assert.equal(fake.stats.refreshCalls, 1);

      const other = oauthCredential(fake.freshGrant(900));
      const before = fake.stats.refreshCalls;
      assert.equal((await installation.rest(other, 'GET', '/api/never', {})).status, 401);
      assert.equal(fake.stats.refreshCalls, before, '"Authentication required" is not an expired token');
    });
  });

  it('does not try a failed refresh again', async (t) => {
    await withServer(t, { failRefresh: true }, async (fake) => {
      const installation = new Installation('baseline', fake.url, options());
      const credential = oauthCredential(fake.expiredGrant());
      assert.equal((await installation.rest(credential, 'GET', '/api/thing', {})).status, 401);
      assert.equal((await installation.rest(credential, 'GET', '/api/thing', {})).status, 401);
      assert.equal(fake.stats.refreshCalls, 1);
      assert.match(credential.refreshState.failure, /Invalid refresh token/);
    });
  });
});
