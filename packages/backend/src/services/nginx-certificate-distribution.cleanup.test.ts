import '@/db/schema/index.js';
import { describe, expect, it, vi } from 'vitest';
import { NginxCertificateDistributionService } from './nginx-certificate-distribution.service.js';

// housekeeping F-1 (rc.3): the certificate and key of a deleted route never left the node. The tombstone raises the
// replica generation, cleanup sent the raised value, and the node (which only knows the deployed one) refused every
// time; rows from 2026-09-30 still had their directories on three nodes.
const CERT = '33333333-3333-4333-8333-333333333333';
const VERSION = 'a'.repeat(64);

interface Node {
  present: boolean;
  version: string;
  generation: number;
}

function setup(row: { generation: number; deployedGeneration: number | null }, node: Node) {
  const replica = {
    id: 'replica-1',
    assetId: 'asset-1',
    nodeId: 'node-1',
    status: 'failed',
    appliedVersion: VERSION,
    cleanupAfter: new Date(Date.now() - 60_000),
    ...row,
  };
  const updates: Array<Record<string, unknown>> = [];
  let deleted = false;
  const db = {
    query: {
      nginxCertificateReplicas: {
        findMany: vi.fn(async () => [replica]),
        findFirst: vi.fn(async () => (deleted ? undefined : replica)),
      },
      nginxCertificateAssets: {
        findFirst: vi.fn(async () => ({ id: 'asset-1', referenceType: 'ssl', referenceId: CERT })),
      },
    },
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
    delete: () => ({
      where: () => ({
        returning: async () => {
          deleted = true;
          return [{ id: replica.id }];
        },
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          updates.push(values);
        },
      }),
    }),
  };
  const removals: string[] = [];
  const dispatch = {
    inspectCertificates: vi.fn(async (_nodeId: string, certIds: string[]) => ({
      success: true,
      data: Buffer.from(
        JSON.stringify({
          certificates: certIds.map((certId) => ({ certId, present: node.present, version: node.version })),
        })
      ),
    })),
    // The node's compare-and-swap (nginx.RemoveCertificateReplica): version and generation must be the ones it holds.
    removeCertificateReplica: vi.fn(async (_nodeId: string, _certId: string, version: string, generation: string) => {
      removals.push(generation);
      if (version !== node.version || generation !== String(node.generation)) {
        return { success: false, error: 'certificate replica removal failed' };
      }
      node.present = false;
      return { success: true };
    }),
  };
  const service = new NginxCertificateDistributionService(db as never, {} as never, {} as never, dispatch as never);
  const orphan = vi.spyOn(service as any, 'removeOrphanedSslAsset').mockResolvedValue(undefined);
  return { service, node, removals, updates, orphan, isDeleted: () => deleted, dispatch };
}

describe('certificate replica cleanup', () => {
  it('removes a replica the node holds one generation below the tombstone (rows written before 2.12.3)', async () => {
    const ctx = setup(
      { generation: 295, deployedGeneration: null },
      { present: true, version: VERSION, generation: 294 }
    );
    await ctx.service.cleanupDueReplicas();
    expect(ctx.node.present).toBe(false);
    expect(ctx.removals).toEqual(['295', '294']);
    expect(ctx.isDeleted()).toBe(true);
    expect(ctx.orphan).toHaveBeenCalled();
  });

  it('names the generation the node acknowledged when it is recorded', async () => {
    const ctx = setup({ generation: 5, deployedGeneration: 3 }, { present: true, version: VERSION, generation: 3 });
    await ctx.service.cleanupDueReplicas('node-1');
    expect(ctx.removals).toEqual(['3']);
    expect(ctx.isDeleted()).toBe(true);
  });

  it('drops the row without a removal when the node no longer has the certificate', async () => {
    const ctx = setup({ generation: 2, deployedGeneration: 1 }, { present: false, version: '', generation: 0 });
    await ctx.service.cleanupDueReplicas();
    expect(ctx.dispatch.removeCertificateReplica).not.toHaveBeenCalled();
    expect(ctx.isDeleted()).toBe(true);
  });

  it('never removes a deployment newer than the tombstone', async () => {
    const ctx = setup({ generation: 4, deployedGeneration: null }, { present: true, version: VERSION, generation: 6 });
    await ctx.service.cleanupDueReplicas();
    expect(ctx.node.present).toBe(true);
    expect(ctx.removals.every((generation) => Number(generation) <= 4)).toBe(true);
    expect(ctx.isDeleted()).toBe(false);
    expect(ctx.updates.at(-1)).toMatchObject({ status: 'failed' });
    expect(String(ctx.updates.at(-1)?.lastError)).toContain('generations 4, 3, 2, 1 tried');
  });
});
