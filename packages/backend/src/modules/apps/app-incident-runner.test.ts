import { describe, expect, it, vi } from 'vitest';
import type { AppIncident, AppIncidentItem } from '@/db/schema/index.js';
import { LEGACY_DATABASE_LINK_NETWORK_PREFIX } from '@/lib/legacy-compat.js';
import type { AppIncidentActions, IncidentActionOutcome } from './app-incident-actions.js';
import { AppIncidentRunner } from './app-incident-runner.js';
import type { IncidentTargets } from './app-incident-targets.js';
import type { NewIncidentItem } from './app-incidents.repo.js';
import { buildIsolationItems, summarizeIsolation } from './app-isolation.service.js';
import { buildShutdownItems, summarizeShutdown } from './app-shutdown.service.js';

/** An in-memory incident store with the repo methods the runner uses. */
function memoryRepo(incident: AppIncident, items: NewIncidentItem[]) {
  let state: AppIncident = { ...incident };
  const rows: AppIncidentItem[] = items.map((item, index) => ({
    id: `item-${index}`,
    incidentId: incident.id,
    itemKind: item.itemKind,
    itemKey: item.itemKey,
    phase: item.phase,
    ref: item.ref,
    priorState: item.priorState ?? null,
    status: 'pending',
    attempts: 0,
    lastError: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  }));
  return {
    rows,
    get state() {
      return state;
    },
    repo: {
      get: vi.fn(async () => ({ ...state })),
      items: vi.fn(async () => rows.map((row) => ({ ...row }))),
      open: vi.fn(async () => (['applying', 'active', 'releasing'].includes(state.state) ? [{ ...state }] : [])),
      updateItem: vi.fn(async (id: string, patch: Partial<AppIncidentItem>) => {
        const row = rows.find((item) => item.id === id)!;
        Object.assign(row, patch);
      }),
      setState: vi.fn(async (_id: string, next: AppIncident['state'], patch: Partial<AppIncident> = {}) => {
        state = { ...state, ...patch, state: next };
        return { ...state };
      }),
      setLastError: vi.fn(async (_id: string, lastError: string | null) => {
        state = { ...state, lastError };
      }),
    },
  };
}

const leases = {
  claim: vi.fn(async () => ({ acquired: true as const, token: 't', claimedAt: 0 })),
  hold: vi.fn(() => ({ stop: () => undefined }) as never),
  release: vi.fn(async () => undefined),
};

const INCIDENT: AppIncident = {
  id: 'incident-1',
  batchId: 'batch-1',
  appId: 'app-1',
  environmentId: 'env-1',
  kind: 'isolation',
  state: 'applying',
  startedById: 'user-1',
  startedAt: new Date(),
  releasedById: null,
  releasedAt: null,
  lastError: null,
  updatedAt: new Date(),
};

const ITEMS: NewIncidentItem[] = [
  { itemKind: 'container_network', itemKey: 'container:n:web', phase: 40, ref: { nodeId: 'n', name: 'web' } },
  { itemKind: 'route_overlay', itemKey: 'route:r1', phase: 10, ref: { routeId: 'r1' } },
  { itemKind: 'container_link', itemKey: 'link:l1', phase: 20, ref: { linkId: 'l1' } },
  { itemKind: 'database_publication', itemKey: 'database-publication:d1', phase: 30, ref: { databaseId: 'd1' } },
];

