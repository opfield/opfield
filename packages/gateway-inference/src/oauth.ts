import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { CredentialStore } from './credentials.js';
import { CLI_VERSION } from './discovery.js';
import { CliError } from './errors.js';
import { withFileLock } from './file-lock.js';
import { assertTrustedEndpoint, type Fetch, requestJson } from './http.js';
import type { InferenceDiscovery, OAuthCredential, OAuthMetadata, OAuthTokenResponse } from './types.js';

export const LOOPBACK_TIMEOUT_MS = 10 * 60 * 1000;

interface OAuthClientRegistration {
  client_id: string;
}

export interface LoopbackReceiver {
  redirectUri: string;
  waitForCode(expectedState: string, timeoutMs?: number): Promise<string>;
  close(): Promise<void>;
}

export interface LoginOptions {
  profile: string;
  discovery: InferenceDiscovery;
  metadata: OAuthMetadata;
  credentials: CredentialStore;
  fetch?: Fetch;
  openBrowser?: (url: string) => Promise<void>;
  showAuthorizationUrl?: (url: string) => void;
  createReceiver?: () => Promise<LoopbackReceiver>;
  now?: () => Date;
  persistCredential?: boolean;
}

export interface BrowserLaunchCommand {
  command: string;
  args: string[];
}

function base64Url(value: Buffer): string {
  return value.toString('base64url');
}

export function createPkce(): { verifier: string; challenge: string } {
  const verifier = base64Url(randomBytes(64));
  return { verifier, challenge: base64Url(createHash('sha256').update(verifier).digest()) };
}

export async function createLoopbackReceiver(): Promise<LoopbackReceiver> {
  let server: Server;
  let callback: ((url: URL) => void) | undefined;
  const requests: URL[] = [];

  server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/callback') {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end('<!doctype html><title>Opfield</title><p>Authorization received. You can close this window.</p>');
    if (callback) callback(url);
    else requests.push(url);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new CliError('LOOPBACK_FAILED', 'Could not allocate a loopback callback port.');

  return {
    redirectUri: `http://127.0.0.1:${address.port}/callback`,
    waitForCode(expectedState, timeoutMs = LOOPBACK_TIMEOUT_MS) {
      return new Promise<string>((resolve, reject) => {
        let settled = false;
        const finish = (handler: () => void) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          handler();
        };
        const accept = (url: URL) => {
          const error = url.searchParams.get('error');
          const state = url.searchParams.get('state');
          const code = url.searchParams.get('code');
          if (state !== expectedState) {
            finish(() => reject(new CliError('OAUTH_STATE_MISMATCH', 'OAuth callback state did not match.')));
          } else if (error) {
            finish(() => reject(new CliError('OAUTH_DENIED', url.searchParams.get('error_description') || error)));
          } else if (!code) {
            finish(() =>
              reject(new CliError('OAUTH_CALLBACK_INVALID', 'OAuth callback did not include an authorization code.'))
            );
          } else {
            finish(() => resolve(code));
          }
        };
        callback = accept;
        const queued = requests.shift();
        const timer = setTimeout(
          () =>
            finish(() => reject(new CliError('OAUTH_TIMEOUT', 'Browser authorization timed out after 10 minutes.'))),
          timeoutMs
        );
        timer.unref();
        if (queued) accept(queued);
      });
    },
    async close() {
      callback = undefined;
      if (!server.listening) return;
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}

export function resolveBrowserLaunchCommand(platform: NodeJS.Platform, url: string): BrowserLaunchCommand {
  if (platform === 'darwin') return { command: 'open', args: [url] };
  if (platform === 'win32') {
    return {
      command: process.env.ComSpec || process.env.COMSPEC || 'cmd.exe',
      args: ['/d', '/s', '/c', `start "" ${quoteWindowsCmdArgument(url)}`],
    };
  }
  return { command: 'xdg-open', args: [url] };
}

function quoteWindowsCmdArgument(value: string): string {
  return `"${value.replaceAll('%', '%%').replaceAll('"', '""')}"`;
}

export async function openBrowser(url: string): Promise<void> {
  const { command, args } = resolveBrowserLaunchCommand(process.platform, url);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { detached: true, shell: false, stdio: 'ignore', windowsHide: true });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  }).catch(() => {
    process.stderr.write('Could not open a browser automatically. Use the authorization URL printed above.\n');
  });
}

