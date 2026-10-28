import { OpenAPIHono } from '@hono/zod-openapi';
import { container } from '@/container.js';
import { openApiValidationHook } from '@/lib/openapi.js';
import { AppError } from '@/middleware/error-handler.js';
import { assertNotImpersonating } from '@/modules/auth/auth.middleware.js';
import { demoRestriction, isDemoMode } from '@/modules/demo/demo-mode.js';
import type { AppEnv } from '@/types.js';
import {
  deleteContainerWebhookRoute,
  getContainerImageCleanupRoute,
  getContainerWebhookRoute,
  regenerateContainerWebhookRoute,
  triggerDockerWebhookRoute,
  upsertContainerImageCleanupRoute,
  upsertContainerWebhookRoute,
} from './docker.docs.js';
import { requireDockerContainerScope } from './docker-access.middleware.js';
import { ImageCleanupUpsertSchema } from './docker-image-cleanup.schemas.js';
import { DockerImageCleanupService } from './docker-image-cleanup.service.js';
import { WebhookTriggerSchema, WebhookUpsertSchema } from './docker-webhook.schemas.js';
import { DockerWebhookService } from './docker-webhook.service.js';

// ─── Config routes (mounted inside dockerRoutes, session-only) ──────

export function registerWebhookConfigRoutes(router: OpenAPIHono<AppEnv>) {
  // Get webhook config for a container
  router.openapi(
    {
      ...getContainerWebhookRoute,
      middleware: requireDockerContainerScope('docker:containers:webhooks', 'containerName'),
    },
    async (c) => {
      const service = container.resolve(DockerWebhookService);
      const nodeId = c.req.param('nodeId')!;
      const containerName = c.req.param('containerName')!;
      const data = await service.getByContainer(nodeId, containerName);
      // An impersonating admin sees the config, never the user's webhook token.
      return c.json({ data: data && c.get('impersonation') ? { ...data, token: null } : data });
    }
  );

  // Create or update webhook config
  router.openapi(
    {
      ...upsertContainerWebhookRoute,
      middleware: requireDockerContainerScope('docker:containers:webhooks', 'containerName'),
    },
    async (c) => {
      // The webhook token is a long-lived credential; never mint it for an impersonated user.
      assertNotImpersonating(c, 'Webhook tokens cannot be issued while impersonating');
      const service = container.resolve(DockerWebhookService);
      const nodeId = c.req.param('nodeId')!;
      const containerName = c.req.param('containerName')!;
      const body = WebhookUpsertSchema.parse(await c.req.json());
      const user = c.get('user')!;
      const data = await service.upsert(nodeId, containerName, body, user.id);
      return c.json({ data });
    }
  );

  // Delete webhook config
  router.openapi(
    {
      ...deleteContainerWebhookRoute,
      middleware: requireDockerContainerScope('docker:containers:webhooks', 'containerName'),
    },
    async (c) => {
      const service = container.resolve(DockerWebhookService);
      const nodeId = c.req.param('nodeId')!;
      const containerName = c.req.param('containerName')!;
      const user = c.get('user')!;
      await service.remove(nodeId, containerName, user.id);
      return c.json({ success: true });
    }
  );

  // Regenerate webhook token
  router.openapi(
    {
      ...regenerateContainerWebhookRoute,
      middleware: requireDockerContainerScope('docker:containers:webhooks', 'containerName'),
    },
    async (c) => {
      assertNotImpersonating(c, 'Webhook tokens cannot be regenerated while impersonating');
      const service = container.resolve(DockerWebhookService);
      const nodeId = c.req.param('nodeId')!;
      const containerName = c.req.param('containerName')!;
      const user = c.get('user')!;
      const data = await service.regenerateToken(nodeId, containerName, user.id);
      return c.json({ data });
    }
  );

  router.openapi(
    {
      ...getContainerImageCleanupRoute,
      middleware: requireDockerContainerScope('docker:containers:view', 'containerName'),
    },
    async (c) => {
      const service = container.resolve(DockerImageCleanupService);
      const nodeId = c.req.param('nodeId')!;
      const containerName = c.req.param('containerName')!;
      const data = await service.getForContainer(nodeId, containerName);
      return c.json({ data });
    }
  );

  router.openapi(
    {
      ...upsertContainerImageCleanupRoute,
      middleware: requireDockerContainerScope('docker:containers:edit', 'containerName'),
    },
    async (c) => {
      const service = container.resolve(DockerImageCleanupService);
      const nodeId = c.req.param('nodeId')!;
      const containerName = c.req.param('containerName')!;
      const data = await service.upsertForContainer(
        nodeId,
        containerName,
        ImageCleanupUpsertSchema.parse(await c.req.json())
      );
      return c.json({ data });
    }
  );
}

