import { OpenAPIHono } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { z } from 'zod';
import { container } from '@/container.js';
import { openApiValidationHook } from '@/lib/openapi.js';
import { authMiddleware } from '@/modules/auth/auth.middleware.js';
import type { AppEnv, User } from '@/types.js';
import {
  CreateHostingConnectorSchema,
  DiscoverHostingConnectorSchema,
  HostingActionSchema,
  HostingAdoptSchema,
  HostingProvisionSchema,
  UpdateHostingConnectorSchema,
} from './hosting.schemas.js';
import { HostingConnectorsService } from './hosting-connectors.service.js';
import { HostingFirewallService } from './hosting-firewall.service.js';
import { HostingFirewallUpdateSchema } from './hosting-firewall.types.js';
import { HostingInventoryService } from './hosting-inventory.service.js';
import { HostingManagementService } from './hosting-management.service.js';
import { HostingOperationsService } from './hosting-operations.service.js';
import { HostingProvisioningService } from './hosting-provisioning.service.js';

const id = (value: string) => z.string().uuid().parse(value);
function actor(c: Context<AppEnv>): User {
  const user = c.get('user')!;
  return { ...user, scopes: c.get('effectiveScopes') ?? user.scopes };
}
export const hostingIntegrationRoutes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });
hostingIntegrationRoutes.use('*', authMiddleware);
hostingIntegrationRoutes.get('/', async (c) =>
  c.json(await container.resolve(HostingConnectorsService).list(actor(c)))
);
hostingIntegrationRoutes.post('/test', async (c) =>
  c.json(
    await container
      .resolve(HostingConnectorsService)
      .preview(CreateHostingConnectorSchema.parse(await c.req.json()), actor(c))
  )
);
hostingIntegrationRoutes.post('/discover', async (c) =>
  c.json(
    await container
      .resolve(HostingConnectorsService)
      .discover(DiscoverHostingConnectorSchema.parse(await c.req.json()), actor(c))
  )
);
hostingIntegrationRoutes.post('/', async (c) =>
  c.json(
    await container
      .resolve(HostingConnectorsService)
      .create(CreateHostingConnectorSchema.parse(await c.req.json()), actor(c)),
    201
  )
);
hostingIntegrationRoutes.get('/:id', async (c) => {
  const service = container.resolve(HostingConnectorsService);
  return c.json(service.safe(await service.get(id(c.req.param('id')), actor(c))));
});
hostingIntegrationRoutes.get('/:id/configuration', async (c) =>
  c.json(await container.resolve(HostingConnectorsService).configuration(id(c.req.param('id')), actor(c)))
);
hostingIntegrationRoutes.put('/:id', async (c) =>
  c.json(
    await container
      .resolve(HostingConnectorsService)
      .update(id(c.req.param('id')), UpdateHostingConnectorSchema.parse(await c.req.json()), actor(c))
  )
);
hostingIntegrationRoutes.delete('/:id', async (c) =>
  c.json(await container.resolve(HostingConnectorsService).remove(id(c.req.param('id')), actor(c)))
);
hostingIntegrationRoutes.post('/:id/test', async (c) =>
  c.json(await container.resolve(HostingConnectorsService).test(id(c.req.param('id')), actor(c)))
);
hostingIntegrationRoutes.post('/:id/sync', async (c) =>
  c.json(await container.resolve(HostingInventoryService).sync(id(c.req.param('id')), actor(c)))
);
hostingIntegrationRoutes.get('/:id/catalog', async (c) =>
  c.json(await container.resolve(HostingProvisioningService).catalog(id(c.req.param('id')), actor(c)))
);
hostingIntegrationRoutes.get('/:id/resources', async (c) =>
  c.json(await container.resolve(HostingInventoryService).resources(id(c.req.param('id')), actor(c)))
);
hostingIntegrationRoutes.get('/:id/adoption-candidates', async (c) =>
  c.json(await container.resolve(HostingInventoryService).adoptionCandidates(id(c.req.param('id')), actor(c)))
);
hostingIntegrationRoutes.post('/:id/adopt', async (c) =>
  c.json(
    await container
      .resolve(HostingInventoryService)
      .adoptNode(id(c.req.param('id')), HostingAdoptSchema.parse(await c.req.json()), actor(c))
  )
);
hostingIntegrationRoutes.get('/:id/operations', async (c) =>
  c.json(await container.resolve(HostingOperationsService).list(id(c.req.param('id')), actor(c)))
);
hostingIntegrationRoutes.get('/:id/account-summary', async (c) =>
  c.json(await container.resolve(HostingInventoryService).accountSummary(id(c.req.param('id')), actor(c)))
);
/**
 * 410 for the retired hosting finance and payment APIs. Not an operation of its own: the MCP/REST coverage check
 * (mcp-rest-coverage-check.ts) skips it.
 */
