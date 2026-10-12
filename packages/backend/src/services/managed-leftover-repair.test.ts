import { describe, expect, it, vi } from 'vitest';
import { managedAvailabilityMembers, managedDatabaseInstances, managedStorageClusters, nodes } from '@/db/schema/index.js';
import { LEFTOVER_CONFIRMATION_MS, type ManagedLeftover, ManagedLeftoverRepair } from './managed-leftover-repair.js';

const NODE = 'db78707c-5894-4bd4-a2e4-080c80228f4a';
const ZEROED = '05d710cc-c9a3-4ef4-9b19-bd50e881d0cf';
const DELETED = '334c92c4-b058-4d74-94bb-40578d47404e';
const LIVE = 'a9704943-6982-4320-812f-ac0c6d86cffe';

/** A drizzle double: each table answers its rows, with or without a where/limit. */
function fakeDb(tables: {
  nodes: unknown[];
  storage: { id: string }[];
  databases: { id: string }[];
  members?: { id: string; nodeId: string }[];
}) {
  const rowsOf = (table: unknown) =>
    table === nodes
      ? tables.nodes
      : table === managedStorageClusters
        ? tables.storage
        : table === managedDatabaseInstances
          ? tables.databases
          : table === managedAvailabilityMembers
            ? (tables.members ?? [])
            : [];
  return {
    select: () => ({
      from: (table: unknown) => Object.assign(Promise.resolve(rowsOf(table)), { where: async () => rowsOf(table) }),
    }),
  };
}

const zeroed: ManagedLeftover = {
  id: ZEROED,
  record: 'unreadable',
  readError: 'decode',
  imageBytes: 2 ** 31,
  allocatedBytes: 0,
};
const deleted: ManagedLeftover = {
  id: DELETED,
  record: 'missing',
  containers: [`gateway-storage-${DELETED}-0`],
  imageBytes: 0,
  allocatedBytes: 0,
};
const live: ManagedLeftover = { id: LIVE, record: 'unreadable', imageBytes: 15 * 2 ** 30, allocatedBytes: 9 * 2 ** 30 };

function repair(
  options: { online?: boolean; storage?: { id: string }[]; list?: ManagedLeftover[]; listError?: string } = {}
) {
  let now = 1_000_000;
  const db = fakeDb({
    nodes: [{ id: NODE, type: 'storage' }],
    storage: options.storage ?? [{ id: LIVE }],
    databases: [],
  });
  const deps = {
    isNodeOnline: vi.fn(() => options.online ?? true),
    listLeftovers: vi.fn(async (_node: string, kind: string) =>
      options.listError
        ? { success: false, error: options.listError }
        : {
            success: true,
            detail: JSON.stringify({ items: kind === 'storage' ? (options.list ?? [zeroed, deleted, live]) : [] }),
          }
    ),
    removeLeftover: vi.fn(async () => ({ success: true })),
    audit: vi.fn(async () => {}),
    now: () => now,
  };
  const service = new ManagedLeftoverRepair(db as never, deps);
  return { service, deps, advance: (ms: number) => (now += ms) };
}

describe('managed leftovers on nodes (rc.8 O-5)', () => {
  it('removes leftovers Gateway has no instance of after two sightings 5+ minutes apart, and audits them', async () => {
    const { service, deps, advance } = repair();
    expect(await service.run()).toBe(0);
    advance(LEFTOVER_CONFIRMATION_MS - 1);
    expect(await service.run()).toBe(0);
    advance(1);
    expect(await service.run()).toBe(2);
    expect(deps.removeLeftover.mock.calls).toEqual([
      [NODE, 'storage', ZEROED],
      [NODE, 'storage', DELETED],
    ]);
    expect(deps.audit).toHaveBeenCalledWith({ nodeId: NODE, kind: 'storage', leftover: deleted });
  });

  it('never removes an id Gateway has an instance of, even with an unreadable record', async () => {
    const { service, deps, advance } = repair({ list: [live] });
    await service.run();
    advance(LEFTOVER_CONFIRMATION_MS);
    await service.run();
    expect(deps.removeLeftover).not.toHaveBeenCalled();
  });

  it('starts over when the node goes offline or cannot list its leftovers', async () => {
    const online = repair({ list: [deleted] });
    await online.service.run();
    online.deps.isNodeOnline.mockReturnValueOnce(false);
    online.advance(LEFTOVER_CONFIRMATION_MS);
    await online.service.run();
    online.advance(LEFTOVER_CONFIRMATION_MS);
    await online.service.run();
    expect(online.deps.removeLeftover).not.toHaveBeenCalled();

    const old = repair({ listError: 'unsupported managed storage action: leftovers' });
    await old.service.run();
    old.advance(LEFTOVER_CONFIRMATION_MS);
    await old.service.run();
    expect(old.deps.removeLeftover).not.toHaveBeenCalled();
  });

  it('keeps an id that got an instance meanwhile', async () => {
    const { service, deps, advance } = repair({ list: [deleted], storage: [{ id: LIVE }] });
    await service.run();
    advance(LEFTOVER_CONFIRMATION_MS);
    // A create took the id between the passes (Gateway rows come before the node's).
    const storage = [{ id: LIVE }, { id: DELETED }];
    (service as unknown as { db: unknown }).db = fakeDb({
      nodes: [{ id: NODE, type: 'storage' }],
      storage,
      databases: [],
    });
    await service.run();
    expect(deps.removeLeftover).not.toHaveBeenCalled();
  });

  it('removes an availability member whose database or member Gateway no longer has (a leaked set member)', async () => {
    const MEMBER = '03ecf0b8-553f-44ab-8641-511daadad9a2';
    const KEPT_MEMBER = 'b6d3e641-a3c9-456b-ab91-93ca7c011961';
    const SET = '082d2a9a-db4b-4b00-b2e7-2a566aec89b6';
    let now = 1_000_000;
    const items: ManagedLeftover[] = [
      // The database was deleted; this node's member stayed.
      { id: DELETED, record: 'member', setId: SET, memberId: MEMBER, imageBytes: 0, allocatedBytes: 0 },
      // A live database whose member here is still Gateway's.
      { id: LIVE, record: 'member', setId: SET, memberId: KEPT_MEMBER, imageBytes: 0, allocatedBytes: 0 },
      // A live database whose member on this node was removed while the node was unreachable.
      { id: ZEROED, record: 'member', setId: SET, memberId: MEMBER, imageBytes: 0, allocatedBytes: 0 },
    ];
    const db = fakeDb({
      nodes: [{ id: NODE, type: 'databases' }],
      storage: [],
      databases: [{ id: LIVE }, { id: ZEROED }],
      members: [{ id: KEPT_MEMBER, nodeId: NODE }],
    });
    const deps = {
      isNodeOnline: vi.fn(() => true),
      listLeftovers: vi.fn(async () => ({ success: true, detail: JSON.stringify({ items }) })),
      removeLeftover: vi.fn(async () => ({ success: true })),
      audit: vi.fn(async () => {}),
      now: () => now,
    };
    const service = new ManagedLeftoverRepair(db as never, deps);
    expect(await service.run()).toBe(0);
    now += LEFTOVER_CONFIRMATION_MS;
    expect(await service.run()).toBe(2);
    expect(deps.removeLeftover.mock.calls).toEqual([
      [NODE, 'database', DELETED, MEMBER],
      [NODE, 'database', ZEROED, MEMBER],
    ]);
  });
});