// ─── Trigger route (public — token IS the auth) ────────────────────

export const dockerWebhookTriggerRoutes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

dockerWebhookTriggerRoutes.use('*', async (_c, next) => {
  if (isDemoMode()) throw demoRestriction('Trigger Docker automation through a webhook');
  await next();
});

dockerWebhookTriggerRoutes.openapi(triggerDockerWebhookRoute, async (c) => {
  const service = container.resolve(DockerWebhookService);
  const token = c.req.param('token')!;

  // Look up webhook by token
  const webhook = await service.getByToken(token);
  if (!webhook?.enabled) {
    throw new AppError(404, 'WEBHOOK_NOT_FOUND', 'Invalid or disabled webhook');
  }

  // Parse optional tag from body
  let tag: string | undefined;
  try {
    const body = await c.req.json();
    const parsed = WebhookTriggerSchema.parse(body);
    tag = parsed.tag;
  } catch {
    // Empty body or invalid JSON — that's fine, will re-pull current tag
  }

  if (webhook.targetType === 'deployment') {
    const result = (await service.triggerWebhookToken(token, tag)) as Record<string, unknown> | null | undefined;
    // The token authorizes a deploy, not a read: never echo the deployment
    // detail (desired config, env, slot snapshots) to the caller.
    const data = result
      ? {
          ...(typeof result.deploymentId === 'string' ? { deploymentId: result.deploymentId } : {}),
          ...(typeof result.message === 'string' ? { message: result.message } : {}),
          ...(typeof result.taskId === 'string' ? { taskId: result.taskId } : {}),
        }
      : result;
    return c.json({ data });
  }

  // Logical HA containers may have no runtime on the original source node.
  const { DockerManagementService } = await import('./docker.service.js');
  const docker = container.resolve(DockerManagementService);
  const managed = await docker.getManagedContainerConfiguration(webhook.nodeId, webhook.containerName);
  if (managed) {
    const data = await service.triggerUpdate({
      nodeId: managed.nodeId,
      containerName: managed.containerName,
      containerId: managed.containerName,
      tag,
      webhookId: webhook.id,
      webhookOwnerId: webhook.updatedById,
    });
    return c.json({ data });
  }

  // Ordinary single-node containers retain physical ID lookup.
  const containers = await docker.listContainers(webhook.nodeId);
  const match = Array.isArray(containers)
    ? containers.find((ct: any) => {
        const name = ((ct.name ?? ct.Name ?? ct.Names?.[0]) as string)?.replace(/^\//, '');
        return name === webhook.containerName;
      })
    : null;

  if (!match) {
    throw new AppError(404, 'CONTAINER_NOT_FOUND', `Container "${webhook.containerName}" not found on node`);
  }

  const containerId: string = match.id ?? match.Id;

  const result = await service.triggerUpdate({
    nodeId: webhook.nodeId,
    containerName: webhook.containerName,
    containerId,
    tag,
    webhookId: webhook.id,
    webhookOwnerId: webhook.updatedById,
  });

  return c.json({ data: result });
});
