import { describe, expect, it } from 'vitest';
import { isOpfieldManagedDockerNetwork, isReservedOpfieldNetworkName } from './docker-internal-networks.js';

describe("Opfield's own Docker networks", () => {
  it.each([
    'opfield-secure-links',
    'opfield-db-0123456789abcdef',
    'opfield-db-av-0123456789abcdef',
    'opfield-storage-0123456789abcdef',
    'opfield-storage-6f1c2a1e-3b4d-4c5e-8f9a-0b1c2d3e4f5a',
    'opfield-link-0123456789abcdef',
    // Networks created before 2.12.1 keep their names.
    'gateway-secure-links',
    'gateway-db-0123456789abcdef',
    'gateway-storage-0123456789abcdef',
    'gateway-link-0123456789abcdef',
  ])('hides and reserves %s', (name) => {
    expect(isOpfieldManagedDockerNetwork(name)).toBe(true);
    expect(isReservedOpfieldNetworkName(name)).toBe(true);
  });

  it.each(['bridge', 'my-app', 'opfield', 'opfield-storage-mine'])('leaves %s to the user', (name) => {
    expect(isOpfieldManagedDockerNetwork(name)).toBe(false);
  });
});
