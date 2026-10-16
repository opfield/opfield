import type { OpenAPIHono as OpenAPIHonoType } from '@hono/zod-openapi';
import { OpenAPIHono } from '@hono/zod-openapi';
import type { MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { container, TOKENS } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import {
  appRoute,
  jsonContent,
  okJson,
  openApiValidationHook,
  pathParamSchema,
  UnknownDataResponseSchema,
} from '@/lib/openapi.js';
import { AppError } from '@/middleware/error-handler.js';
import { requireScopeBase } from '@/modules/auth/auth.middleware.js';
import { demoRestriction, isDemoMode } from '@/modules/demo/demo-mode.js';
import { IntegrationsService } from '@/modules/integrations/integrations.service.js';
import { LicensePolicyService } from '@/modules/license/license-policy.service.js';
import type { AppEnv, User } from '@/types.js';
import { createDockerSourceResourceRoute, getDockerBuildAdmissionRoute } from './docker.docs.js';
import { requireDockerContainerScope } from './docker-access.middleware.js';
import { hasDockerResourceScope } from './docker-access-resource.service.js';
import {
  DockerBuildCreateSchema,
  DockerBuildSecretNameSchema,
  DockerBuildSecretValueSchema,
  DockerPendingContainerVolumesSchema,
  DockerSourceBindingConfigSchema,
  DockerSourceBindingUpsertSchema,
  DockerSourceResourceCreateSchema,
  type DockerSourceTarget,
} from './docker-build.schemas.js';
import { DockerBuildService } from './docker-build.service.js';
import { updatePendingContainerVolumes } from './docker-pending-container-volumes.js';
import { DockerSourceService } from './docker-source.service.js';
import { containerSourceAttachNotice, inspectContainerBeforeAttach } from './docker-source-attach-notice.js';
import {
  getDockerSourceWithBuildState,
  withDockerSourceBuildState,
  withPendingDockerSourceBuildState,
} from './docker-source-build-state.js';
import {
  canListSourceConnectors,
  canPickDockerSource,
  listSourceConnectors,
  SOURCE_CONNECTOR_PICKER_SCOPES,
  sourceRepositorySearch,
} from './docker-source-connectors.js';
import {
  assertDockerSourceTargetOnNode,
  ComposeSourceProjectCreateSchema,
  createComposeProjectFromSource,
  createDockerSourceResource,
} from './docker-source-resource-creation.js';
import { documentDockerSourceRoutes } from './docker-source-routes.docs.js';
import {
  getContainerSourceRoute,
  syncComposeSourceRoute,
  syncContainerSourceRoute,
  syncDeploymentSourceRoute,
} from './docker-source-sync.docs.js';
import { assertContainerSourceTargetNotOwned } from './docker-source-target-owner.js';

export { assertDockerSourceTargetNode, initialDockerSourceBuildError } from './docker-source-resource-creation.js';

const SourceBindingIdSchema = z.string().uuid();
const SOURCE_WEBHOOK_BODY_MAX_BYTES = 1_048_576;

function actorFor(c: {
  get(name: 'user'): User | undefined;
  get(name: 'effectiveScopes'): string[] | undefined;
}): User {
  const user = c.get('user');
  if (!user) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
  return { ...user, scopes: c.get('effectiveScopes') ?? user.scopes };
}

function containerTarget(c: { req: { param(name: string): string | undefined } }): DockerSourceTarget {
  return {
    kind: 'container',
    nodeId: c.req.param('nodeId')!,
    containerName: decodeURIComponent(c.req.param('containerName')!),
  };
}

function deploymentTarget(c: { req: { param(name: string): string | undefined } }): DockerSourceTarget {
  return { kind: 'deployment', deploymentId: c.req.param('deploymentId')! };
}

function composeTarget(c: { req: { param(name: string): string | undefined } }): DockerSourceTarget {
  return { kind: 'compose_project', composeProjectId: c.req.param('projectId')! };
}

function requireComposeSourceScope(scope: string): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const nodeId = c.req.param('nodeId');
    const projectId = c.req.param('projectId');
    if (!nodeId || !projectId) {
      throw new AppError(403, 'FORBIDDEN', `Missing required scope: ${scope}`);
    }
    await assertDockerSourceTargetOnNode(nodeId, { kind: 'compose_project', composeProjectId: projectId });
    if (!hasDockerResourceScope(c.get('effectiveScopes') || [], scope, nodeId, projectId)) {
      throw new AppError(403, 'FORBIDDEN', `Missing required scope: ${scope}`);
    }
    await next();
  };
}