describe('App incident runner', () => {
  it('applies items phase by phase, keeps the prior state of each and ends active', async () => {
    const store = memoryRepo(INCIDENT, ITEMS);
    const order: string[] = [];
    const actions: AppIncidentActions = {
      apply: vi.fn(async (item) => {
        order.push(item.itemKind);
        return { status: 'applied', priorState: { before: item.itemKey } } as IncidentActionOutcome;
      }),
      restore: vi.fn(),
    };
    const changed = vi.fn();
    const runner = new AppIncidentRunner(store.repo as never, actions, { changed }, leases as never);
    await runner.run(INCIDENT.id);
    expect(order).toEqual(['route_overlay', 'container_link', 'database_publication', 'container_network']);
    expect(store.rows.every((row) => row.status === 'applied')).toBe(true);
    expect(store.rows.find((row) => row.itemKey === 'link:l1')!.priorState).toEqual({ before: 'link:l1' });
    expect(store.state.state).toBe('active');
    expect(changed).toHaveBeenCalled();
  });

  it('keeps a failed item failed with its error and retries only it on the next run', async () => {
    const store = memoryRepo(INCIDENT, ITEMS);
    let failNetwork = true;
    const actions: AppIncidentActions = {
      apply: vi.fn(async (item) => {
        if (item.itemKind === 'container_network' && failNetwork) throw new Error('node offline');
        return { status: 'applied', priorState: { ok: true } } as IncidentActionOutcome;
      }),
      restore: vi.fn(),
    };
    const runner = new AppIncidentRunner(store.repo as never, actions, { changed: vi.fn() }, leases as never);
    await runner.run(INCIDENT.id);
    const network = store.rows.find((row) => row.itemKind === 'container_network')!;
    expect(network).toMatchObject({ status: 'failed', lastError: 'node offline', attempts: 1 });
    expect(store.state).toMatchObject({ state: 'active' });
    expect(store.state.lastError).toContain('1 item');

    failNetwork = false;
    (actions.apply as ReturnType<typeof vi.fn>).mockClear();
    await runner.runOpen();
    expect(actions.apply).toHaveBeenCalledTimes(1);
    expect(network).toMatchObject({ status: 'applied', attempts: 2 });
    expect(store.state.lastError).toBeNull();
  });

  it('restores in reverse phase order from the recorded prior state and ends released', async () => {
    const store = memoryRepo(INCIDENT, ITEMS);
    const restoredWith: Array<[string, unknown]> = [];
    const actions: AppIncidentActions = {
      apply: vi.fn(
        async (item) => ({ status: 'applied', priorState: { from: item.itemKey } }) as IncidentActionOutcome
      ),
      restore: vi.fn(async (item) => {
        restoredWith.push([item.itemKind, item.priorState]);
        // A route overlay is marked restored before its recompute, so the recompute drops it.
        if (item.itemKind === 'route_overlay') {
          expect(store.rows.find((row) => row.id === item.id)!.status).toBe('restored');
        }
        return (
          item.itemKind === 'container_link' ? { status: 'gone' } : { status: 'restored' }
        ) as IncidentActionOutcome;
      }),
    };
    const released = vi.fn();
    const runner = new AppIncidentRunner(store.repo as never, actions, { changed: vi.fn(), released }, leases as never);
    await runner.run(INCIDENT.id);
    await store.repo.setState(INCIDENT.id, 'releasing', { releasedById: 'user-2' });
    await runner.run(INCIDENT.id);
    expect(restoredWith.map(([kind]) => kind)).toEqual([
      'container_network',
      'database_publication',
      'container_link',
      'route_overlay',
    ]);
    expect(restoredWith[0]![1]).toEqual({ from: 'container:n:web' });
    expect(store.rows.find((row) => row.itemKind === 'container_link')!.status).toBe('gone');
    expect(store.state.state).toBe('released');
    expect(released).toHaveBeenCalledTimes(1);
  });

  it('keeps releasing while a restore fails and finishes once it succeeds', async () => {
    const store = memoryRepo(INCIDENT, ITEMS);
    let failRestore = true;
    const actions: AppIncidentActions = {
      apply: vi.fn(async () => ({ status: 'applied', priorState: { x: 1 } }) as IncidentActionOutcome),
      restore: vi.fn(async (item) => {
        if (item.itemKind === 'container_network' && failRestore) throw new Error('network gone');
        return { status: 'restored' } as IncidentActionOutcome;
      }),
    };
    const runner = new AppIncidentRunner(store.repo as never, actions, { changed: vi.fn() }, leases as never);
    await runner.run(INCIDENT.id);
    await store.repo.setState(INCIDENT.id, 'releasing');
    await runner.run(INCIDENT.id);
    expect(store.state.state).toBe('releasing');
    expect(store.rows.find((row) => row.itemKind === 'container_network')!.status).toBe('restore_failed');
    failRestore = false;
    await runner.runOpen();
    expect(store.state.state).toBe('released');
  });

  it('keeps what a restore could not put back as the detail of a done item, never as a failure', async () => {
    const store = memoryRepo(INCIDENT, ITEMS);
    const note = `Skipped network ${LEGACY_DATABASE_LINK_NETWORK_PREFIX}1: it no longer exists`;
    const actions: AppIncidentActions = {
      apply: vi.fn(async () => ({ status: 'applied', priorState: { x: 1 } }) as IncidentActionOutcome),
      restore: vi.fn(async (item) =>
        item.itemKind === 'container_network'
          ? ({ status: 'restored', detail: note } as IncidentActionOutcome)
          : ({ status: 'gone' } as IncidentActionOutcome)
      ),
    };
    const runner = new AppIncidentRunner(store.repo as never, actions, { changed: vi.fn() }, leases as never);
    await runner.run(INCIDENT.id);
    await store.repo.setState(INCIDENT.id, 'releasing');
    await runner.run(INCIDENT.id);
    const network = store.rows.find((row) => row.itemKind === 'container_network');
    expect(network).toMatchObject({ status: 'restored', lastError: note });
    const link = store.rows.find((row) => row.itemKind === 'container_link');
    expect(link).toMatchObject({ status: 'gone', lastError: null });
    expect(store.state.state).toBe('released');
    expect(actions.restore).toHaveBeenCalledTimes(4);
  });

  it('marks items that never applied as restored without touching them', async () => {
    const store = memoryRepo(INCIDENT, ITEMS);
    const actions: AppIncidentActions = {
      apply: vi.fn(async () => {
        throw new Error('down');
      }),
      restore: vi.fn(async () => ({ status: 'restored' }) as IncidentActionOutcome),
    };
    const runner = new AppIncidentRunner(store.repo as never, actions, { changed: vi.fn() }, leases as never);
    await runner.run(INCIDENT.id);
    await store.repo.setState(INCIDENT.id, 'releasing');
    await runner.run(INCIDENT.id);
    // Only the route overlay (in effect from creation) is recomputed.
    expect((actions.restore as ReturnType<typeof vi.fn>).mock.calls.map(([item]) => item.itemKind)).toEqual([
      'route_overlay',
    ]);
    expect(store.state.state).toBe('released');
  });
});

