import { z } from '@hono/zod-openapi';

/** Renewal progress of a managed storage cluster or managed database TLS certificate. */
export const ManagedCertificateStatusSchema = z
  .object({
    ownerType: z.enum(['managed_storage', 'managed_database']),
    ownerId: z.string(),
    certificate: z
      .object({
        id: z.string(),
        serialNumber: z.string(),
        notBefore: z.string(),
        notAfter: z.string(),
        daysRemaining: z.number().int(),
        sans: z.array(z.string()),
      })
      .nullable(),
    renewal: z.object({
      state: z.string().openapi({
        description:
          'idle, delivering, awaiting_reload (delivered, the engine rereads it on its own schedule), waiting_for_daemon, ca_limited (the issuing CA ends first) or failed',
      }),
      reason: z.string().nullable(),
      due: z.boolean(),
      dueReason: z.string().nullable().openapi({
        description:
          'lifetime (2/3 passed), expiring (30 days or less), names_missing, usage_missing (the leaf of a database set member lacks clientAuth), ca_changed, or null',
      }),
      urgent: z.boolean().openapi({ description: '7 days or less remain: a restart is allowed to apply it' }),
      hotReloadSupported: z.boolean(),
      skipReason: z.string().nullable(),
      attempts: z.number().int(),
      lastAttemptAt: z.string().nullable(),
      nextAttemptAt: z.string().nullable(),
      deliveredAt: z.string().nullable(),
      lastSuccessAt: z.string().nullable(),
      lastError: z.string().nullable(),
      lastMethod: z.string().nullable(),
      lastRestarted: z.boolean(),
      pendingSerial: z.string().nullable(),
    }),
  })
  .openapi('ManagedCertificateStatus');

export const RenewManagedCertificateSchema = z
  .object({
    allowRestart: z.boolean().optional().openapi({
      description:
        'Restart the workload when the engine does not load the renewed certificate by itself. Without it the certificate is reloaded in place and, for an engine that rereads it on a schedule, finished later.',
    }),
  })
  .strict();

export type RenewManagedCertificateInput = z.infer<typeof RenewManagedCertificateSchema>;
