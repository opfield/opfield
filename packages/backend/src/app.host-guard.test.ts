import 'reflect-metadata';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { OPFIELD_NOT_FOUND_HTML } from '@/lib/opfield-error-pages.js';
import { SetupTokenPolicyService } from '@/modules/setup/setup-token-policy.js';
import { StatusPageService } from '@/modules/status-page/status-page.service.js';
import {
  createApp,
  getDirectLocalRequestOrigin,
  isAllowedWebSocketOrigin,
  isLocalMachineHost,
  normalizeRequestHost,
} from './app.js';
import { container, TOKENS } from './container.js';

beforeAll(() => {
  process.env.NODE_ENV = 'test';
  process.env.APP_URL = 'https://gateway.example.com';
  process.env.DATABASE_URL ||= 'http://localhost/db';
  process.env.REDIS_URL ||= 'redis://localhost:6379';
  process.env.OIDC_ISSUER ||= 'http://localhost/oidc';
  process.env.OIDC_CLIENT_ID ||= 'test';
  process.env.OIDC_CLIENT_SECRET ||= 'test';
  process.env.OIDC_REDIRECT_URI ||= 'https://gateway.example.com/auth/callback';
  process.env.PKI_MASTER_KEY ||= '0000000000000000000000000000000000000000000000000000000000000000';
});

afterEach(() => container.reset());

describe('normalizeRequestHost', () => {
  it.each([
    ['Gateway.Example.COM:443', 'gateway.example.com'],
    ['gateway.example.com.', 'gateway.example.com'],
    ['[::1]:3000', '::1'],
    ['127.0.0.1:3000', '127.0.0.1'],
  ])('normalizes %s', (input, expected) => {
    expect(normalizeRequestHost(input)).toBe(expected);
  });

  it.each([
    undefined,
    '',
    'bad host',
    'example.com:99999',
    '::1',
    '[not-ipv6]',
    'example.com/path',
  ])('rejects malformed Host %s', (input) => expect(normalizeRequestHost(input)).toBeNull());
});

describe('isLocalMachineHost', () => {
  const localAddresses = new Set(['172.20.0.131', '192.168.50.10', 'fd00::10', 'fe80::20', '203.0.113.197']);

  it.each([
    'localhost',
    '127.0.0.1',
    '::1',
    '172.20.0.131',
    '192.168.50.10',
    'fd00::10',
    'fe80::20',
  ])('allows local machine address %s', (host) => expect(isLocalMachineHost(host, localAddresses)).toBe(true));

  it.each([
    '172.20.0.132',
    '10.0.0.8',
    'fd00::11',
    '203.0.113.197',
    '8.8.8.8',
    'gateway.example.com',
  ])('rejects non-local or public address %s', (host) => expect(isLocalMachineHost(host, localAddresses)).toBe(false));
});

describe('WebSocket origin guard', () => {
  const localAddresses = new Set(['192.168.50.10', 'fd00::10']);

  it('allows the canonical Gateway origin', () => {
    expect(isAllowedWebSocketOrigin('https://gateway.example.com')).toBe(true);
  });

  it('allows a direct local Gateway origin with the matching host and port', () => {
    const directOrigin = getDirectLocalRequestOrigin(
      'http://192.168.50.10:3000/api/events',
      '192.168.50.10:3000',
      localAddresses
    );

    expect(directOrigin).toBe('http://192.168.50.10:3000');
    expect(isAllowedWebSocketOrigin('http://192.168.50.10:3000', directOrigin)).toBe(true);
  });

  it.each([
    'http://192.168.50.10:7777',
    'http://localhost:3000',
    'http://192.168.50.11:3000',
  ])('rejects a different local Origin %s', (origin) => {
    const directOrigin = getDirectLocalRequestOrigin(
      'http://192.168.50.10:3000/api/events',
      '192.168.50.10:3000',
      localAddresses
    );

    expect(isAllowedWebSocketOrigin(origin, directOrigin)).toBe(false);
  });

  it('does not create a direct origin for a non-local target host', () => {
    expect(
      getDirectLocalRequestOrigin('https://gateway.example.com/api/events', 'gateway.example.com', localAddresses)
    ).toBeNull();
  });
});

describe('Gateway Host guard', () => {
  it('allows the canonical APP_URL host', async () => {
    container.registerInstance(TOKENS.RedisClient, { ping: vi.fn().mockResolvedValue('PONG') } as any);
    const response = await createApp().app.request('/health', { headers: { host: 'Gateway.Example.com:443' } });
    expect(response.status).toBe(200);
  });

  it('keeps the original IP host available until setup is completed', async () => {
    container.registerInstance(TOKENS.RedisClient, { ping: vi.fn().mockResolvedValue('PONG') } as any);
    container.registerInstance(SetupTokenPolicyService, { isSetupComplete: vi.fn().mockResolvedValue(false) } as any);

    const response = await createApp().app.request('/health', {
      headers: { host: '172.20.0.131:3000' },
    });

    expect(response.status).toBe(200);
  });

  it('allows the loopback UI host after setup is completed', async () => {
    const response = await createApp().app.request('/', { headers: { host: '127.0.0.1:3000' } });

    expect(response.status).toBe(404);
    expect(await response.text()).not.toBe(OPFIELD_NOT_FOUND_HTML);
  });

  it.each([
    '/',
    '/auth/login',
    '/api/openapi.json',
    '/assets/app.js',
    '/api/events',
    '/api/ai/ws',
  ])('returns the branded 404 before routing %s for a legacy host', async (path) => {
    const response = await createApp().app.request(path, {
      headers: { host: 'legacy.example.com', 'x-forwarded-host': 'gateway.example.com' },
    });
    expect(response.status).toBe(404);
    expect(await response.text()).toBe(OPFIELD_NOT_FOUND_HTML);
  });

  it('does not expose /health through a legacy host', async () => {
    const ping = vi.fn().mockResolvedValue('PONG');
    container.registerInstance(TOKENS.RedisClient, { ping } as any);
    const response = await createApp().app.request('/health', { headers: { host: 'legacy.example.com' } });
    expect(response.status).toBe(404);
    expect(await response.text()).toBe(OPFIELD_NOT_FOUND_HTML);
    expect(ping).not.toHaveBeenCalled();
  });

  it('allows the configured public status host through the host guard', async () => {
    const isStatusHost = vi.fn().mockResolvedValue(true);
    container.registerInstance(StatusPageService, { isStatusHost } as any);
    const response = await createApp().app.request('/missing', { headers: { host: 'status.example.com' } });
    expect(response.status).toBe(404);
    expect(await response.text()).not.toBe(OPFIELD_NOT_FOUND_HTML);
    expect(isStatusHost).toHaveBeenCalledWith('status.example.com');
  });
});