function targets(overrides: Partial<IncidentTargets> = {}): IncidentTargets {
  return {
    environmentId: 'env-1',
    members: [
      { type: 'container', id: 'web', name: 'web', environmentId: 'env-1', nodeIds: ['n1'], nodeId: 'n1' },
      { type: 'container', id: 'cron', name: 'cron', environmentId: 'env-1', nodeIds: ['n1'], nodeId: 'n1' },
    ],
    routes: [
      {
        id: 'r-app',
        type: 'proxy',
        rawConfigEnabled: false,
        isSystem: false,
        enabled: true,
        maintenanceEnabled: false,
        appMaintenanceMode: 'off',
        domainNames: ['shop.example.com'],
        derived: false,
        pages: false,
      },
      {
        id: 'r-redirect',
        type: 'redirect',
        rawConfigEnabled: false,
        isSystem: false,
        enabled: true,
        maintenanceEnabled: false,
        appMaintenanceMode: 'off',
        domainNames: ['old.example.com'],
        derived: false,
        pages: false,
      },
      {
        id: 'r-outside',
        type: 'proxy',
        rawConfigEnabled: false,
        isSystem: false,
        enabled: true,
        maintenanceEnabled: false,
        appMaintenanceMode: 'off',
        domainNames: ['legacy.example.com'],
        derived: true,
        pages: false,
      },
      {
        id: 'r-pages',
        type: 'proxy',
        rawConfigEnabled: false,
        isSystem: false,
        enabled: true,
        maintenanceEnabled: false,
        appMaintenanceMode: 'off',
        domainNames: ['help.example.com'],
        derived: true,
        pages: true,
      },
      {
        id: 'r-off',
        type: 'proxy',
        rawConfigEnabled: false,
        isSystem: false,
        enabled: false,
        maintenanceEnabled: false,
        appMaintenanceMode: 'off',
        domainNames: ['off.example.com'],
        derived: false,
        pages: false,
      },
    ],
    containers: [
      { nodeId: 'n1', name: 'web', running: true, owner: { type: 'container', id: 'web' } },
      { nodeId: 'n1', name: 'cron', running: false, owner: { type: 'container', id: 'cron' } },
      { nodeId: 'n2', name: 'web-replica', running: true, owner: { type: 'container', id: 'web' } },
      { nodeId: 'n1', name: 'search-api-1', running: true, owner: { type: 'compose', id: 'p1' } },
    ],
    containerLinks: [{ id: 'link-1', desiredState: 'active' }],
    databaseBindings: [{ id: 'db-binding-1', desiredState: 'active' }],
    storageBindings: [],
    secureLinks: [{ id: 'sl-1', incidentSuspendedBy: null }],
    databases: [
      {
        id: 'db-1',
        connectionId: 'c1',
        name: 'orders',
        status: 'ready',
        publishedPort: 15432,
        publishedNativePort: null,
      },
      {
        id: 'db-2',
        connectionId: 'c2',
        name: 'cache',
        status: 'paused',
        publishedPort: null,
        publishedNativePort: null,
      },
    ],
    storages: [
      { id: 's-1', connectionId: 'c3', name: 'assets', status: 'ready', publishS3: false, publishedPort: 9000 },
    ],
    deployments: [{ id: 'dep-1', nodeId: 'n1', name: 'api', status: 'ready' }],
    composeProjects: [{ id: 'p1', nodeId: 'n1', name: 'search', status: 'running' }],
    ...overrides,
  };
}