function requireDeploymentSourceScope(scope: string): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const nodeId = c.req.param('nodeId');
    const deploymentId = c.req.param('deploymentId');
    if (!nodeId || !deploymentId) {
      throw new AppError(403, 'FORBIDDEN', `Missing required scope: ${scope}`);
    }
    await assertDockerSourceTargetOnNode(nodeId, { kind: 'deployment', deploymentId });
    if (!hasDockerResourceScope(c.get('effectiveScopes') || [], scope, nodeId, deploymentId)) {
      throw new AppError(403, 'FORBIDDEN', `Missing required scope: ${scope}`);
    }
    await next();
  };
}

/**
 * Picking a source needs the create or edit scope of the workload it is for. Connecting the source or changing its
 * connector, repository or branch needs integrations:<provider>:use on the repository, so the connectors and
 * repositories offered are those the caller's `use` grants cover.
 */
function requireSourcePicker(allowed: (scopes: string[]) => boolean): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!allowed(c.get('effectiveScopes') ?? [])) {
      throw new AppError(403, 'FORBIDDEN', 'Picking a Git source requires create or edit access to its workload', {
        requiredScopes: [...SOURCE_CONNECTOR_PICKER_SCOPES],
        scopeMatch: 'any',
      });
    }
    await next();
  };
}

