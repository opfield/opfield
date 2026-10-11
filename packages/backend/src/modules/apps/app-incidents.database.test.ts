import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DrizzleClient } from '@/db/client.js';
import { disposableDatabase, migrateDatabase } from '@/db/migration-database.test-helpers.js';
import * as schema from '@/db/schema/index.js';
import { AppFolderService } from './app-folders.service.js';
import type { AppIncidentActions } from './app-incident-actions.js';
import { AppIncidentRunner } from './app-incident-runner.js';
import { AppIncidentTargetsReader } from './app-incident-targets.js';
import { AppIncidentsRepo } from './app-incidents.repo.js';
import { AppIncidentService } from './app-isolation.service.js';
import { AppMaintenanceService } from './app-maintenance.service.js';
import { AppMemberFreeze } from './app-member-freeze.js';
import { AppMembersReader, AppMembersService } from './app-members.service.js';
import { appPlacementForFolder, assertAppPlacement, assertPlacementNotIsolated } from './app-placement-guard.js';
import { AppsService } from './apps.service.js';

vi.mock('@/lib/created-resource-permissions.js', () => ({ grantCreatedResourcePermissions: vi.fn() }));

const url = process.env.GATEWAY_MIGRATION_TEST_DATABASE_URL;
const ALL = [
  'apps:view',
  'apps:create',
  'apps:edit',
  'apps:delete',
  'apps:env:manage',
  'apps:operate',
  'proxy:view',
  'proxy:edit',
  'docker:containers:view',
  'docker:containers:edit',
];

/**
 * Opt-in (GATEWAY_MIGRATION_TEST_DATABASE_URL): the kill switch and shutdown over the real tables. Isolation locks
 * the environment's routes and routes outside the app whose upstream is a member down (own switches untouched),
 * freezes members, refuses membership moves and app deletes, and release restores exactly. Shutdown overlays
 * maintenance with team access and Start restores it. Non-route items run through fake actions.
 */
