import type { OpenAPIHono } from '@hono/zod-openapi';
import { container, TOKENS } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import { appForMember, parseAppListFilter, withDockerAppMembers } from '@/modules/apps/app-membership.js';
import { assertNotImpersonating, requireAnyScopeBase, requireScopeBase } from '@/modules/auth/auth.middleware.js';
import { NodeRegistryService } from '@/services/node-registry.service.js';
import type { AppEnv } from '@/types.js';
import {
  createDeploymentRoute,
  createDeploymentSecretRoute,
  deleteDeploymentRoute,
  deleteDeploymentSecretRoute,
  deleteDeploymentWebhookRoute,
  deployDeploymentRoute,
  deploymentActionRoute,
  deploymentWebhookRoute,
  getDeploymentByNameRoute,
  getDeploymentImageCleanupRoute,
  getDeploymentRoute,
  listDeploymentSecretsRoute,
  listDeploymentsRoute,
  regenerateDeploymentWebhookRoute,
  rollbackDeploymentRoute,
  stopDeploymentSlotRoute,
  switchDeploymentRoute,
  updateDeploymentRoute,
  updateDeploymentSecretRoute,
  upsertDeploymentImageCleanupRoute,
  upsertDeploymentWebhookRoute,
} from './docker.docs.js';
import { SecretCreateSchema, SecretUpdateSchema } from './docker.schemas.js';
import { DockerManagementService } from './docker.service.js';
import {
  assertDockerNodeScope,
  assertDockerResourceScope,
  dockerNodeListAccess,
  filterDockerResourcesForScope,
  requireDockerDeploymentScope,
} from './docker-access.middleware.js';
import { hasDockerResourceScope } from './docker-access-resource.service.js';
import {
  deploymentDeployRequiredScopes,
  deploymentUpdateRequiredScopes,
} from './docker-container-scope-requirements.js';
import {
  DockerDeploymentCreateSchema,
  DockerDeploymentDeploySchema,
  DockerDeploymentSwitchSchema,
  DockerDeploymentUpdateSchema,
} from './docker-deployment.schemas.js';
import { DockerDeploymentService } from './docker-deployment.service.js';
import { presentDeploymentForCaller } from './docker-deployment-redaction.js';
import { ImageCleanupUpsertSchema } from './docker-image-cleanup.schemas.js';
import { DockerImageCleanupService } from './docker-image-cleanup.service.js';
import { resolveDockerDeploymentIdByName } from './docker-route-resolvers.js';
import { DockerSecretService } from './docker-secret.service.js';
import { WebhookUpsertSchema } from './docker-webhook.schemas.js';

/** The build rollout owning a deployment; the UI shows it as busy and disables mutations. */
async function deploymentBuildRollout(deploymentId: string) {
  try {
    const rollout = await container
      .resolve(DockerManagementService)
      .findBuildRollout({ kind: 'deployment', deploymentId });
    return rollout ? { buildId: rollout.buildId, commitSha: rollout.commitSha } : null;
  } catch {
    return null;
  }
}

/** The container recreate rule for deployments: see deploymentDeployRequiredScopes / deploymentUpdateRequiredScopes. */
function assertDeploymentChangeAccess(scopes: string[], nodeId: string, deploymentId: string, required: string[]) {
  for (const scope of required) assertDockerResourceScope(scopes, scope, nodeId, deploymentId);
}

function deploymentSecretContainerName(deploymentId: string) {
  return `deployment:${deploymentId}`;
}

const DOCKER_RESOURCE_LIST_MAX = 1000;
const DOCKER_DEPLOYMENT_ROUTE_PREVIEW_MAX = 20;
const DOCKER_DEPLOYMENT_HEALTH_PATH_MAX = 500;