export function registerDockerSourceRoutes(router: OpenAPIHonoType<AppEnv>) {
  // The routes below keep their own handlers; their documentation is registered here (docker-source-routes.docs).
  documentDockerSourceRoutes(router);
  // One connector list for every source picker (containers, deployments, Compose Projects and Pages builds).
  router.get('/sources/connectors', requireSourcePicker(canListSourceConnectors), async (c) => {
    const data = await listSourceConnectors(
      container.resolve(TOKENS.DrizzleClient) as DrizzleClient,
      c.get('effectiveScopes') ?? []
    );
    return c.json({ data });
  });

  // `search` finds repositories past the GitHub listing bound; `truncated` asks the caller to refine it.
  // `refreshing`: the last list was returned while it reloads; `awaitRefresh=true` returns the reloaded one.
  router.get('/sources/connectors/:connectorId/repositories', requireSourcePicker(canPickDockerSource), async (c) => {
    const search = sourceRepositorySearch(c.req.query('search'));
    const { repositories, truncated, refreshing } = await container
      .resolve(IntegrationsService)
      .findDockerBuildSourceRepositories(actorFor(c), c.req.param('connectorId'), search, {
        awaitRefresh: c.req.query('awaitRefresh') === 'true',
      });
    return c.json({ data: repositories, ...(truncated ? { truncated } : {}), ...(refreshing ? { refreshing } : {}) });
  });

  router.openapi(
    {
      ...getDockerBuildAdmissionRoute,
      middleware: requireScopeBase('docker:containers:create'),
    },
    async (c) => c.json({ data: await container.resolve(DockerBuildService).admissionStatus() })
  );

  router.openapi(
    {
      ...createDockerSourceResourceRoute,
      middleware: requireScopeBase('docker:containers:create'),
    },
    async (c) => {
      await container.resolve(LicensePolicyService).requireFeature('git-push-to-deploy');
      const nodeId = z.string().uuid().parse(c.req.param('nodeId'));
      const input = DockerSourceResourceCreateSchema.parse(await c.req.json());
      const data = await createDockerSourceResource(nodeId, input, actorFor(c));
      return c.json({ data }, 201);
    }
  );

  router.get(
    '/nodes/:nodeId/containers/:containerName/source/pending',
    requireDockerContainerScope('docker:containers:view', 'containerName', {
      allowPendingSource: true,
      removedContainerSource: 'refuse',
    }),
    async (c) => {
      const pending = await container
        .resolve(DockerSourceService)
        .getPendingContainer(c.req.param('nodeId'), decodeURIComponent(c.req.param('containerName')));
      if (!pending) throw new AppError(404, 'PENDING_SOURCE_NOT_FOUND', 'Pending source container not found');
      return c.json({ data: await withPendingDockerSourceBuildState(pending) });
    }
  );
  // The volume mounts the first build creates the container with (the whole list).
  router.put(
    '/nodes/:nodeId/containers/:containerName/source/pending/volumes',
    requireDockerContainerScope('docker:containers:edit', 'containerName', {
      allowPendingSource: true,
      removedContainerSource: 'refuse',
    }),
    async (c) => {
      const input = DockerPendingContainerVolumesSchema.parse(await c.req.json());
      const data = await updatePendingContainerVolumes(
        c.req.param('nodeId'),
        decodeURIComponent(c.req.param('containerName')),
        input,
        actorFor(c)
      );
      return c.json({ data });
    }
  );

  router.openapi(
    {
      ...getContainerSourceRoute,
      middleware: requireDockerContainerScope('docker:containers:view', 'containerName', {
        allowPendingSource: true,
        removedContainerSource: 'allow',
      }),
    },
    async (c) => c.json({ data: await getDockerSourceWithBuildState(containerTarget(c)) })
  );
  router.put(
    '/nodes/:nodeId/containers/:containerName/source',
    requireDockerContainerScope('docker:containers:edit', 'containerName', {
      allowPendingSource: true,
      removedContainerSource: 'refuse',
    }),
    async (c) => {
      const config = DockerSourceBindingConfigSchema.parse(await c.req.json());
      const target = containerTarget(c);
      await assertContainerSourceTargetNotOwned(
        c.req.param('nodeId')!,
        decodeURIComponent(c.req.param('containerName')!)
      );
      const sources = container.resolve(DockerSourceService);
      // Attaching to an existing container replaces what it runs on the first deploy: the answer says what changes.
      const before =
        target.kind === 'container' && !(await sources.get(target))
          ? await inspectContainerBeforeAttach(target.nodeId, target.containerName)
          : null;
      const saved = await sources.upsert({ ...config, target }, actorFor(c));
      const attachNotice =
        target.kind === 'container' ? containerSourceAttachNotice(target.containerName, saved, before) : null;
      return c.json({ data: { ...(await withDockerSourceBuildState(saved)), attachNotice } });
    }
  );
  router.post(
    '/nodes/:nodeId/containers/:containerName/source/resolve',
    requireDockerContainerScope('docker:containers:edit', 'containerName', {
      allowPendingSource: true,
      removedContainerSource: 'refuse',
    }),
    async (c) =>
      c.json({ data: await container.resolve(DockerSourceService).resolveCurrent(containerTarget(c), actorFor(c)) })
  );
  router.post(
    '/nodes/:nodeId/containers/:containerName/source/builds',
    requireDockerContainerScope('docker:containers:manage', 'containerName', {
      allowPendingSource: true,
      removedContainerSource: 'refuse',
    }),
    async (c) => {
      const input = DockerBuildCreateSchema.parse(await c.req.json().catch(() => ({})));
      const data = await container.resolve(DockerSourceService).createBuild(containerTarget(c), input, actorFor(c));
      return c.json({ data }, data.created ? 201 : 200);
    }
  );
  // Sync now can queue the automatic build and its rollout, so it needs the build scope, not edit.
  router.openapi(
    {
      ...syncContainerSourceRoute,
      middleware: requireDockerContainerScope('docker:containers:manage', 'containerName', {
        allowPendingSource: true,
        removedContainerSource: 'refuse',
      }),
    },
    async (c) => c.json({ data: await container.resolve(DockerSourceService).sync(containerTarget(c), actorFor(c)) })
  );
  router.get(
    '/nodes/:nodeId/containers/:containerName/source/build-secrets',
    requireDockerContainerScope('docker:containers:view', 'containerName', {
      allowPendingSource: true,
      removedContainerSource: 'allow',
    }),
    async (c) => c.json({ data: await container.resolve(DockerSourceService).listBuildSecrets(containerTarget(c)) })
  );
  router.put(
    '/nodes/:nodeId/containers/:containerName/source/build-secrets/:secretName',
    requireDockerContainerScope('docker:containers:edit', 'containerName', {
      allowPendingSource: true,
      removedContainerSource: 'refuse',
    }),
    async (c) => {
      const name = DockerBuildSecretNameSchema.parse(decodeURIComponent(c.req.param('secretName')));
      const { value } = DockerBuildSecretValueSchema.parse(await c.req.json());
      const data = await container
        .resolve(DockerSourceService)
        .upsertBuildSecret(containerTarget(c), name, value, actorFor(c).id);
      return c.json({ data });
    }
  );
  router.delete(
    '/nodes/:nodeId/containers/:containerName/source/build-secrets/:secretName',
    requireDockerContainerScope('docker:containers:edit', 'containerName', {
      allowPendingSource: true,
      removedContainerSource: 'allow',
    }),
    async (c) => {
      const name = DockerBuildSecretNameSchema.parse(decodeURIComponent(c.req.param('secretName')));
      const removed = await container
        .resolve(DockerSourceService)
        .deleteBuildSecret(containerTarget(c), name, actorFor(c).id);
      return c.json({ success: true, removed });
    }
  );
  router.delete(
    '/nodes/:nodeId/containers/:containerName/source',
    requireDockerContainerScope('docker:containers:edit', 'containerName', {
      allowPendingSource: true,
      removedContainerSource: 'allow',
    }),
    async (c) => {
      const removed = await container.resolve(DockerSourceService).remove(containerTarget(c), actorFor(c).id);
      return c.json({ success: true, removed });
    }
  );

  router.get(
    '/nodes/:nodeId/deployments/:deploymentId/source',
    requireDeploymentSourceScope('docker:containers:view'),
    async (c) => c.json({ data: await getDockerSourceWithBuildState(deploymentTarget(c)) })
  );
  router.put(
    '/nodes/:nodeId/deployments/:deploymentId/source',
    requireDeploymentSourceScope('docker:containers:edit'),
    async (c) => {
      const config = DockerSourceBindingConfigSchema.parse(await c.req.json());
      const saved = await container
        .resolve(DockerSourceService)
        .upsert({ ...config, target: deploymentTarget(c) }, actorFor(c));
      return c.json({ data: await withDockerSourceBuildState(saved) });
    }
  );
  router.post(
    '/nodes/:nodeId/deployments/:deploymentId/source/resolve',
    requireDeploymentSourceScope('docker:containers:edit'),
    async (c) =>
      c.json({ data: await container.resolve(DockerSourceService).resolveCurrent(deploymentTarget(c), actorFor(c)) })
  );
  router.post(
    '/nodes/:nodeId/deployments/:deploymentId/source/builds',
    requireDeploymentSourceScope('docker:containers:manage'),
    async (c) => {
      const input = DockerBuildCreateSchema.parse(await c.req.json().catch(() => ({})));
      const data = await container.resolve(DockerSourceService).createBuild(deploymentTarget(c), input, actorFor(c));
      return c.json({ data }, data.created ? 201 : 200);
    }
  );
  router.openapi(
    { ...syncDeploymentSourceRoute, middleware: requireDeploymentSourceScope('docker:containers:manage') },
    async (c) => c.json({ data: await container.resolve(DockerSourceService).sync(deploymentTarget(c), actorFor(c)) })
  );
  router.get(
    '/nodes/:nodeId/deployments/:deploymentId/source/build-secrets',
    requireDeploymentSourceScope('docker:containers:view'),
    async (c) => c.json({ data: await container.resolve(DockerSourceService).listBuildSecrets(deploymentTarget(c)) })
  );
  router.put(
    '/nodes/:nodeId/deployments/:deploymentId/source/build-secrets/:secretName',
    requireDeploymentSourceScope('docker:containers:edit'),
    async (c) => {
      const name = DockerBuildSecretNameSchema.parse(decodeURIComponent(c.req.param('secretName')));
      const { value } = DockerBuildSecretValueSchema.parse(await c.req.json());
      const data = await container
        .resolve(DockerSourceService)
        .upsertBuildSecret(deploymentTarget(c), name, value, actorFor(c).id);
      return c.json({ data });
    }
  );
  router.delete(
    '/nodes/:nodeId/deployments/:deploymentId/source/build-secrets/:secretName',
    requireDeploymentSourceScope('docker:containers:edit'),
    async (c) => {
      const name = DockerBuildSecretNameSchema.parse(decodeURIComponent(c.req.param('secretName')));
      const removed = await container
        .resolve(DockerSourceService)
        .deleteBuildSecret(deploymentTarget(c), name, actorFor(c).id);
      return c.json({ success: true, removed });
    }
  );
  router.delete(
    '/nodes/:nodeId/deployments/:deploymentId/source',
    requireDeploymentSourceScope('docker:containers:edit'),
    async (c) => {
      const removed = await container.resolve(DockerSourceService).remove(deploymentTarget(c), actorFor(c).id);
      return c.json({ success: true, removed });
    }
  );

  router.post('/nodes/:nodeId/compose-projects/from-source', requireScopeBase('docker:compose:create'), async (c) => {
    const nodeId = z.string().uuid().parse(c.req.param('nodeId'));
    const input = ComposeSourceProjectCreateSchema.parse(await c.req.json());
    const actor = actorFor(c);
    await container.resolve(LicensePolicyService).requireFeature('compose-applications');
    const data = await createComposeProjectFromSource(nodeId, input, actor);
    return c.json({ data }, 201);
  });

  router.get(
    '/nodes/:nodeId/compose-projects/:projectId/source',
    requireComposeSourceScope('docker:compose:view'),
    async (c) => c.json({ data: await getDockerSourceWithBuildState(composeTarget(c)) })
  );
  router.put(
    '/nodes/:nodeId/compose-projects/:projectId/source',
    requireComposeSourceScope('docker:compose:manage'),
    async (c) => {
      await container.resolve(LicensePolicyService).requireFeature('compose-applications');
      const input = DockerSourceBindingUpsertSchema.parse({ ...(await c.req.json()), target: composeTarget(c) });
      const saved = await container.resolve(DockerSourceService).upsert(input, actorFor(c));
      return c.json({ data: await withDockerSourceBuildState(saved) });
    }
  );
  router.post(
    '/nodes/:nodeId/compose-projects/:projectId/source/resolve',
    requireComposeSourceScope('docker:compose:manage'),
    async (c) =>
      c.json({ data: await container.resolve(DockerSourceService).resolveCurrent(composeTarget(c), actorFor(c)) })
  );
  router.post(
    '/nodes/:nodeId/compose-projects/:projectId/source/builds',
    requireComposeSourceScope('docker:compose:manage'),
    async (c) => {
      const input = DockerBuildCreateSchema.parse(await c.req.json().catch(() => ({})));
      const data = await container.resolve(DockerSourceService).createBuild(composeTarget(c), input, actorFor(c));
      return c.json({ data }, data.created ? 201 : 200);
    }
  );
  router.openapi(
    { ...syncComposeSourceRoute, middleware: requireComposeSourceScope('docker:compose:manage') },
    async (c) => c.json({ data: await container.resolve(DockerSourceService).sync(composeTarget(c), actorFor(c)) })
  );
  router.get(
    '/nodes/:nodeId/compose-projects/:projectId/source/build-secrets',
    requireComposeSourceScope('docker:compose:view'),
    async (c) => c.json({ data: await container.resolve(DockerSourceService).listBuildSecrets(composeTarget(c)) })
  );
  router.put(
    '/nodes/:nodeId/compose-projects/:projectId/source/build-secrets/:secretName',
    requireComposeSourceScope('docker:compose:manage'),
    async (c) => {
      const name = DockerBuildSecretNameSchema.parse(decodeURIComponent(c.req.param('secretName')));
      const { value } = DockerBuildSecretValueSchema.parse(await c.req.json());
      const data = await container
        .resolve(DockerSourceService)
        .upsertBuildSecret(composeTarget(c), name, value, actorFor(c).id);
      return c.json({ data });
    }
  );
  router.delete(
    '/nodes/:nodeId/compose-projects/:projectId/source/build-secrets/:secretName',
    requireComposeSourceScope('docker:compose:manage'),
    async (c) => {
      const name = DockerBuildSecretNameSchema.parse(decodeURIComponent(c.req.param('secretName')));
      const removed = await container
        .resolve(DockerSourceService)
        .deleteBuildSecret(composeTarget(c), name, actorFor(c).id);
      return c.json({ success: true, removed });
    }
  );
  router.delete(
    '/nodes/:nodeId/compose-projects/:projectId/source',
    requireComposeSourceScope('docker:compose:manage'),
    async (c) => {
      const removed = await container.resolve(DockerSourceService).remove(composeTarget(c), actorFor(c).id);
      return c.json({ success: true, removed });
    }
  );
}