describe.skipIf(!url)('app incidents on disposable PostgreSQL', () => {
  let database: Awaited<ReturnType<typeof disposableDatabase>>;
  let pool: pg.Pool;
  let db: DrizzleClient;
  let apps: AppsService;
  let members: AppMembersService;
  let service: AppIncidentService;
  let runner: AppIncidentRunner;
  let freeze: AppMemberFreeze;
  let repo: AppIncidentsRepo;
  const applied: string[] = [];
  const restored: string[] = [];
  const q = (text: string, values: unknown[] = []) => pool.query(text, values);
  let userId = '';
  let nginxNode = '';
  let dockerNode = '';
  const actor = () => ({ userId, scopes: ALL });
  const route = async (folderId: string | null, extra: Record<string, unknown> = {}) =>
    (
      await q(
        `insert into proxy_hosts (slug, node_id, created_by_id, folder_id, type, maintenance_enabled, upstream_kind, docker_node_id, docker_container_name)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
        [
          `r-${randomUUID().slice(0, 6)}`,
          nginxNode,
          userId,
          folderId,
          extra.type ?? 'proxy',
          extra.own ?? false,
          extra.upstreamKind ?? 'manual',
          extra.dockerNodeId ?? null,
          extra.dockerContainerName ?? null,
        ]
      )
    ).rows[0].id as string;
  const mode = async (id: string) =>
    (await q('select maintenance_enabled, app_maintenance_mode, enabled from proxy_hosts where id = $1', [id])).rows[0];
  const settle = async (incidents: Array<{ id: string }>) => {
    for (const incident of incidents) await runner.run(incident.id);
  };

  beforeAll(async () => {
    database = await disposableDatabase(url!, 'app_incidents');
    pool = database.pool;
    await migrateDatabase(pool);
    db = drizzle(pool, { schema });
    const folders = new AppFolderService(db);
    const audit = { log: vi.fn().mockResolvedValue(true) };
    const reader = new AppMembersReader(db, folders);
    apps = new AppsService(db, audit as never, folders, reader);
    members = new AppMembersService(db, audit as never, folders, apps);
    const maintenance = new AppMaintenanceService(db);
    repo = new AppIncidentsRepo(db);
    maintenance.setIncidentsRepo(repo);
    apps.setMaintenanceHooks(maintenance);
    freeze = new AppMemberFreeze(db, repo);
    const actions: AppIncidentActions = {
      apply: async (item) => {
        applied.push(item.itemKey);
        if (item.itemKind === 'route_overlay') await maintenance.applyModes([String(item.ref.routeId)]);
        if (item.itemKind === 'container_network') {
          // What the daemon reports it removed: the networks the release reconnects.
          return { status: 'applied', priorState: { endpoints: [{ networkId: 'net-app-1', networkName: 'app-net' }] } };
        }
        return { status: 'applied', priorState: { recorded: item.itemKey } };
      },
      restore: async (item) => {
        restored.push(item.itemKey);
        if (item.itemKind === 'route_overlay') await maintenance.applyModes([String(item.ref.routeId)]);
        return { status: 'restored' };
      },
    };
    const leases = {
      claim: async () => ({ acquired: true as const, token: 't', claimedAt: 0 }),
      hold: () => ({ stop: () => undefined }) as never,
      release: async () => undefined,
    };
    runner = new AppIncidentRunner(repo, actions, { changed: () => freeze.invalidate() }, leases as never);
    service = new AppIncidentService(
      db,
      apps,
      repo,
      new AppIncidentTargetsReader(db, reader),
      runner,
      freeze,
      audit as never
    );
    apps.setIncidentGuard(service);
    members.setIncidentCheck((environmentId) => service.environmentHasIncident(environmentId));
    const group = (await q(`insert into permission_groups (name) values ('apps-inc') returning id`)).rows[0].id;
    userId = (
      await q(`insert into users (email, name, group_id) values ('inc@example.test', 'I', $1) returning id`, [group])
    ).rows[0].id;
    nginxNode = (await q(`insert into nodes (hostname, slug, type) values ('ng', 'ng', 'nginx') returning id`)).rows[0]
      .id;
    dockerNode = (await q(`insert into nodes (hostname, slug, type) values ('dk', 'dk', 'docker') returning id`))
      .rows[0].id;
  }, 180_000);

  afterAll(async () => {
    await database?.drop();
  });

  it('isolates, freezes and restores exactly', async () => {
    const app = await apps.create(actor(), { name: 'Shop' });
    const env = app.environments[0];
    const member = await route(env.placementFolderIds.routes!, { own: true });
    const redirect = await route(env.placementFolderIds.routes!, { type: 'redirect' });
    await q(
      `insert into docker_container_folder_assignments (node_id, resource_type, resource_key, container_name, folder_id)
       values ($1, 'container', 'web', 'web', $2)`,
      [dockerNode, env.placementFolderIds.containers]
    );
    const derived = await route(null, {
      upstreamKind: 'docker_container',
      dockerNodeId: dockerNode,
      dockerContainerName: 'web',
    });
    const unrelated = await route(null);

    const preview = await service.preview(actor(), app.id, 'isolation', null);
    expect(preview.summary).toMatchObject({ routes: 3, containers: 1 });

    await expect(service.isolate(actor(), app.id, null, 'shop')).rejects.toMatchObject({
      code: 'APP_CONFIRM_NAME_MISMATCH',
    });
    const incidents = await service.isolate(actor(), app.id, null, 'Shop');
    expect(incidents).toHaveLength(1);
    await settle(incidents);
    expect(await mode(member)).toMatchObject({ maintenance_enabled: true, app_maintenance_mode: 'lockdown' });
    expect(await mode(derived)).toMatchObject({ maintenance_enabled: false, app_maintenance_mode: 'lockdown' });
    expect(await mode(unrelated)).toMatchObject({ app_maintenance_mode: 'off' });
    expect(applied).toEqual(expect.arrayContaining([`route:${member}`, `route:${derived}`, `route:${redirect}`]));
    expect((await repo.items(incidents[0]!.id)).find((item) => item.itemKey === `route:${redirect}`)?.itemKind).toBe(
      'route_withdraw'
    );

    await expect(freeze.assertNotFrozen({ kind: 'route', id: member })).rejects.toMatchObject({ code: 'APP_ISOLATED' });
    await expect(freeze.assertNotFrozen({ kind: 'route', id: derived })).rejects.toMatchObject({
      code: 'APP_ISOLATED',
    });
    await expect(freeze.assertNotFrozen({ kind: 'container', nodeId: dockerNode, name: 'web' })).rejects.toMatchObject({
      code: 'APP_ISOLATED',
    });
    await expect(freeze.assertNotFrozen({ kind: 'route', id: unrelated })).resolves.toBeUndefined();
    await expect(freeze.assertNoOpenIncident({ kind: 'route', id: member })).rejects.toMatchObject({
      code: 'APP_ISOLATED',
    });
    await expect(freeze.assertNoOpenIncident({ kind: 'route', id: unrelated })).resolves.toBeUndefined();
    // Deleting or unbinding a member (the delete paths call assertNoOpenIncident) is refused while isolated.
    const web = { kind: 'container', nodeId: dockerNode, name: 'web' } as const;
    await expect(freeze.assertNoOpenIncident(web)).rejects.toMatchObject({ code: 'APP_ISOLATED' });
    // A network the release reconnects the member to stays; others do not matter.
    await expect(freeze.assertNetworkNotHeld(dockerNode, { id: 'net-app-1', name: 'app-net' })).rejects.toMatchObject({
      code: 'APP_ISOLATED',
      message: expect.stringContaining('app-net'),
    });
    await expect(freeze.assertNetworkNotHeld(dockerNode, { id: 'other', name: 'other' })).resolves.toBeUndefined();
    // Nothing new is placed in the isolated environment.
    await expect(assertAppPlacement(db, 'routes', env.placementFolderIds.routes, [nginxNode])).rejects.toMatchObject({
      code: 'APP_ISOLATED',
    });
    // No shutdown on top of the kill switch, for the whole app or the environment.
    await expect(service.shutdown(actor(), app.id, null)).rejects.toMatchObject({
      code: 'APP_ISOLATED',
      message: expect.stringContaining('turn the kill switch off before shutting it down'),
    });
    await expect(service.shutdown(actor(), app.id, [env.id])).rejects.toMatchObject({ code: 'APP_ISOLATED' });
    expect(await repo.openFor(env.id, 'shutdown')).toBeNull();

    const moved = await members.place(actor(), { target: null, members: [{ type: 'route', id: member }] } as never);
    expect(moved.refused).toEqual([expect.objectContaining({ code: 'APP_INCIDENT_ACTIVE' })]);
    await expect(apps.delete(actor(), app.id)).rejects.toMatchObject({ code: 'APP_INCIDENT_ACTIVE' });
    expect((await apps.list(ALL)).find((item) => item.id === app.id)?.incident).toBe('isolated');
    const detail = await apps.get(ALL, app.id);
    expect(detail.environments[0]!.incidents).toEqual([expect.objectContaining({ kind: 'isolation' })]);
    await expect(service.isolate(actor(), app.id, null, 'Shop')).rejects.toMatchObject({ code: 'APP_INCIDENT_ACTIVE' });

    const releasing = await service.release(actor(), app.id, null);
    await settle(releasing);
    expect((await repo.get(incidents[0]!.id))?.state).toBe('released');
    expect(await mode(member)).toMatchObject({ maintenance_enabled: true, app_maintenance_mode: 'off' });
    expect(await mode(derived)).toMatchObject({ maintenance_enabled: false, app_maintenance_mode: 'off' });
    expect(restored).toEqual(expect.arrayContaining([`route:${member}`, `container:${dockerNode}:web`]));
    freeze.invalidate();
    await expect(freeze.assertNotFrozen({ kind: 'route', id: member })).resolves.toBeUndefined();
    const appNet = { id: 'net-app-1', name: 'app-net' };
    await expect(freeze.assertNetworkNotHeld(dockerNode, appNet)).resolves.toBeUndefined();
    expect((await apps.list(ALL)).find((item) => item.id === app.id)?.incident).toBe('none');
    // After the release a shutdown runs again and Start restores it.
    const shutdown = await service.shutdown(actor(), app.id, null);
    await settle(shutdown);
    await settle(await service.start(actor(), app.id, null));
    expect((await repo.get(shutdown[0]!.id))?.state).toBe('released');
  });

  it('shuts down with the maintenance page and starts back to each route own state', async () => {
    const app = await apps.create(actor(), { name: 'Blog' });
    const env = app.environments[0];
    const own = await route(env.placementFolderIds.routes!, { own: true });
    const plain = await route(env.placementFolderIds.routes!);
    const incidents = await service.shutdown(actor(), app.id, [env.id]);
    await settle(incidents);
    expect(await mode(own)).toMatchObject({ maintenance_enabled: true, app_maintenance_mode: 'maintenance' });
    expect(await mode(plain)).toMatchObject({ maintenance_enabled: false, app_maintenance_mode: 'maintenance' });
    // Edits of members are not frozen by a shutdown (Start picks them up).
    await expect(freeze.assertNotFrozen({ kind: 'route', id: plain })).resolves.toBeUndefined();
    // Deleting or unbinding a member is: Start would no longer find what it restores.
    await q(
      `insert into docker_container_folder_assignments (node_id, resource_type, resource_key, container_name, folder_id)
       values ($1, 'container', 'blog-web', 'blog-web', $2)`,
      [dockerNode, env.placementFolderIds.containers]
    );
    const kept = { kind: 'container', nodeId: dockerNode, name: 'blog-web' } as const;
    await expect(freeze.assertNoOpenIncident(kept)).rejects.toMatchObject({ code: 'APP_INCIDENT_ACTIVE' });
    // Placing new resources in a shut-down environment stays allowed.
    const placement = await appPlacementForFolder(db, 'routes', env.placementFolderIds.routes);
    await expect(assertPlacementNotIsolated(db, placement)).resolves.toBeUndefined();
    // Changes that need a running environment (moving a key-value store to Valkey) are refused while it is shut down.
    await expect(freeze.assertNoOpenIncident({ kind: 'route', id: plain })).rejects.toMatchObject({
      code: 'APP_INCIDENT_ACTIVE',
      message: expect.stringContaining('Blog'),
    });
    expect((await apps.list(ALL)).find((item) => item.id === app.id)?.incident).toBe('stopped');
    await settle(await service.start(actor(), app.id, [env.id]));
    expect(await mode(own)).toMatchObject({ maintenance_enabled: true, app_maintenance_mode: 'off' });
    expect(await mode(plain)).toMatchObject({ maintenance_enabled: false, app_maintenance_mode: 'off' });
    await expect(service.start(actor(), app.id, [env.id])).rejects.toMatchObject({ code: 'APP_INCIDENT_NOT_ACTIVE' });
    await expect(freeze.assertNoOpenIncident({ kind: 'route', id: plain })).resolves.toBeUndefined();
  });

  it('needs apps:operate on every environment it touches', async () => {
    const app = await apps.create(actor(), { name: 'Docs' });
    const env = app.environments[0];
    const envOnly = ['apps:view', `apps:operate:env/${env.id}`];
    await expect(service.shutdown({ userId, scopes: envOnly }, app.id, null)).rejects.toMatchObject({
      statusCode: 403,
    });
    const incidents = await service.shutdown({ userId, scopes: envOnly }, app.id, [env.id]);
    await settle(incidents);
    await settle(await service.start({ userId, scopes: envOnly }, app.id, [env.id]));
  });
});