function compactHealthConfig(healthConfig: Record<string, any> | null | undefined) {
  if (!healthConfig) return healthConfig;
  const path = typeof healthConfig.path === 'string' ? healthConfig.path : undefined;
  return {
    ...healthConfig,
    path: path ? path.slice(0, DOCKER_DEPLOYMENT_HEALTH_PATH_MAX) : path,
    pathTruncated: Boolean(path && path.length > DOCKER_DEPLOYMENT_HEALTH_PATH_MAX),
  };
}

function compactDeploymentListItem(deployment: Record<string, any>) {
  const routes = Array.isArray(deployment.routes) ? deployment.routes : [];
  return {
    id: deployment.id,
    scopeResourceId: deployment.id,
    nodeId: deployment.nodeId,
    name: deployment.name,
    status: deployment.status,
    activeSlot: deployment.activeSlot,
    desiredConfig: {
      image: deployment.desiredConfig?.image,
      restartPolicy: deployment.desiredConfig?.restartPolicy,
    },
    routerName: deployment.routerName,
    routerImage: deployment.routerImage,
    networkName: deployment.networkName,
    healthConfig: compactHealthConfig(deployment.healthConfig),
    drainSeconds: deployment.drainSeconds,
    routes: routes.slice(0, DOCKER_DEPLOYMENT_ROUTE_PREVIEW_MAX),
    routesCount: routes.length,
    routesTruncated: routes.length > DOCKER_DEPLOYMENT_ROUTE_PREVIEW_MAX,
    slots: Array.isArray(deployment.slots)
      ? deployment.slots.map((slot: Record<string, any>) => ({
          id: slot.id,
          deploymentId: slot.deploymentId,
          slot: slot.slot,
          containerId: slot.containerId,
          containerName: slot.containerName,
          image: slot.image,
          status: slot.status,
          health: slot.health,
          drainingUntil: slot.drainingUntil,
          updatedAt: slot.updatedAt,
        }))
      : [],
    releases: [],
    healthCheck: deployment.healthCheck ?? null,
    createdAt: deployment.createdAt,
    updatedAt: deployment.updatedAt,
    _transition: deployment._transition,
  };
}

