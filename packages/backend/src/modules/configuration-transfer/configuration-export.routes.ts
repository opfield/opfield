import { Readable } from 'node:stream';
import { OpenAPIHono, z } from '@hono/zod-openapi';
import { Hono } from 'hono';
import { container } from '@/container.js';
import { appRoute, jsonBody, okJson, openApiValidationHook, pathParamSchema } from '@/lib/openapi.js';
import { getClientIpForContext } from '@/lib/request-ip.js';
import { AuditService } from '@/modules/audit/audit.service.js';
import { assertNotImpersonating, authMiddleware, requireScope } from '@/modules/auth/auth.middleware.js';
import type { AppEnv } from '@/types.js';
import { ConfigurationExportService } from './configuration-export.service.js';
import { OpfieldMoveService } from './opfield-move.service.js';

export const ConfigurationExportRequestSchema = z.object({
  passphrase: z
    .string()
    .min(12)
    .max(1024)
    .describe('Passphrase that encrypts the export; at least 12 characters. Needed to restore it.'),
  includeRegistry: z.boolean().default(false).describe('Include the images of the internal registry.'),
  includeLogs: z.boolean().default(false).describe('Include the logs of the Opfield-managed ClickHouse.'),
});

export const OpfieldMoveRequestSchema = z.object({
  address: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .nullable()
    .describe('host:port nodes and relays connect to after the move (default port 9443); null withdraws it.'),
});

const estimateRoute = appRoute({
  method: 'get',
  path: '/',
  tags: ['System'],
  summary: 'Sizes of a configuration export and what stays on this host',
  responses: okJson(),
});

const prepareRoute = appRoute({
  method: 'post',
  path: '/',
  tags: ['System'],
  summary: 'Prepare an encrypted configuration export',
  description:
    'Returns a one-time download link (valid 15 minutes) that streams the encrypted export: database, environment with the master key, CA and signing keys, Opfield file volumes, and optionally the internal registry and managed logs. Nothing stops while it runs. Requires admin:system.',
  request: jsonBody(ConfigurationExportRequestSchema),
  responses: okJson(),
});

const progressRoute = appRoute({
  method: 'get',
  path: '/{id}',
  tags: ['System'],
  summary: 'Progress of a configuration export',
  request: { params: pathParamSchema('id') },
  responses: okJson(),
});

const moveStatusRoute = appRoute({
  method: 'get',
  path: '/move',
  tags: ['System'],
  summary: 'The address nodes were told Opfield moves to, per node',
  responses: okJson(),
});

const announceMoveRoute = appRoute({
  method: 'put',
  path: '/move',
  tags: ['System'],
  summary: 'Tell nodes and relays the address Opfield moves to',
  description:
    'Daemons keep the address and switch to it after the current address stayed unreachable for 10 minutes and the new one presents a certificate of the same System CA. null withdraws the address. Requires admin:system.',
  request: jsonBody(OpfieldMoveRequestSchema),
  responses: okJson(),
});

export const configurationExportRoutes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });
configurationExportRoutes.use('*', authMiddleware);
configurationExportRoutes.use('*', requireScope('admin:system'));

configurationExportRoutes.openapi(estimateRoute, async (c) =>
  c.json({ data: await container.resolve(ConfigurationExportService).estimate() })
);

configurationExportRoutes.openapi(moveStatusRoute, async (c) =>
  c.json({ data: await container.resolve(OpfieldMoveService).status() })
);

configurationExportRoutes.openapi(announceMoveRoute, async (c) => {
  assertNotImpersonating(c, 'Opfield cannot be moved while impersonating');
  const { address } = OpfieldMoveRequestSchema.parse(await c.req.json());
  const user = c.get('user')!;
  const status = await container.resolve(OpfieldMoveService).announce(address, user.id);
  await container.resolve(AuditService).log({
    userId: user.id,
    action: address ? 'system.opfield_move_announced' : 'system.opfield_move_withdrawn',
    resourceType: 'system',
    details: {
      address: status.announcement?.address ?? null,
      told: status.nodes.filter((node) => node.state === 'told').length,
      notTold: status.nodes
        .filter((node) => node.state !== 'told')
        .map((node) => ({ name: node.name, state: node.state })),
    },
    ipAddress: await getClientIpForContext(c),
    userAgent: c.req.header('user-agent'),
  });
  return c.json({ data: status });
});

configurationExportRoutes.openapi(prepareRoute, async (c) => {
  // The export carries every secret of the installation out of it.
  assertNotImpersonating(c, 'Configuration exports cannot be made while impersonating');
  const input = ConfigurationExportRequestSchema.parse(await c.req.json());
  const data = await container
    .resolve(ConfigurationExportService)
    .prepare(c.get('user')!.id, input, { ipAddress: await getClientIpForContext(c) });
  return c.json({ data });
});

configurationExportRoutes.openapi(progressRoute, async (c) =>
  c.json({ data: container.resolve(ConfigurationExportService).progress(c.req.param('id')!, c.get('user')!.id) })
);

/** The one-time download link of a prepared export; the token is the credential and is used once. */
export const configurationExportLinkRoutes = new Hono<AppEnv>();

configurationExportLinkRoutes.get('/:token', async (c) => {
  // Hono answers HEAD with the GET handler; a probe must not use up the link.
  if (c.req.method === 'HEAD') return c.body(null, 405, { Allow: 'GET' });
  const { stream, filename } = await container.resolve(ConfigurationExportService).openDownload(c.req.param('token'));
  return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
});
