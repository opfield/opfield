import type { OpenAPIHono } from '@hono/zod-openapi';
import type { MiddlewareHandler } from 'hono';
import { container } from '@/container.js';
import { AppError } from '@/middleware/error-handler.js';
import { appForMember, parseAppListFilter, withDockerAppMembers } from '@/modules/apps/app-membership.js';
import { requireScopeBase } from '@/modules/auth/auth.middleware.js';
import { hasDockerResourceScope } from '@/modules/docker/docker-access-resource.service.js';
import { LicensePolicyService } from '@/modules/license/license-policy.service.js';
import type { AppEnv } from '@/types.js';
import { DockerAvailabilityService } from '../availability/docker-availability.service.js';
import { parseInternalImageReference, withDockerImageSources } from '../docker-image-source.js';
import {
  adoptComposeProjectRoute,
  composeProjectActionRoute,
  createComposeProjectRoute,
  createComposeRevisionRoute,
  createComposeSecretRoute,
  deleteComposeProjectRoute,
  deleteComposeRevisionRoute,
  deleteComposeSecretRoute,
  getComposeProjectRoute,
  getComposeRevisionRoute,
  listComposeOperationsRoute,
  listComposeProjectsRoute,
  listComposeRevisionsRoute,
  listComposeSecretsRoute,
  updateComposeSecretRoute,
  validateComposeProjectRoute,
} from './compose.docs.js';
import {
  ComposeAdoptInputSchema,
  ComposeCreateInputSchema,
  ComposeOperationActionSchema,
  ComposeOperationInputSchema,
  ComposeOperationListQuerySchema,
  ComposeRevisionCreateInputSchema,
  ComposeSecretCreateSchema,
  ComposeSecretUpdateSchema,
  ComposeYamlInputSchema,
} from './compose.schemas.js';
import { DockerComposeService } from './compose.service.js';

function deny(scope: string): never {
  throw new AppError(403, 'FORBIDDEN', `Missing required scope: ${scope}`);
}

function requireComposeProjectScope(baseScope: string): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const nodeId = c.req.param('nodeId');
    const projectId = c.req.param('projectId');
    if (
      !nodeId ||
      !projectId ||
      !hasDockerResourceScope(c.get('effectiveScopes') || [], baseScope, nodeId, projectId)
    ) {
      deny(baseScope);
    }
    await next();
  };
}

const requireComposeAdoptScopes: MiddlewareHandler<AppEnv> = async (c, next) => {
  const nodeId = c.req.param('nodeId');
  const projectId = c.req.param('projectId');
  const scopes = c.get('effectiveScopes') || [];
  if (!nodeId || !projectId || !hasDockerResourceScope(scopes, 'docker:compose:create', nodeId, projectId)) {
    deny('docker:compose:create');
  }
  if (!hasDockerResourceScope(scopes, 'docker:compose:manage', nodeId, projectId)) {
    deny('docker:compose:manage');
  }
  await next();
};

const requireComposeActionScope: MiddlewareHandler<AppEnv> = async (c, next) => {
  const action = ComposeOperationActionSchema.parse(c.req.param('action'));
  const baseScope = action === 'delete_volumes' ? 'docker:compose:delete' : 'docker:compose:manage';
  const nodeId = c.req.param('nodeId');
  const projectId = c.req.param('projectId');
  if (!nodeId || !projectId || !hasDockerResourceScope(c.get('effectiveScopes') || [], baseScope, nodeId, projectId)) {
    deny(baseScope);
  }
  await next();
};

/**
 * Creating, adopting, revising, applying, and changing secrets of managed Compose
 * projects needs the current plan. Deleting them and starting, stopping,
 * restarting, taking down, or cancelling existing projects keeps working after the
 * license grace period.
 */
async function requireManagedComposeFeature(gate: 'current' | 'existing' = 'current') {
  const policy = container.resolve(LicensePolicyService);
  if (gate === 'existing') await policy.requireFeatureForExistingRuntime('compose-applications');
  else await policy.requireFeature('compose-applications');
}

const EXISTING_COMPOSE_ACTIONS = new Set<string>(['start', 'stop', 'restart', 'down', 'cancel', 'delete_volumes']);

