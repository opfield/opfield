import { describe, expect, it } from 'vitest';
import { OperationLeaseStore } from '@/db/operation-lease.js';
import { createFakeOperationLeaseDb } from '@/db/operation-lease.test-helpers.js';
import { DockerContainerTransitions } from './docker-container-transitions.js';

describe('container leases of an operation whose Opfield process is gone', () => {
  it('lets the follow-ups of its detached task take the lease over instead of waiting for it to lapse', async () => {
    const { db } = createFakeOperationLeaseDb();
    // The process that ran the update; it is gone without releasing the lease (Opfield restarted).
    const before = new DockerContainerTransitions();
    before.setLeaseStore(new OperationLeaseStore(db));
    before.set('node-1', 'web', 'updating');
    await before.acquireLeases('node-1', ['web']);
    const token = before.leaseToken('node-1', 'web');
    expect(token).toBeTruthy();

    const after = new DockerContainerTransitions();
    after.setLeaseStore(new OperationLeaseStore(db));
    const claim = after.claim('node-1', [{ name: 'web', state: 'updating' }]);
    await expect(after.acquireLeases('node-1', ['web'])).rejects.toMatchObject({ code: 'CONTAINER_BUSY' });
    await expect(after.acquireLeases('node-1', ['web'], { takeOverToken: 'another-operation' })).rejects.toMatchObject({
      code: 'CONTAINER_BUSY',
    });
    await after.acquireLeases('node-1', ['web'], { takeOverToken: token });
    expect(after.leaseToken('node-1', 'web')).not.toBe(token);
    after.release(claim);
    before.clear('node-1', 'web');
  });
});