export function retiredHostingFinanceHandler(c: Context) {
  return c.json({ error: 'Hosting finance pages and payment actions have been removed.' }, 410);
}

// Explicit tombstones keep retired APIs out of the application's SPA fallback.
for (const path of ['/:id/finance', '/:id/invoices/:invoiceId', '/:id/topup']) {
  hostingIntegrationRoutes.all(path, retiredHostingFinanceHandler);
}

export const hostingRoutes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });
hostingRoutes.use('*', authMiddleware);
hostingRoutes.get('/nodes/:id/firewall', async (c) =>
  c.json(await container.resolve(HostingFirewallService).get(id(c.req.param('id')), actor(c)))
);
hostingRoutes.put('/nodes/:id/firewall', async (c) =>
  c.json(
    await container
      .resolve(HostingFirewallService)
      .update(id(c.req.param('id')), HostingFirewallUpdateSchema.parse(await c.req.json()), actor(c)),
    202
  )
);
hostingRoutes.get('/node-bindings', async (c) =>
  c.json(await container.resolve(HostingInventoryService).nodeBindings(actor(c)))
);
hostingRoutes.get('/nodes/:id', async (c) =>
  c.json(await container.resolve(HostingInventoryService).nodeProjection(id(c.req.param('id')), actor(c)))
);
hostingRoutes.post('/operations', async (c) =>
  c.json(
    await container
      .resolve(HostingProvisioningService)
      .create(HostingProvisionSchema.parse(await c.req.json()), actor(c)),
    202
  )
);
hostingRoutes.get('/operations/:id', async (c) =>
  c.json(await container.resolve(HostingOperationsService).get(id(c.req.param('id')), actor(c)))
);
hostingRoutes.post('/operations/:id/reconcile', async (c) =>
  c.json(await container.resolve(HostingOperationsService).reconcileNow(id(c.req.param('id')), actor(c)))
);
hostingRoutes.post('/operations/:id/retry-install', async (c) =>
  c.json(
    await container.resolve(HostingProvisioningService).retryInstall(
      id(c.req.param('id')),
      z
        .object({ idempotencyKey: z.string().uuid(), sshConnectorId: z.string().uuid().optional() })
        .strict()
        .parse(await c.req.json()),
      actor(c)
    ),
    202
  )
);
hostingRoutes.post('/resources/:id/actions', async (c) =>
  c.json(
    await container
      .resolve(HostingManagementService)
      .action(id(c.req.param('id')), HostingActionSchema.parse(await c.req.json()), actor(c)),
    202
  )
);
hostingRoutes.get('/resources/:id/snapshots', async (c) =>
  c.json(await container.resolve(HostingManagementService).snapshots.view(id(c.req.param('id')), actor(c)))
);
hostingRoutes.get('/resources/:id/snapshot-folders', async (c) =>
  c.json(await container.resolve(HostingManagementService).snapshots.folders(id(c.req.param('id')), actor(c)))
);
hostingRoutes.post('/resources/:id/snapshot-folders/actions', async (c) => {
  const body = z
    .object({
      operation: z.enum(['create', 'rename', 'delete', 'reorder-folders', 'move-resources', 'reorder-resources']),
      folderId: z.string().uuid().optional(),
      input: z.unknown(),
    })
    .strict()
    .parse(await c.req.json());
  return c.json(
    await container
      .resolve(HostingManagementService)
      .snapshots.folderAction(id(c.req.param('id')), actor(c), body.operation, body.input, body.folderId)
  );
});
hostingRoutes.post('/resources/:id/snapshots/actions', async (c) =>
  c.json(
    await container
      .resolve(HostingManagementService)
      .snapshots.action(id(c.req.param('id')), HostingSnapshotInputSchema.parse(await c.req.json()), actor(c)),
    202
  )
);

import { HostingSnapshotInputSchema } from './hosting-snapshots.service.js';