export function registerDockerComposeRoutes(router: OpenAPIHono<AppEnv>) {
  router.openapi({ ...listComposeProjectsRoute, middleware: requireScopeBase('docker:compose:view') }, async (c) => {
    const service = container.resolve(DockerComposeService);
    const scopes = c.get('effectiveScopes') || [];
    const data = await withDockerAppMembers(
      'compose',
      (await service.list(c.req.query('nodeId'))).filter((project) =>
        hasDockerResourceScope(scopes, 'docker:compose:view', project.nodeId, project.id)
      ),
      (project) => ({ nodeId: project.nodeId, resourceKey: project.id }),
      parseAppListFilter(c.req.query())
    );
    const logicalStates = await container
      .resolve(DockerAvailabilityService)
      .listComposeSurfaceStates(data.map((project) => project.id));
    return c.json({
      data: data.map((project) => {
        const state = logicalStates[project.id];
        return state
          ? {
              ...project,
              availabilityPolicyStatus: state.status,
              availabilityHealthStatus: state.healthStatus,
              availabilityServing: state.serving,
              availabilityDesired: state.desired,
              serviceCount: state.serviceCount ?? project.serviceCount,
              runningServiceCount: state.runningServiceCount ?? project.runningServiceCount,
            }
          : project;
      }),
    });
  });

  router.openapi(
    { ...getComposeProjectRoute, middleware: requireComposeProjectScope('docker:compose:view') },
    async (c) => {
      const data = await container.resolve(DockerComposeService).get(c.req.param('nodeId')!, c.req.param('projectId')!);
      // A service built from Git runs an internal registry image: `source` names its repository instead.
      const revisionServices = data.activeRevision?.normalizedModel?.services ?? {};
      const imageOf = (service: { name: string; image: string }) =>
        parseInternalImageReference(service.image)
          ? service.image
          : (revisionServices[service.name]?.image ?? service.image);
      const services = await withDockerImageSources(data.services, imageOf);
      return c.json({
        data: { ...data, services, app: await appForMember({ type: 'compose', id: c.req.param('projectId')! }) },
      });
    }
  );

  router.openapi(
    { ...validateComposeProjectRoute, middleware: requireScopeBase('docker:compose:create') },
    async (c) => {
      await requireManagedComposeFeature();
      const data = container.resolve(DockerComposeService).validate(ComposeYamlInputSchema.parse(await c.req.json()));
      return c.json({ data });
    }
  );

  router.openapi({ ...createComposeProjectRoute, middleware: requireScopeBase('docker:compose:create') }, async (c) => {
    await requireManagedComposeFeature();
    const data = await container
      .resolve(DockerComposeService)
      .create(
        c.req.param('nodeId')!,
        ComposeCreateInputSchema.parse(await c.req.json()),
        c.get('user')!.id,
        c.get('effectiveScopes') ?? []
      );
    return c.json({ data }, 201);
  });

  router.openapi({ ...adoptComposeProjectRoute, middleware: requireComposeAdoptScopes }, async (c) => {
    await requireManagedComposeFeature();
    const data = await container
      .resolve(DockerComposeService)
      .adopt(
        c.req.param('nodeId')!,
        c.req.param('projectId')!,
        ComposeAdoptInputSchema.parse(await c.req.json()),
        c.get('user')!.id
      );
    return c.json({ data }, 201);
  });

  router.openapi(
    { ...deleteComposeProjectRoute, middleware: requireComposeProjectScope('docker:compose:delete') },
    async (c) => {
      await requireManagedComposeFeature('existing');
      await container
        .resolve(DockerComposeService)
        .deleteProject(c.req.param('nodeId')!, c.req.param('projectId')!, c.get('user')!.id);
      return c.json({ success: true });
    }
  );

  router.openapi(
    { ...listComposeRevisionsRoute, middleware: requireComposeProjectScope('docker:compose:view') },
    async (c) => {
      const service = container.resolve(DockerComposeService);
      await service.get(c.req.param('nodeId')!, c.req.param('projectId')!);
      return c.json({ data: await service.listRevisions(c.req.param('projectId')!) });
    }
  );

  router.openapi(
    { ...getComposeRevisionRoute, middleware: requireComposeProjectScope('docker:compose:view') },
    async (c) => {
      const service = container.resolve(DockerComposeService);
      await service.get(c.req.param('nodeId')!, c.req.param('projectId')!);
      return c.json({ data: await service.getRevisionForApi(c.req.param('projectId')!, c.req.param('revisionId')!) });
    }
  );

  router.openapi(
    { ...createComposeRevisionRoute, middleware: requireComposeProjectScope('docker:compose:manage') },
    async (c) => {
      await requireManagedComposeFeature();
      const data = await container
        .resolve(DockerComposeService)
        .createRevision(
          c.req.param('nodeId')!,
          c.req.param('projectId')!,
          ComposeRevisionCreateInputSchema.parse(await c.req.json()),
          c.get('user')!.id
        );
      return c.json({ data }, 201);
    }
  );

  router.openapi(
    { ...deleteComposeRevisionRoute, middleware: requireComposeProjectScope('docker:compose:manage') },
    async (c) => {
      await requireManagedComposeFeature('existing');
      await container
        .resolve(DockerComposeService)
        .deleteRevision(
          c.req.param('nodeId')!,
          c.req.param('projectId')!,
          c.req.param('revisionId')!,
          c.get('user')!.id
        );
      return c.json({ success: true });
    }
  );

  router.openapi(
    { ...listComposeOperationsRoute, middleware: requireComposeProjectScope('docker:compose:view') },
    async (c) => {
      const service = container.resolve(DockerComposeService);
      return c.json(
        await service.listOperations(
          c.req.param('nodeId')!,
          c.req.param('projectId')!,
          ComposeOperationListQuerySchema.parse(c.req.query())
        )
      );
    }
  );

  router.openapi({ ...composeProjectActionRoute, middleware: requireComposeActionScope }, async (c) => {
    const action = ComposeOperationActionSchema.parse(c.req.param('action'));
    await requireManagedComposeFeature(EXISTING_COMPOSE_ACTIONS.has(action) ? 'existing' : 'current');
    const data = await container
      .resolve(DockerComposeService)
      .startOperation(
        c.req.param('nodeId')!,
        c.req.param('projectId')!,
        action,
        ComposeOperationInputSchema.parse(await c.req.json()),
        c.get('user')!.id
      );
    return c.json({ data }, 201);
  });

  router.openapi(
    { ...listComposeSecretsRoute, middleware: requireComposeProjectScope('docker:compose:view') },
    async (c) =>
      c.json({
        data: await container
          .resolve(DockerComposeService)
          .listSecrets(c.req.param('nodeId')!, c.req.param('projectId')!, false),
      })
  );

  router.openapi(
    { ...createComposeSecretRoute, middleware: requireComposeProjectScope('docker:compose:manage') },
    async (c) => {
      await requireManagedComposeFeature();
      const input = ComposeSecretCreateSchema.parse(await c.req.json());
      const data = await container
        .resolve(DockerComposeService)
        .createSecret(c.req.param('nodeId')!, c.req.param('projectId')!, input.key, input.value, c.get('user')!.id);
      return c.json({ data }, 201);
    }
  );

  router.openapi(
    { ...updateComposeSecretRoute, middleware: requireComposeProjectScope('docker:compose:manage') },
    async (c) => {
      await requireManagedComposeFeature();
      const input = ComposeSecretUpdateSchema.parse(await c.req.json());
      const data = await container
        .resolve(DockerComposeService)
        .updateSecret(
          c.req.param('nodeId')!,
          c.req.param('projectId')!,
          c.req.param('secretId')!,
          input.value,
          c.get('user')!.id
        );
      return c.json({ data });
    }
  );

  router.openapi(
    { ...deleteComposeSecretRoute, middleware: requireComposeProjectScope('docker:compose:manage') },
    async (c) => {
      await requireManagedComposeFeature('existing');
      await container
        .resolve(DockerComposeService)
        .deleteSecret(c.req.param('nodeId')!, c.req.param('projectId')!, c.req.param('secretId')!, c.get('user')!.id);
      return c.json({ success: true });
    }
  );
}
