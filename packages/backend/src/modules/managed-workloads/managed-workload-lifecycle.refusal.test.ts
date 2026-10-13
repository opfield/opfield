import { describe, expect, it, vi } from 'vitest';
import type { ManagedWorkloadLabels } from './managed-workload-labels.js';
import { ManagedWorkloadLifecycle } from './managed-workload-lifecycle.js';
import { isUpdateRefusedBeforeChange } from './managed-workload-refusal.js';

const labels: ManagedWorkloadLabels = {
  notFound: { code: 'NOT_FOUND', message: 'not found' },
  operationPending: { code: 'PENDING', message: 'pending' },
  operationMismatch: { code: 'PENDING', message: 'mismatch' },
  invalidLifecycle: () => ({ code: 'INVALID', message: 'invalid' }),
  failed: (operation, detail) => (detail ? `Storage ${operation} failed: ${detail}` : `Storage ${operation} failed`),
  reconciling: 'Storage operation outcome is being reconciled',
  refused: (operation, detail) => `The node refused the ${operation} and changed nothing: ${detail}`,
  waiting: (operation, detail) => `Storage ${operation} is retried automatically: ${detail}`,
};

function setup(row: Record<string, unknown>) {
  const writes: Array<Record<string, unknown>> = [];
  const store = {
    setStatus: vi.fn(async (_id: string, patch: Record<string, unknown>) => {
      writes.push(patch);
      return { ...row, ...patch };
    }),
    delete: vi.fn(),
  };
  const dispatch = {
    emit: vi.fn(),
    toView: (current: unknown) => current,
    beforeDelete: vi.fn(),
    renderCommandPayload: vi.fn(async () => ''),
    sendCommand: vi.fn(async () => ({ success: true, error: '', detail: '{}' })),
    disposeCanonicalClient: vi.fn(),
    deleteCanonicalConnection: vi.fn(),
    auditLifecycle: vi.fn(),
  };
  const lifecycle = new ManagedWorkloadLifecycle(store as never, dispatch as never, labels);
  return { lifecycle, writes, dispatch, store };
}

describe('managed workload update the node refused', () => {
  it('puts the status back with the refusal as a warning (F-2)', async () => {
    const row = {
      id: 'storage',
      nodeId: 'node',
      status: 'updating',
      updatedById: null,
      pendingOperation: { id: 'op', action: 'update', previousStatus: 'ready' },
    };
    const { lifecycle, writes, dispatch } = setup(row);
    await lifecycle.markError(row as never, 'update', 'insufficient managed storage capacity after reserve');
    expect(writes).toEqual([
      {
        status: 'ready',
        pendingOperation: null,
        lastError:
          'The node refused the update and changed nothing: insufficient managed storage capacity after reserve',
      },
    ]);
    expect(dispatch.emit).toHaveBeenCalledWith(expect.objectContaining({ status: 'ready' }), 'refused');
  });

  it('fails an update that the node did not refuse up front, and one without a recorded status', async () => {
    for (const [pendingOperation, detail] of [
      [{ id: 'op', action: 'update', previousStatus: 'ready' }, 'resize managed storage filesystem: exit status 1'],
      [{ id: 'op', action: 'update' }, 'insufficient managed storage capacity after reserve'],
    ] as const) {
      const row = { id: 'storage', nodeId: 'node', status: 'updating', updatedById: null, pendingOperation };
      const { lifecycle, writes } = setup(row);
      await lifecycle.markError(row as never, 'update', detail);
      expect(writes[0]).toMatchObject({
        status: 'error',
        pendingOperation: null,
        lastError: `Storage update failed: ${detail}`,
      });
    }
  });

  it('knows the refusals of old and new daemons', () => {
    expect(isUpdateRefusedBeforeChange('insufficient database storage capacity after reserve')).toBe(true);
    expect(
      isUpdateRefusedBeforeChange(
        "insufficient managed storage capacity after reserve: the node's disk for managed instances has 6.2 GiB free"
      )
    ).toBe(true);
    expect(isUpdateRefusedBeforeChange('managed storage cannot be reduced')).toBe(true);
    expect(
      isUpdateRefusedBeforeChange('the managed database disk is being repaired after it went read-only; try again')
    ).toBe(true);
    expect(isUpdateRefusedBeforeChange('grow managed database filesystem: exit status 1')).toBe(false);
    expect(isUpdateRefusedBeforeChange(undefined)).toBe(false);
  });
});

describe('managed workload delete whose Opfield-side cleanup fails', () => {
  it('keeps the delete pending, says why, and sends nothing to the node', async () => {
    const row = {
      id: 'storage',
      nodeId: 'node',
      status: 'deleting',
      updatedById: null,
      pendingOperation: { id: 'op', action: 'delete' },
    };
    const { lifecycle, writes, dispatch, store } = setup(row);
    dispatch.beforeDelete.mockRejectedValueOnce(
      new Error('Failed to delete the SeaweedFS IAM user that owns this access key: SeaweedFS IAM ServiceFailure')
    );
    await lifecycle.dispatchDelete(row as never, null);
    expect(writes).toEqual([
      {
        lastError:
          'Storage delete is retried automatically: Failed to delete the SeaweedFS IAM user that owns this access key: SeaweedFS IAM ServiceFailure',
      },
    ]);
    expect(dispatch.sendCommand).not.toHaveBeenCalled();
    expect(store.delete).not.toHaveBeenCalled();

    // The next pass retries it and the delete completes.
    await lifecycle.dispatchDelete(row as never, null);
    expect(dispatch.sendCommand).toHaveBeenCalledWith('node', 'remove', 'storage', '');
    expect(store.delete).toHaveBeenCalledWith('storage');
  });
});

describe('managed storage update the node refused, with the labels Opfield runs storage with', () => {
  it('records the refusal with the prefix the core answers 409 MANAGED_STORAGE_UPDATE_REFUSED by (rc.8 F-6)', async () => {
    const { STORAGE_WORKLOAD_LABELS } = await import('@/modules/storage/storage-workload-labels.js');
    const { UPDATE_REFUSED_PREFIX } = await import('./managed-workload-refusal.js');
    const row = {
      id: 'storage',
      nodeId: 'node',
      status: 'updating',
      updatedById: null,
      pendingOperation: { id: 'op', action: 'update', previousStatus: 'ready' },
    };
    const writes: Array<Record<string, unknown>> = [];
    const lifecycle = new ManagedWorkloadLifecycle(
      {
        setStatus: vi.fn(async (_id: string, patch: Record<string, unknown>) => {
          writes.push(patch);
          return { ...row, ...patch };
        }),
      } as never,
      { emit: vi.fn(), toView: (current: unknown) => current } as never,
      STORAGE_WORKLOAD_LABELS
    );
    await lifecycle.markError(row as never, 'update', 'insufficient managed storage capacity after reserve: 1 GiB');
    expect(writes[0]).toMatchObject({
      status: 'ready',
      lastError: `${UPDATE_REFUSED_PREFIX}insufficient managed storage capacity after reserve: 1 GiB`,
    });
  });
});