function matchesDeploymentSearch(deployment: Record<string, any>, search: string | undefined) {
  if (!search) return true;
  const routes = Array.isArray(deployment.routes) ? deployment.routes : [];
  const routeText = routes
    .map((route: any) => [route.host, route.path, route.hostPort, route.containerPort].filter(Boolean).join(' '))
    .join(' ');
  const haystack = [
    deployment.id,
    deployment.nodeId,
    deployment.name,
    deployment.status,
    deployment.activeSlot,
    deployment.desiredConfig?.image,
    deployment.routerName,
    deployment.networkName,
    routeText,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return haystack.includes(search);
}

export function registerDockerDeploymentRoutes(router: OpenAPIHono<AppEnv>) {
  router.openapi(
    { ...listDeploymentsRoute, middleware: requireAnyScopeBase('docker:containers:view', 'docker:containers:create') },
    async (c) => {
      const service = container.resolve(DockerDeploymentService);
      const nodeId = c.req.param('nodeId')!;
      if (
        dockerNodeListAccess(
          c.get('effectiveScopes') || [],
          'docker:containers:view',
          nodeId,
          'docker:containers:create'
        ) === 'empty'
      ) {
        return c.json({ data: [], total: 0, limit: DOCKER_RESOURCE_LIST_MAX, truncated: false });
      }
      const availability = container.resolve(NodeRegistryService).getNode(nodeId) ? 'available' : 'unavailable';
      const data = await service.listSummary(nodeId);
      const search = c.req.query('search')?.trim().toLowerCase();
      const compacted = filterDockerResourcesForScope(
        data
          .filter((deployment) => matchesDeploymentSearch(deployment, search))
          .map((deployment) => ({ ...compactDeploymentListItem(deployment), availability })),
        c.get('effectiveScopes') || [],
        'docker:containers:view',
        nodeId
      );
      const listed = await withDockerAppMembers(
        'container',
        compacted,
        (deployment) => ({ nodeId, resourceKey: String(deployment.name) }),
        parseAppListFilter(c.req.query())
      );
      const truncated = listed.length > DOCKER_RESOURCE_LIST_MAX;
      return c.json({
        data: truncated ? listed.slice(0, DOCKER_RESOURCE_LIST_MAX) : listed,
        total: listed.length,
        limit: DOCKER_RESOURCE_LIST_MAX,
        truncated,
      });
    }
  );

  router.openapi({ ...createDeploymentRoute, middleware: requireScopeBase('docker:containers:create') }, async (c) => {
    const service = container.resolve(DockerDeploymentService);
    const user = c.get('user')!;
    const nodeId = c.req.param('nodeId')!;
    const scopes = c.get('effectiveScopes') || [];
    const data = await service.create(nodeId, DockerDeploymentCreateSchema.parse(await c.req.json()), user.id, scopes);
    return c.json({ data: presentDeploymentForCaller(data, scopes, nodeId, data.id) }, 201);
  });

  router.openapi({ ...getDeploymentByNameRoute, middleware: requireScopeBase('docker:containers:view') }, async (c) => {
    const service = container.resolve(DockerDeploymentService);
    const db = container.resolve(TOKENS.DrizzleClient) as DrizzleClient;
    assertDockerNodeScope(c.get('effectiveScopes') || [], 'docker:containers:view', c.req.param('nodeId')!);
    const deploymentId = await resolveDockerDeploymentIdByName(
      db,
      c.req.param('nodeId')!,
      c.req.param('deploymentName')!
    );
    assertDockerResourceScope(
      c.get('effectiveScopes') || [],
      'docker:containers:view',
      c.req.param('nodeId')!,
      deploymentId
    );
    const data = await service.get(c.req.param('nodeId')!, deploymentId);
    const availability = container.resolve(NodeRegistryService).getNode(c.req.param('nodeId')!)
      ? 'available'
      : 'unavailable';
    const presented = presentDeploymentForCaller(
      data,
      c.get('effectiveScopes') || [],
      c.req.param('nodeId')!,
      deploymentId
    );
    return c.json({
      data: {
        ...presented,
        availability,
        app: await appForMember({ type: 'deployment', id: deploymentId }),
        _buildRollout: await deploymentBuildRollout(deploymentId),
      },
    });
  });

  router.openapi(
    { ...getDeploymentRoute, middleware: requireDockerDeploymentScope('docker:containers:view') },
    async (c) => {
      const service = container.resolve(DockerDeploymentService);
      const nodeId = c.req.param('nodeId')!;
      const deploymentId = c.req.param('deploymentId')!;
      const data = await service.get(nodeId, deploymentId);
      const availability = container.resolve(NodeRegistryService).getNode(nodeId) ? 'available' : 'unavailable';
      const presented = presentDeploymentForCaller(data, c.get('effectiveScopes') || [], nodeId, deploymentId);
      return c.json({
        data: {
          ...presented,
          availability,
          app: await appForMember({ type: 'deployment', id: deploymentId }),
          _buildRollout: await deploymentBuildRollout(deploymentId),
        },
      });
    }
  );

  router.openapi(
    // An env-only save needs environment, anything else edit: see deploymentUpdateRequiredScopes.
    { ...updateDeploymentRoute, middleware: requireDockerDeploymentScope('docker:containers:view') },
    async (c) => {
      const service = container.resolve(DockerDeploymentService);
      const user = c.get('user')!;
      const nodeId = c.req.param('nodeId')!;
      const deploymentId = c.req.param('deploymentId')!;
      const scopes = c.get('effectiveScopes') || [];
      const input = DockerDeploymentUpdateSchema.parse(await c.req.json());
      const saved = await service.get(nodeId, deploymentId);
      assertDeploymentChangeAccess(scopes, nodeId, deploymentId, deploymentUpdateRequiredScopes(input, saved));
      const data = await service.update(nodeId, deploymentId, input, user.id, scopes);
      return c.json({ data: presentDeploymentForCaller(data, scopes, nodeId, deploymentId) });
    }
  );

  router.openapi(
    { ...deleteDeploymentRoute, middleware: requireDockerDeploymentScope('docker:containers:delete') },
    async (c) => {
      const service = container.resolve(DockerDeploymentService);
      const user = c.get('user')!;
      await service.remove(c.req.param('nodeId')!, c.req.param('deploymentId')!, user.id);
      return c.json({ success: true });
    }
  );

  router.openapi(
    { ...deploymentActionRoute('start'), middleware: requireDockerDeploymentScope('docker:containers:manage') },
    async (c) => {
      const service = container.resolve(DockerDeploymentService);
      const user = c.get('user')!;
      const nodeId = c.req.param('nodeId')!;
      const deploymentId = c.req.param('deploymentId')!;
      const data = await service.start(nodeId, deploymentId, user.id);
      return c.json({ data: presentDeploymentForCaller(data, c.get('effectiveScopes') || [], nodeId, deploymentId) });
    }
  );

  router.openapi(
    { ...deploymentActionRoute('stop'), middleware: requireDockerDeploymentScope('docker:containers:manage') },
    async (c) => {
      const service = container.resolve(DockerDeploymentService);
      const user = c.get('user')!;
      const nodeId = c.req.param('nodeId')!;
      const deploymentId = c.req.param('deploymentId')!;
      const data = await service.stop(nodeId, deploymentId, user.id);
      return c.json({ data: presentDeploymentForCaller(data, c.get('effectiveScopes') || [], nodeId, deploymentId) });
    }
  );

  router.openapi(
    { ...deploymentActionRoute('restart'), middleware: requireDockerDeploymentScope('docker:containers:manage') },
    async (c) => {
      const service = container.resolve(DockerDeploymentService);
      const user = c.get('user')!;
      const nodeId = c.req.param('nodeId')!;
      const deploymentId = c.req.param('deploymentId')!;
      const data = await service.restart(nodeId, deploymentId, user.id);
      return c.json({ data: presentDeploymentForCaller(data, c.get('effectiveScopes') || [], nodeId, deploymentId) });
    }
  );

  router.openapi(
    { ...deploymentActionRoute('kill'), middleware: requireDockerDeploymentScope('docker:containers:manage') },
    async (c) => {
      const service = container.resolve(DockerDeploymentService);
      const user = c.get('user')!;
      const nodeId = c.req.param('nodeId')!;
      const deploymentId = c.req.param('deploymentId')!;
      const data = await service.kill(nodeId, deploymentId, user.id);
      return c.json({ data: presentDeploymentForCaller(data, c.get('effectiveScopes') || [], nodeId, deploymentId) });
    }
  );

  router.openapi(
    { ...deployDeploymentRoute, middleware: requireDockerDeploymentScope('docker:containers:manage') },
    async (c) => {
      const service = container.resolve(DockerDeploymentService);
      const user = c.get('user')!;
      const nodeId = c.req.param('nodeId')!;
      const deploymentId = c.req.param('deploymentId')!;
      const scopes = c.get('effectiveScopes') || [];
      const input = DockerDeploymentDeploySchema.parse(await c.req.json().catch(() => ({})));
      assertDeploymentChangeAccess(scopes, nodeId, deploymentId, deploymentDeployRequiredScopes(input));
      const data = await service.deploy(nodeId, deploymentId, input, user.id, 'manual', scopes);
      return c.json({ data: presentDeploymentForCaller(data, scopes, nodeId, deploymentId) });
    }
  );

  router.openapi(
    { ...switchDeploymentRoute, middleware: requireDockerDeploymentScope('docker:containers:manage') },
    async (c) => {
      const service = container.resolve(DockerDeploymentService);
      const user = c.get('user')!;
      const nodeId = c.req.param('nodeId')!;
      const deploymentId = c.req.param('deploymentId')!;
      const scopes = c.get('effectiveScopes') || [];
      const data = await service.switchToSlot(
        nodeId,
        deploymentId,
        DockerDeploymentSwitchSchema.parse(await c.req.json()),
        user.id,
        undefined,
        scopes
      );
      return c.json({ data: presentDeploymentForCaller(data, scopes, nodeId, deploymentId) });
    }
  );

  router.openapi(
    { ...rollbackDeploymentRoute, middleware: requireDockerDeploymentScope('docker:containers:manage') },
    async (c) => {
      const service = container.resolve(DockerDeploymentService);
      const user = c.get('user')!;
      const body = await c.req.json().catch(() => ({}));
      const nodeId = c.req.param('nodeId')!;
      const deploymentId = c.req.param('deploymentId')!;
      const scopes = c.get('effectiveScopes') || [];
      const data = await service.rollback(nodeId, deploymentId, body.force === true, user.id, scopes);
      return c.json({ data: presentDeploymentForCaller(data, scopes, nodeId, deploymentId) });
    }
  );

  router.openapi(
    { ...stopDeploymentSlotRoute, middleware: requireDockerDeploymentScope('docker:containers:manage') },
    async (c) => {
      const service = container.resolve(DockerDeploymentService);
      const user = c.get('user')!;
      const slot = DockerDeploymentSwitchSchema.shape.slot.parse(c.req.param('slot')!);
      await service.stopSlot(c.req.param('nodeId')!, c.req.param('deploymentId')!, slot, user.id);
      return c.json({ success: true });
    }
  );

  router.openapi(
    // The keys with docker:containers:environment, the values only with docker:containers:secrets.
    { ...listDeploymentSecretsRoute, middleware: requireDockerDeploymentScope('docker:containers:environment') },
    async (c) => {
      const deploymentService = container.resolve(DockerDeploymentService);
      const secretService = container.resolve(DockerSecretService);
      const nodeId = c.req.param('nodeId')!;
      const deploymentId = c.req.param('deploymentId')!;
      await deploymentService.get(nodeId, deploymentId);
      const scopes = c.get('effectiveScopes') || [];
      // An impersonating administrator sees the keys, never the values.
      const canReveal =
        hasDockerResourceScope(scopes, 'docker:containers:secrets', nodeId, deploymentId) && !c.get('impersonation');
      const data = await secretService.list(nodeId, deploymentSecretContainerName(deploymentId), canReveal);
      return c.json({ data });
    }
  );

  router.openapi(
    { ...createDeploymentSecretRoute, middleware: requireDockerDeploymentScope('docker:containers:secrets') },
    async (c) => {
      const deploymentService = container.resolve(DockerDeploymentService);
      const secretService = container.resolve(DockerSecretService);
      const nodeId = c.req.param('nodeId')!;
      const deploymentId = c.req.param('deploymentId')!;
      await deploymentService.get(nodeId, deploymentId);
      const user = c.get('user')!;
      const { key, value } = SecretCreateSchema.parse(await c.req.json());
      const data = await secretService.create(nodeId, deploymentSecretContainerName(deploymentId), key, value, user.id);
      return c.json({ data }, 201);
    }
  );

  router.openapi(
    { ...updateDeploymentSecretRoute, middleware: requireDockerDeploymentScope('docker:containers:secrets') },
    async (c) => {
      const deploymentService = container.resolve(DockerDeploymentService);
      const secretService = container.resolve(DockerSecretService);
      const nodeId = c.req.param('nodeId')!;
      const deploymentId = c.req.param('deploymentId')!;
      await deploymentService.get(nodeId, deploymentId);
      const user = c.get('user')!;
      const { value } = SecretUpdateSchema.parse(await c.req.json());
      const data = await secretService.update(
        c.req.param('secretId')!,
        nodeId,
        value,
        user.id,
        deploymentSecretContainerName(deploymentId)
      );
      return c.json({ data });
    }
  );

  router.openapi(
    { ...deleteDeploymentSecretRoute, middleware: requireDockerDeploymentScope('docker:containers:secrets') },
    async (c) => {
      const deploymentService = container.resolve(DockerDeploymentService);
      const secretService = container.resolve(DockerSecretService);
      const nodeId = c.req.param('nodeId')!;
      const deploymentId = c.req.param('deploymentId')!;
      await deploymentService.get(nodeId, deploymentId);
      const user = c.get('user')!;
      await secretService.delete(
        c.req.param('secretId')!,
        nodeId,
        user.id,
        deploymentSecretContainerName(deploymentId)
      );
      return c.json({ success: true });
    }
  );

  router.openapi(
    { ...deploymentWebhookRoute, middleware: requireDockerDeploymentScope('docker:containers:webhooks') },
    async (c) => {
      const service = container.resolve(DockerDeploymentService);
      const data = await service.getWebhook(c.req.param('nodeId')!, c.req.param('deploymentId')!);
      // An impersonating admin sees the config, never the user's webhook token.
      return c.json({ data: data && c.get('impersonation') ? { ...data, token: null } : data });
    }
  );

  router.openapi(
    { ...upsertDeploymentWebhookRoute, middleware: requireDockerDeploymentScope('docker:containers:webhooks') },
    async (c) => {
      // The webhook token is a long-lived credential; never mint it for an impersonated user.
      assertNotImpersonating(c, 'Webhook tokens cannot be issued while impersonating');
      const service = container.resolve(DockerDeploymentService);
      const user = c.get('user')!;
      const data = await service.upsertWebhook(
        c.req.param('nodeId')!,
        c.req.param('deploymentId')!,
        WebhookUpsertSchema.parse(await c.req.json()),
        user.id
      );
      return c.json({ data });
    }
  );

  router.openapi(
    { ...deleteDeploymentWebhookRoute, middleware: requireDockerDeploymentScope('docker:containers:webhooks') },
    async (c) => {
      const service = container.resolve(DockerDeploymentService);
      const user = c.get('user')!;
      await service.deleteWebhook(c.req.param('nodeId')!, c.req.param('deploymentId')!, user.id);
      return c.json({ success: true });
    }
  );

  router.openapi(
    {
      ...regenerateDeploymentWebhookRoute,
      middleware: requireDockerDeploymentScope('docker:containers:webhooks'),
    },
    async (c) => {
      assertNotImpersonating(c, 'Webhook tokens cannot be regenerated while impersonating');
      const service = container.resolve(DockerDeploymentService);
      const user = c.get('user')!;
      const data = await service.regenerateWebhook(c.req.param('nodeId')!, c.req.param('deploymentId')!, user.id);
      return c.json({ data });
    }
  );

  router.openapi(
    {
      ...getDeploymentImageCleanupRoute,
      middleware: requireDockerDeploymentScope('docker:containers:view'),
    },
    async (c) => {
      const nodeId = c.req.param('nodeId')!;
      const deploymentId = c.req.param('deploymentId')!;
      await container.resolve(DockerDeploymentService).get(nodeId, deploymentId);
      const data = await container.resolve(DockerImageCleanupService).getForDeployment(nodeId, deploymentId);
      return c.json({ data });
    }
  );

  router.openapi(
    {
      ...upsertDeploymentImageCleanupRoute,
      middleware: requireDockerDeploymentScope('docker:containers:edit'),
    },
    async (c) => {
      const nodeId = c.req.param('nodeId')!;
      const deploymentId = c.req.param('deploymentId')!;
      await container.resolve(DockerDeploymentService).get(nodeId, deploymentId);
      const data = await container
        .resolve(DockerImageCleanupService)
        .upsertForDeployment(nodeId, deploymentId, ImageCleanupUpsertSchema.parse(await c.req.json()));
      return c.json({ data });
    }
  );
}
