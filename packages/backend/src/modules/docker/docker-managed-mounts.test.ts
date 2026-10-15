import { describe, expect, it } from 'vitest';
import { assertManagedMountMutation, assertUniqueMountTargets } from './docker-managed-mounts.js';
import type { NormalizedMountDefinition } from './docker-socket-mount.guard.js';

const anonymous = '2617777e419daa47c6b5499eb7a47a5ba83b9b1b9c63a5b2d51a6227e1a73980';

describe('mount targets', () => {
  it('refuses two mounts at one path and names both', () => {
    expect(() =>
      assertUniqueMountTargets([
        { type: 'volume', source: anonymous, target: '/data', readOnly: false },
        { type: 'volume', source: 'rin-data', target: '/data', readOnly: false },
      ])
    ).toThrow(/anonymous volume 2617777e419d and volume "rin-data" both mount at \/data/);
  });

  it('leaves the mounts a container already has to Docker', async () => {
    const current: NormalizedMountDefinition[] = [
      { type: 'volume', source: 'a', target: '/data', readOnly: false },
      { type: 'volume', source: 'b', target: '/data', readOnly: true },
    ];
    await expect(
      assertManagedMountMutation({
        db: {} as never,
        dispatch: {} as never,
        parseResult: () => ({}),
        nodeId: 'node-1',
        current,
        next: current,
      })
    ).resolves.toBeUndefined();
  });
});
