import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { container } from '@/container.js';
import { AuthSettingsService } from '@/modules/auth/auth.settings.service.js';
import { OidcSettingsService } from '@/modules/auth/oidc-settings.service.js';
import { oauthLoginRedirectUrl } from './oauth.routes.js';
import { OAuthService } from './oauth.service.js';

process.env.DATABASE_URL ||= 'http://localhost/db';
process.env.REDIS_URL ||= 'redis://localhost:6379';
process.env.PKI_MASTER_KEY ||= '0000000000000000000000000000000000000000000000000000000000000000';

function registerMethods(methods: { oidc: boolean; password: boolean; emailOtp: boolean; passkeyLogin: boolean }) {
  container.registerInstance(OAuthService, {
    getIssuerUrl: () => 'https://opfield.example.com',
  } as unknown as OAuthService);
  container.registerInstance(AuthSettingsService, {
    getConfig: vi.fn().mockResolvedValue({ methods }),
  } as unknown as AuthSettingsService);
  container.registerInstance(OidcSettingsService, {
    getPublicConfig: vi.fn().mockResolvedValue({ configured: methods.oidc }),
  } as unknown as OidcSettingsService);
}

afterEach(() => {
  container.reset();
});

describe('oauthLoginRedirectUrl', () => {
  const authorizeUrl = 'http://backend:3000/api/oauth/authorize/api/mcp?client_id=client&state=abc';
  const publicAuthorizeUrl = 'https://opfield.example.com/api/oauth/authorize/api/mcp?client_id=client&state=abc';

  it('sends local-auth installs to the login page with a public same-origin return_to', async () => {
    registerMethods({ oidc: false, password: true, emailOtp: false, passkeyLogin: true });

    const url = new URL(await oauthLoginRedirectUrl(authorizeUrl));

    expect(url.origin + url.pathname).toBe('https://opfield.example.com/login');
    expect(url.searchParams.get('return_to')).toBe(publicAuthorizeUrl);
  });

  it('uses the login page when OIDC is one of several methods', async () => {
    registerMethods({ oidc: true, password: true, emailOtp: false, passkeyLogin: false });

    expect(new URL(await oauthLoginRedirectUrl(authorizeUrl)).pathname).toBe('/login');
  });

  it('goes straight to the identity provider when OIDC is the only method', async () => {
    registerMethods({ oidc: true, password: false, emailOtp: false, passkeyLogin: false });

    const url = new URL(await oauthLoginRedirectUrl(authorizeUrl));

    expect(url.pathname).toBe('/auth/login');
    expect(url.searchParams.get('return_to')).toBe(publicAuthorizeUrl);
  });
});
