import { OpenAPIHono, z } from '@hono/zod-openapi';
import { container } from '@/container.js';
import { appRoute, jsonBody, okJson, openApiValidationHook } from '@/lib/openapi.js';
import { authMiddleware, requireAccountScope, requireScope } from '@/modules/auth/auth.middleware.js';
import type { AppEnv } from '@/types.js';
import { inferenceCoreOperationSchema, inferenceCoreStatusSchema } from './inference-core.contract.js';
import { InferenceCoreRuntimeService } from './inference-core-runtime.service.js';

/**
 * Browser-facing lifecycle API for the managed inference core. These routes
 * stay reachable while the inference feature flag is off: installing the core
 * is exactly what a fresh administrator must do before enabling inference.
 */

const coreStatusRoute = appRoute({
  method: 'get',
  path: '/status',
  tags: ['Inference'],
  summary: 'Read the managed inference core lifecycle status',
  responses: okJson(inferenceCoreStatusSchema),
});

export const coreVersionInputSchema = z
  .object({
    version: z
      .string()
      .regex(/^\d+\.\d+\.\d+-(?:wiolett|thesqlabs)\.\d+$/)
      .optional()
      .openapi({ description: 'Target core version (defaults to the latest published release)' }),
  })
  .strict();

const coreOperationAcceptedSchema = z.object({ operation: inferenceCoreOperationSchema }).strict();

const acceptedJson = (schema: z.ZodTypeAny) => ({
  202: {
    description: 'Operation accepted and running',
    content: { 'application/json': { schema } },
  },
});

const coreInstallRoute = appRoute({
  method: 'post',
  path: '/install',
  tags: ['Inference'],
  summary: 'Install the managed inference core on the Opfield host',
  request: jsonBody(coreVersionInputSchema),
  responses: acceptedJson(coreOperationAcceptedSchema),
});

export const coreUpdateInputSchema = z
  .object({
    version: z
      .string()
      .regex(/^\d+\.\d+\.\d+-(?:wiolett|thesqlabs)\.\d+$/)
      .openapi({ description: 'Target core version from the release channel' }),
  })
  .strict();

const coreUpdateRoute = appRoute({
  method: 'post',
  path: '/update',
  tags: ['Inference'],
  summary: 'Update the managed inference core with automatic rollback',
  request: jsonBody(coreUpdateInputSchema),
  responses: acceptedJson(coreOperationAcceptedSchema),
});

const coreRepairRoute = appRoute({
  method: 'post',
  path: '/repair',
  tags: ['Inference'],
  summary: 'Repair a degraded or failed inference core',
  responses: acceptedJson(coreOperationAcceptedSchema),
});

const coreCheckUpdatesRoute = appRoute({
  method: 'post',
  path: '/check-updates',
  tags: ['Inference'],
  summary: 'Check the release channel for a newer core and record the result',
  responses: okJson(
    z
      .object({
        latest: z
          .object({
            version: z.string(),
            digest: z.string(),
            sizeBytes: z.number(),
            releaseNotesUrl: z.string().nullable(),
          })
          .strict()
          .nullable(),
      })
      .strict()
  ),
});

export const inferenceCoreLifecycleRoutes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

inferenceCoreLifecycleRoutes.use('*', authMiddleware);
// feat:ai:use is user-only. Bearer callers inherit it from the token owner; every route below still
// requires its own delegated inference:providers:* scope.
inferenceCoreLifecycleRoutes.use('*', requireAccountScope('feat:ai:use'));

inferenceCoreLifecycleRoutes.openapi(
  { ...coreStatusRoute, middleware: requireScope('inference:providers:view') },
  async (c) => c.json(await container.resolve(InferenceCoreRuntimeService).getStatus())
);

inferenceCoreLifecycleRoutes.openapi(
  { ...coreInstallRoute, middleware: requireScope('inference:providers:manage') },
  async (c) => {
    const input = coreVersionInputSchema.parse(await c.req.json().catch(() => ({})));
    const operation = await container.resolve(InferenceCoreRuntimeService).install(input.version);
    return c.json({ operation }, 202);
  }
);

inferenceCoreLifecycleRoutes.openapi(
  { ...coreUpdateRoute, middleware: requireScope('inference:providers:manage') },
  async (c) => {
    const input = coreUpdateInputSchema.parse(await c.req.json());
    const operation = await container.resolve(InferenceCoreRuntimeService).update(input.version);
    return c.json({ operation }, 202);
  }
);

inferenceCoreLifecycleRoutes.openapi(
  { ...coreRepairRoute, middleware: requireScope('inference:providers:manage') },
  async (c) => {
    const operation = await container.resolve(InferenceCoreRuntimeService).repair();
    return c.json({ operation }, 202);
  }
);

inferenceCoreLifecycleRoutes.openapi(
  { ...coreCheckUpdatesRoute, middleware: requireScope('inference:providers:manage') },
  async (c) => {
    const latest = await container.resolve(InferenceCoreRuntimeService).checkForUpdates();
    return c.json({
      latest: latest
        ? {
            version: latest.version,
            digest: latest.digest,
            sizeBytes: latest.sizeBytes,
            releaseNotesUrl: latest.releaseNotesUrl,
          }
        : null,
    });
  }
);