export const dockerSourceWebhookRoutes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

dockerSourceWebhookRoutes.use('*', async (_c, next) => {
  if (isDemoMode()) throw demoRestriction('Trigger source automation through a webhook');
  await next();
});

dockerSourceWebhookRoutes.openAPIRegistry.registerPath(
  appRoute({
    method: 'post',
    path: '/{sourceBindingId}',
    tags: ['Docker Builds'],
    summary: 'Receive a Git provider push for a source',
    description:
      "The push webhook of a Git source (`webhookPath` of the source): signed by the provider with the source's webhook secret, at most 1 MiB. A push to the source branch resolves the head and queues the automatic build. Answers 202 (accepted) or 200 (a delivery already seen). No Opfield credentials: the provider signature authenticates it.",
    request: { params: pathParamSchema('sourceBindingId') },
    responses: {
      ...okJson(UnknownDataResponseSchema),
      202: { description: 'Accepted', content: jsonContent(UnknownDataResponseSchema) },
    },
    security: [],
  })
);

dockerSourceWebhookRoutes.post('/:sourceBindingId', async (c) => {
  const sourceBindingId = SourceBindingIdSchema.parse(c.req.param('sourceBindingId'));
  const rawBody = Buffer.from(await c.req.arrayBuffer());
  if (rawBody.byteLength > SOURCE_WEBHOOK_BODY_MAX_BYTES) {
    throw new AppError(413, 'SOURCE_WEBHOOK_BODY_TOO_LARGE', 'Source webhook body exceeds 1 MiB');
  }
  const data = await container.resolve(DockerSourceService).handleWebhook(sourceBindingId, c.req.raw.headers, rawBody);
  return c.json({ data }, data.duplicate ? 200 : 202);
});
