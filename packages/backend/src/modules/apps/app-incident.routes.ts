import { z } from '@hono/zod-openapi';
import { container } from '@/container.js';
import { appRoute, jsonBody, okJson, pathParamSchema, UnknownDataResponseSchema } from '@/lib/openapi.js';
import { AppIncidentService } from './app-isolation.service.js';
import { type AppsRouter, appActor } from './app-route-helpers.js';

const TAGS = ['Apps'];
const AppParams = pathParamSchema('id');

/** `environmentIds: null` (or omitted) = every environment of the app (app-wide apps:operate). */
export const AppIncidentScopeSchema = z
  .object({ environmentIds: z.array(z.string().uuid()).min(1).nullable().optional() })
  .strict();
export const AppIsolationBodySchema = z
  .object({
    environmentIds: z.array(z.string().uuid()).min(1).nullable().optional(),
    confirmName: z.string().max(255),
  })
  .strict();
export const AppIncidentPreviewQuerySchema = z.object({
  kind: z.enum(['shutdown', 'isolation']),
  /** Comma-separated environment ids; omitted = every environment. */
  environmentIds: z.string().optional(),
});

const SCOPE_TEXT =
  'environmentIds limits it to those environments (apps:operate on each); null or omitted means every environment (apps:operate on the app).';

export const shutdownAppRoute = appRoute({
  method: 'post',
  path: '/{id}/shutdown',
  tags: TAGS,
  summary: 'Shut down an app',
  description: `Stops what can be stopped in each environment: running containers, deployments and Compose projects stop, managed databases and storage pause, and the routes of the environment and of its Pages projects show the maintenance page (team access works). What ran is recorded, so Start brings back exactly that. Runs in the background: the incidents come back with state applying and their items. ${SCOPE_TEXT}`,
  request: { params: AppParams, ...jsonBody(AppIncidentScopeSchema) },
  responses: okJson(UnknownDataResponseSchema),
});

export const startAppRoute = appRoute({
  method: 'post',
  path: '/{id}/start',
  tags: TAGS,
  summary: 'Start an app after a shutdown',
  description: `Restores what the shutdown changed, item by item, and only where the resource is still as the shutdown left it (a container started by hand meanwhile is left alone). ${SCOPE_TEXT}`,
  request: { params: AppParams, ...jsonBody(AppIncidentScopeSchema) },
  responses: okJson(UnknownDataResponseSchema),
});

export const isolateAppRoute = appRoute({
  method: 'post',
  path: '/{id}/isolation',
  tags: TAGS,
  summary: 'Isolate an app (kill switch)',
  description: `For a security incident; confirmName must be the app name. Routes of the environment and routes whose upstream is a member show the maintenance page without team access (other routes are withdrawn), container links and database/storage bindings touching a member are suspended, Secure Links to members close, direct database/storage publications are suspended (ports kept), and every member container loses all its networks (a host-network container is stopped). Members are frozen until the kill switch is turned off: recreate, deploy, Compose apply, migration, route and membership changes answer 409 APP_ISOLATED. Every change is recorded with its prior state and restored exactly. ${SCOPE_TEXT}`,
  request: { params: AppParams, ...jsonBody(AppIsolationBodySchema) },
  responses: okJson(UnknownDataResponseSchema),
});

export const releaseAppIsolationRoute = appRoute({
  method: 'delete',
  path: '/{id}/isolation',
  tags: TAGS,
  summary: 'Turn the kill switch off',
  description: `Restores every recorded item from its prior state in reverse order. Items whose resource is gone end as gone, and so does a network removed meanwhile (skipped, named in the item detail); a failed restore is retried until it succeeds (the incident stays releasing). ${SCOPE_TEXT}`,
  request: { params: AppParams, ...jsonBody(AppIncidentScopeSchema) },
  responses: okJson(UnknownDataResponseSchema),
});

export const listAppIncidentsRoute = appRoute({
  method: 'get',
  path: '/{id}/incidents',
  tags: TAGS,
  summary: 'App incidents',
  description:
    'Shutdowns and kill switch isolations of the environments you can view: open ones first, then recent ones, each with its items (kind, label, status pending/applied/failed/restored/restore_failed/gone, attempts, last error, and detail: what a restored or gone item could not put back as it was).',
  request: { params: AppParams },
  responses: okJson(UnknownDataResponseSchema),
});

export const previewAppIncidentRoute = appRoute({
  method: 'get',
  path: '/{id}/incidents/preview',
  tags: TAGS,
  summary: 'Preview a shutdown or kill switch',
  description:
    'What a shutdown or a kill switch would change now, per environment and in total (counts of routes, containers, Compose projects, links, bindings, publications, databases, storage). Nothing changes. Same scope rules as starting it.',
  request: { params: AppParams, query: AppIncidentPreviewQuerySchema },
  responses: okJson(UnknownDataResponseSchema),
});

function environmentIdsFrom(value: string | null | undefined | string[]): string[] | null {
  if (value === undefined || value === null) return null;
  if (Array.isArray(value)) return value;
  const ids = value
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  return ids.length ? ids : null;
}

export function registerAppIncidentRoutes(router: AppsRouter): void {
  const service = () => container.resolve(AppIncidentService);

  router.openapi(previewAppIncidentRoute, async (c) => {
    const query = AppIncidentPreviewQuerySchema.parse(c.req.query());
    const data = await service().preview(
      appActor(c),
      c.req.param('id')!,
      query.kind,
      environmentIdsFrom(query.environmentIds)
    );
    return c.json({ data });
  });

  router.openapi(listAppIncidentsRoute, async (c) => {
    return c.json({ data: await service().list(appActor(c).scopes, c.req.param('id')!) });
  });

  router.openapi(shutdownAppRoute, async (c) => {
    const body = AppIncidentScopeSchema.parse(await c.req.json().catch(() => ({})));
    return c.json({ data: await service().shutdown(appActor(c), c.req.param('id')!, body.environmentIds ?? null) });
  });

  router.openapi(startAppRoute, async (c) => {
    const body = AppIncidentScopeSchema.parse(await c.req.json().catch(() => ({})));
    return c.json({ data: await service().start(appActor(c), c.req.param('id')!, body.environmentIds ?? null) });
  });

  router.openapi(isolateAppRoute, async (c) => {
    const body = AppIsolationBodySchema.parse(await c.req.json());
    const data = await service().isolate(
      appActor(c),
      c.req.param('id')!,
      body.environmentIds ?? null,
      body.confirmName
    );
    return c.json({ data });
  });

  router.openapi(releaseAppIsolationRoute, async (c) => {
    const body = AppIncidentScopeSchema.parse(await c.req.json().catch(() => ({})));
    return c.json({ data: await service().release(appActor(c), c.req.param('id')!, body.environmentIds ?? null) });
  });
}