describe('Incident items', () => {
  it('isolation locks routes down or withdraws them and covers links, publications and every container', () => {
    const items = buildIsolationItems(targets(), new Set());
    const byKey = new Map(items.map((item) => [item.itemKey, item]));
    expect(byKey.get('route:r-app')?.itemKind).toBe('route_overlay');
    expect(byKey.get('route:r-outside')?.itemKind).toBe('route_overlay');
    expect(byKey.get('route:r-redirect')?.itemKind).toBe('route_withdraw');
    expect(byKey.has('route:r-off')).toBe(false);
    expect(byKey.get('link:l')).toBeUndefined();
    expect(byKey.get('link:link-1')?.phase).toBe(20);
    expect(byKey.get('database-publication:db-1')?.phase).toBe(30);
    expect(byKey.has('database-publication:db-2')).toBe(false);
    expect(byKey.has('storage-publication:s-1')).toBe(false);
    expect(items.filter((item) => item.itemKind === 'container_network').map((item) => item.itemKey)).toEqual([
      'container:n1:web',
      'container:n1:cron',
      'container:n2:web-replica',
      'container:n1:search-api-1',
    ]);
    expect(summarizeIsolation(items)).toMatchObject({
      routes: 4,
      links: 1,
      bindings: 1,
      secureLinks: 1,
      composeProjects: 1,
    });
  });

  it('never touches the route of the Opfield public URL', () => {
    const items = buildIsolationItems(targets(), new Set(['r-app']));
    expect(items.some((item) => item.itemKey === 'route:r-app')).toBe(false);
  });

  it('shutdown records only what runs and puts routes and Pages routes in maintenance', () => {
    const items = buildShutdownItems(targets(), new Set());
    const keys = items.map((item) => item.itemKey);
    expect(keys).toContain('route:r-app');
    expect(keys).toContain('route:r-pages');
    expect(keys).not.toContain('route:r-outside');
    expect(keys).not.toContain('route:r-redirect');
    expect(keys).toContain('container:n1:web');
    expect(keys).not.toContain('container:n1:cron');
    expect(keys).not.toContain('container:n2:web-replica');
    expect(keys).toContain('deployment:dep-1');
    expect(keys).toContain('compose:p1');
    expect(keys).toContain('database:db-1');
    expect(keys).not.toContain('database:db-2');
    expect(keys).toContain('storage:s-1');
    expect(summarizeShutdown(items)).toEqual({
      containers: 1,
      deployments: 1,
      composeProjects: 1,
      databases: 1,
      storages: 1,
      routes: 1,
      pagesRoutes: 1,
    });
  });
});
