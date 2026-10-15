import type { OpenAPIHono } from '@hono/zod-openapi';
import { z } from 'zod';
import { container } from '@/container.js';
import { hasScopeForResource } from '@/lib/permissions.js';
import { AppError } from '@/middleware/error-handler.js';
import { parseAppListFilter } from '@/modules/apps/app-membership.js';
import { requireAnyScopeBase } from '@/modules/auth/auth.middleware.js';
import type { AppEnv } from '@/types.js';
import { DockerAccessResourceService, hasDockerResourceScope } from './docker-access-resource.service.js';
import { DockerBuildListQuerySchema, DockerBuildLogQuerySchema } from './docker-build.schemas.js';
import { DockerBuildService } from './docker-build.service.js';
import { filterBuildsByApp } from './docker-build-app-filter.js';

const BuildIdSchema = z.string().uuid();
const BUILD_PAGE_SCAN_LIMIT = 200;
const BUILD_PAGE_SCAN_PASSES = 20;

interface DockerBuildCursor {
  createdAt: string;
  id: string;
}

function encodeBuildCursor(build: { createdAt: Date | string; id: string }) {
  return Buffer.from(
    JSON.stringify({
      createdAt: build.createdAt instanceof Date ? build.createdAt.toISOString() : build.createdAt,
      id: build.id,
    } satisfies DockerBuildCursor)
  ).toString('base64url');
}

function decodeBuildCursor(value?: string): DockerBuildCursor | null {
  if (!value) return null;
  try {
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<DockerBuildCursor>;
    if (typeof decoded.createdAt !== 'string' || Number.isNaN(Date.parse(decoded.createdAt))) return null;
    if (typeof decoded.id !== 'string' || !BuildIdSchema.safeParse(decoded.id).success) return null;
    return { createdAt: decoded.createdAt, id: decoded.id };
  } catch {
    return null;
  }
}

async function canAccessBuild(
  scopes: readonly string[],
  action: 'view' | 'manage',
  build: {
    target:
      | { kind: 'container'; nodeId: string; containerName: string }
      | { kind: 'deployment'; nodeId: string; deploymentId: string }
      | { kind: 'compose_project'; nodeId: string; composeProjectId: string }
      | { kind: 'pages_project'; nodeId?: string; pageProjectId: string };
  }
) {
  if (build.target.kind === 'pages_project') {
    return hasScopeForResource(
      [...scopes],
      action === 'view' ? 'pages:view' : 'pages:deploy',
      build.target.pageProjectId
    );
  }
  const compose = build.target.kind === 'compose_project';
  const baseScope = compose ? `docker:compose:${action}` : `docker:containers:${action}`;
  if (hasDockerResourceScope([...scopes], baseScope, build.target.nodeId, '')) return true;
  // A pending Git source container exists only as its reservation until its first build creates it.
  const resourceId =
    build.target.kind === 'container'
      ? await container.resolve(DockerAccessResourceService).resolveContainer(build.target.nodeId, {
          name: build.target.containerName,
          includeReservations: true,
        })
      : build.target.kind === 'deployment'
        ? build.target.deploymentId
        : build.target.composeProjectId;
  if (!resourceId) return false;
  return hasDockerResourceScope([...scopes], baseScope, build.target.nodeId, resourceId);
}

