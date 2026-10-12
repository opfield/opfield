import { createServer } from 'node:net';
import { describe, expect, it } from 'vitest';
import { relayEndpoint, relayPortUnreachableMessage, tcpAnswers } from './hosting-relay-port.js';

describe('relay port check of hosted relays', () => {
  it('labels IPv4, IPv6 and host names with the port', () => {
    expect(relayEndpoint('203.0.113.5', 9443).label).toBe('203.0.113.5:9443');
    expect(relayEndpoint('[2001:db8::1]', 9443)).toEqual({
      host: '2001:db8::1',
      port: 9443,
      label: '[2001:db8::1]:9443',
    });
    expect(relayPortUnreachableMessage('relay.example.com:9443')).toContain('Open TCP 9443');
  });

  it('answers only when the port accepts a connection', async () => {
    const server = createServer((socket) => socket.end());
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    expect(await tcpAnswers('127.0.0.1', port, 1_000)).toBe(true);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(await tcpAnswers('127.0.0.1', port, 1_000)).toBe(false);
  });
});
