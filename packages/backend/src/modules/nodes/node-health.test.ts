import { describe, expect, it } from 'vitest';
import { nodeHealth } from './node-service-helpers.js';

// rc.3 O-A1: status says whether a node is connected; health says whether a connected node works.
describe('the health of a node next to its status', () => {
  it('is degraded while a connected Docker node cannot start containers', () => {
    expect(nodeHealth('docker', 'online', { dockerEngine: { available: false } })).toBe('degraded');
    expect(nodeHealth('docker', 'online', { dockerEngine: { available: true } })).toBe('healthy');
    expect(nodeHealth('storage', 'online', {})).toBe('healthy');
  });

  it('is degraded while nginx is stopped or its configuration is invalid', () => {
    expect(nodeHealth('nginx', 'online', { nginxRunning: false, configValid: true })).toBe('degraded');
    expect(nodeHealth('nginx', 'online', { nginxRunning: true, configValid: false })).toBe('degraded');
    expect(nodeHealth('nginx', 'online', { nginxRunning: true, configValid: true })).toBe('healthy');
  });

  it('is null while the node is not online', () => {
    expect(nodeHealth('docker', 'offline', { dockerEngine: { available: false } })).toBeNull();
  });
});