export function registerDockerBuildRoutes(router: OpenAPIHono<AppEnv>) {
  router.get(
    '/builds',
    requireAnyScopeBase('docker:containers:view', 'docker:compose:view', 'pages:view'),
    async (c) => {
      const query = DockerBuildListQuerySchema.parse(c.req.query());
      // `excludeAppMembers` (the global Docker page) / `appId`, like the other foldered lists.
      const appFilter = parseAppListFilter(c.req.query());
      const scopes = c.get('effectiveScopes') ?? [];
      const requestedCursor = decodeBuildCursor(query.cursor);
      if (query.cursor && !requestedCursor) {
        throw new AppError(400, 'INVALID_BUILD_CURSOR', 'Build cursor is invalid');
      }
      const service = container.resolve(DockerBuildService);
      const visible: Awaited<ReturnType<DockerBuildService['list']>> = [];
      let cursor = requestedCursor;
      let exhausted = false;
      let lastScanned: { createdAt: Date | string; id: string } | null = null;

      for (let pass = 0; pass < BUILD_PAGE_SCAN_PASSES && visible.length <= query.limit; pass += 1) {
        const rows = await service.list({
          sourceBindingId: query.sourceBindingId,
          builderNodeId: query.builderNodeId,
          status: query.status,
          provider: query.provider,
          branch: query.branch,
          search: query.search,
          beforeCreatedAt: cursor ? new Date(cursor.createdAt) : undefined,
          beforeId: cursor?.id,
          limit: BUILD_PAGE_SCAN_LIMIT,
        });
        if (rows.length === 0) {
          exhausted = true;
          break;
        }
        const kept = new Set(await filterBuildsByApp(rows, appFilter));
        for (const build of rows) {
          lastScanned = build;
          if (kept.has(build) && (await canAccessBuild(scopes, 'view', build))) visible.push(build);
          if (visible.length > query.limit) break;
        }
        if (visible.length > query.limit) break;
        if (rows.length < BUILD_PAGE_SCAN_LIMIT) {
          exhausted = true;
          break;
        }
        const tail = rows.at(-1)!;
        cursor = {
          createdAt: tail.createdAt instanceof Date ? tail.createdAt.toISOString() : tail.createdAt,
          id: tail.id,
        };
      }

      const data = visible.slice(0, query.limit);
      const nextCursor =
        visible.length > query.limit
          ? encodeBuildCursor(data.at(-1)!)
          : !exhausted && lastScanned
            ? encodeBuildCursor(lastScanned)
            : null;
      return c.json({ data, nextCursor });
    }
  );

  router.get(
    '/builds/:buildId',
    requireAnyScopeBase('docker:containers:view', 'docker:compose:view', 'pages:view'),
    async (c) => {
      const build = await container.resolve(DockerBuildService).get(BuildIdSchema.parse(c.req.param('buildId')));
      if (!(await canAccessBuild(c.get('effectiveScopes') ?? [], 'view', build))) {
        throw new AppError(403, 'FORBIDDEN', 'Missing resource permission for this build', {
          requiredScope:
            build.target.kind === 'pages_project'
              ? 'pages:view'
              : build.target.kind === 'compose_project'
                ? 'docker:compose:view'
                : 'docker:containers:view',
        });
      }
      return c.json({ data: build });
    }
  );

  router.get(
    '/builds/:buildId/logs',
    requireAnyScopeBase('docker:containers:view', 'docker:compose:view', 'pages:view'),
    async (c) => {
      const buildId = BuildIdSchema.parse(c.req.param('buildId'));
      const build = await container.resolve(DockerBuildService).get(buildId);
      if (!(await canAccessBuild(c.get('effectiveScopes') ?? [], 'view', build))) {
        throw new AppError(403, 'FORBIDDEN', 'Missing resource permission for this build', {
          requiredScope:
            build.target.kind === 'pages_project'
              ? 'pages:view'
              : build.target.kind === 'compose_project'
                ? 'docker:compose:view'
                : 'docker:containers:view',
        });
      }
      const query = DockerBuildLogQuerySchema.parse(c.req.query());
      const data = await container.resolve(DockerBuildService).listLogs(buildId, query.afterSequence, query.limit);
      return c.json({ data });
    }
  );

  router.post(
    '/builds/:buildId/cancel',
    requireAnyScopeBase('docker:containers:manage', 'docker:compose:manage', 'pages:deploy'),
    async (c) => {
      const service = container.resolve(DockerBuildService);
      const buildId = BuildIdSchema.parse(c.req.param('buildId'));
      const build = await service.get(buildId);
      if (!(await canAccessBuild(c.get('effectiveScopes') ?? [], 'manage', build))) {
        throw new AppError(403, 'FORBIDDEN', 'Missing resource permission for this build', {
          requiredScope:
            build.target.kind === 'pages_project'
              ? 'pages:deploy'
              : build.target.kind === 'compose_project'
                ? 'docker:compose:manage'
                : 'docker:containers:manage',
        });
      }
      const data = await service.requestCancellation(buildId, c.get('user')!.id);
      return c.json({ data });
    }
  );

  router.post(
    '/builds/:buildId/retry',
    requireAnyScopeBase('docker:containers:manage', 'docker:compose:manage', 'pages:deploy'),
    async (c) => {
      const service = container.resolve(DockerBuildService);
      const buildId = BuildIdSchema.parse(c.req.param('buildId'));
      const build = await service.get(buildId);
      if (!(await canAccessBuild(c.get('effectiveScopes') ?? [], 'manage', build))) {
        throw new AppError(403, 'FORBIDDEN', 'Missing resource permission for this build', {
          requiredScope:
            build.target.kind === 'pages_project'
              ? 'pages:deploy'
              : build.target.kind === 'compose_project'
                ? 'docker:compose:manage'
                : 'docker:containers:manage',
        });
      }
      const data = await service.retry(buildId, c.get('user')!.id);
      return c.json({ data }, 201);
    }
  );
}