export async function loginWithBrowser(
  options: LoginOptions
): Promise<{ clientId: string; credential: OAuthCredential }> {
  const receiver = await (options.createReceiver ?? createLoopbackReceiver)();
  const fetcher = options.fetch;
  const issuer = options.discovery.oauth.authorizationServer;
  const registrationEndpoint = assertTrustedEndpoint(
    options.metadata.registration_endpoint,
    issuer,
    'registration endpoint'
  );
  const authorizationEndpoint = assertTrustedEndpoint(
    options.metadata.authorization_endpoint,
    issuer,
    'authorization endpoint'
  );
  const tokenEndpoint = assertTrustedEndpoint(options.metadata.token_endpoint, issuer, 'token endpoint');

  try {
    const registration = await requestJson<OAuthClientRegistration>(
      registrationEndpoint,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          redirect_uris: [receiver.redirectUri],
          token_endpoint_auth_method: 'none',
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          client_name: 'Opfield CLI',
          software_id: 'net.wiolett.gateway.inference-cli',
          software_version: CLI_VERSION,
          scope: 'inference:setup',
        }),
      },
      { fetch: fetcher }
    );
    if (!registration.client_id) {
      throw new CliError('INVALID_CLIENT_REGISTRATION', 'Opfield returned an invalid OAuth client registration.');
    }
    const state = base64Url(randomBytes(32));
    const pkce = createPkce();
    const authorizeUrl = new URL(authorizationEndpoint);
    authorizeUrl.search = new URLSearchParams({
      response_type: 'code',
      client_id: registration.client_id,
      redirect_uri: receiver.redirectUri,
      code_challenge: pkce.challenge,
      code_challenge_method: 'S256',
      state,
      scope: 'inference:setup',
      resource: options.discovery.oauth.resource,
    }).toString();

    (options.showAuthorizationUrl ?? ((url) => process.stderr.write(`Open this URL to authorize manually:\n${url}\n`)))(
      authorizeUrl.href
    );
    await (options.openBrowser ?? openBrowser)(authorizeUrl.href);
    const code = await receiver.waitForCode(state);
    const response = await exchangeToken(
      tokenEndpoint,
      {
        grant_type: 'authorization_code',
        client_id: registration.client_id,
        code,
        redirect_uri: receiver.redirectUri,
        code_verifier: pkce.verifier,
        resource: options.discovery.oauth.resource,
      },
      fetcher
    );
    const credential = toCredential(response, options.now?.() ?? new Date());
    if (options.persistCredential !== false) await options.credentials.set(options.profile, credential);
    return { clientId: registration.client_id, credential };
  } finally {
    await receiver.close();
  }
}

export async function refreshCredential(options: {
  profile: string;
  clientId: string;
  resource: string;
  tokenEndpoint: string;
  credentials: CredentialStore;
  fetch?: Fetch;
  now?: () => Date;
  lockFile?: string;
}): Promise<OAuthCredential> {
  if (options.lockFile) {
    return withFileLock(
      options.lockFile,
      () => refreshCredential({ ...options, lockFile: undefined }),
      'AUTHORIZATION_LOCKED'
    );
  }
  const stored = await options.credentials.get(options.profile);
  if (!stored) throw new CliError('NOT_LOGGED_IN', 'Opfield connection is not logged in.', { exitCode: 2 });
  const now = options.now?.() ?? new Date();
  if (!stored.expiresAt || new Date(stored.expiresAt).getTime() > now.getTime() + 60_000) return stored;
  if (!stored.refreshToken)
    throw new CliError('AUTHORIZATION_EXPIRED', 'Opfield authorization has expired; log in again.', { exitCode: 2 });

  let response: OAuthTokenResponse;
  try {
    response = await exchangeToken(
      options.tokenEndpoint,
      {
        grant_type: 'refresh_token',
        client_id: options.clientId,
        refresh_token: stored.refreshToken,
        resource: options.resource,
      },
      options.fetch
    );
  } catch (error) {
    if (error instanceof CliError && ['invalid_grant', 'INVALID_GRANT'].includes(error.code)) {
      throw new CliError('AUTHORIZATION_REVOKED', 'Opfield authorization was revoked; log in again.', {
        exitCode: 2,
        cause: error,
      });
    }
    throw error;
  }
  const rotated = toCredential(response, now, stored.refreshToken);
  await options.credentials.set(options.profile, rotated);
  return rotated;
}

export async function revokeCredential(options: {
  profile: string;
  clientId?: string;
  revocationEndpoint?: string;
  credentials: CredentialStore;
  fetch?: Fetch;
  lockFile?: string;
}): Promise<{ remoteRevoked: boolean }> {
  if (options.lockFile) {
    return withFileLock(
      options.lockFile,
      () => revokeCredential({ ...options, lockFile: undefined }),
      'AUTHORIZATION_LOCKED'
    );
  }
  const stored = await options.credentials.get(options.profile);
  let remoteRevoked = false;
  if (stored && options.clientId && options.revocationEndpoint) {
    const token = stored.refreshToken ?? stored.accessToken;
    try {
      await requestJson<void>(
        options.revocationEndpoint,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ token, client_id: options.clientId }),
        },
        { fetch: options.fetch }
      );
      remoteRevoked = true;
    } catch {
      // Logout always clears local credentials, including while the Gateway is offline.
    }
  }
  await options.credentials.delete(options.profile);
  return { remoteRevoked };
}

async function exchangeToken(
  endpoint: string,
  values: Record<string, string>,
  fetcher?: Fetch
): Promise<OAuthTokenResponse> {
  const response = await requestJson<OAuthTokenResponse>(
    endpoint,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(values),
    },
    { fetch: fetcher }
  );
  if (
    !response.access_token ||
    typeof response.token_type !== 'string' ||
    response.token_type.toLowerCase() !== 'bearer'
  ) {
    throw new CliError('INVALID_TOKEN_RESPONSE', 'Opfield returned an invalid OAuth token response.');
  }
  return response;
}

function toCredential(response: OAuthTokenResponse, now: Date, previousRefreshToken?: string): OAuthCredential {
  return {
    accessToken: response.access_token,
    ...((response.refresh_token ?? previousRefreshToken)
      ? { refreshToken: response.refresh_token ?? previousRefreshToken }
      : {}),
    ...(response.expires_in === undefined
      ? {}
      : { expiresAt: new Date(now.getTime() + Math.max(0, response.expires_in) * 1000).toISOString() }),
    tokenType: 'Bearer',
    scope: response.scope ?? 'inference:setup',
  };
}
