import { describe, expect, it, vi } from 'vitest';
import { nodes } from '@/db/schema/index.js';
import { AccessListService } from './access-list.service.js';

vi.mock('@/lib/resource-scope-cleanup.js', () => ({
  transactionWithScopeCleanup: (db: any, work: (tx: any) => unknown) => work(db),
}));
const policySync = vi.hoisted(() => vi.fn());
vi.mock('@/modules/access-signin/access-policy-sync.js', () => ({ scheduleAccessPolicySync: policySync }));

const ACCESS_LIST_ID = '11111111-1111-4111-8111-111111111111';

describe('Access list deletion', () => {
  it('removes the credentials from every connected Nginx node, not only from nodes of routes that use the list', async () => {
    const nginxNodes = [{ id: 'ingress-a' }, { id: 'ingress-b' }, { id: 'ingress-offline' }];
    const db = {
      query: {
        accessLists: { findFirst: vi.fn().mockResolvedValue({ id: ACCESS_LIST_ID, name: 'staff' }) },
        // Deletion requires that no route and no Pages project uses the list any more.
        proxyHosts: { findMany: vi.fn().mockResolvedValue([]) },
        pageProjects: { findMany: vi.fn().mockResolvedValue([]) },
      },
      select: vi.fn(() => {
        let rows: unknown[] = [];
        const query: any = {
          from: (table: unknown) => {
            rows = table === nodes ? nginxNodes : [];
            return query;
          },
          where: async () => rows,
        };
        return query;
      }),
      delete: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
    } as any;
    const removeHtpasswd = vi.fn().mockResolvedValue({ success: true });
    const nodeDispatch = {
      removeHtpasswd,
      isNodeConnected: vi.fn((nodeId: string) => nodeId !== 'ingress-offline'),
    } as any;
    const service = new AccessListService(
      db,
      {} as any,
      {} as any,
      { log: vi.fn().mockResolvedValue(undefined) } as any,
      nodeDispatch,
      {} as any
    );

    await service.delete(ACCESS_LIST_ID, 'user-id');

    expect(removeHtpasswd.mock.calls).toEqual([
      ['ingress-a', ACCESS_LIST_ID],
      ['ingress-b', ACCESS_LIST_ID],
    ]);
    expect(db.delete).toHaveBeenCalled();
    // The nodes drop the list from the access policy they check.
    expect(policySync).toHaveBeenCalled();
  });
});
