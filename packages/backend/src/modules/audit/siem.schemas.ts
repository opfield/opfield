import { z } from 'zod';

export const SIEM_AUTH_TYPES = ['bearer', 'hmac_sha256', 'custom_header'] as const;
export const SIEM_DELIVERY_STATUSES = [
  'queued',
  'delivering',
  'retrying',
  'delivered',
  'failed',
  'paused',
  'discarded',
] as const;

function isSecureSiemEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !!url.hostname && !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}

export const SiemEndpointUrlSchema = z
  .string()
  .trim()
  .max(2048)
  .refine(
    isSecureSiemEndpoint,
    'SIEM endpoint must be an HTTPS URL without credentials, query parameters, or fragments'
  );

const RESERVED_SIEM_HEADER_NAMES = new Set([
  'connection',
  'content-length',
  'content-type',
  'host',
  'keep-alive',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'user-agent',
  'x-gateway-schema-version',
  'x-gateway-signature-256',
  'x-gateway-timestamp',
]);

export const SiemCustomHeaderNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .regex(/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/, 'Custom header name must be a valid HTTP field name')
  .refine(
    (value) => !RESERVED_SIEM_HEADER_NAMES.has(value.toLowerCase()),
    'Custom header name cannot override an Opfield transport header'
  );

const SiemSecretSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !/[\r\n]/.test(value), 'Authentication secret cannot contain line breaks');

export const SiemDestinationListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  enabled: z.coerce.boolean().optional(),
  search: z.string().trim().max(255).optional(),
});

export type SiemDestinationListQuery = z.infer<typeof SiemDestinationListQuerySchema>;

export const CreateSiemDestinationSchema = z
  .object({
    name: z.string().trim().min(1).max(255),
    url: SiemEndpointUrlSchema,
    authType: z.enum(SIEM_AUTH_TYPES),
    customHeaderName: SiemCustomHeaderNameSchema.optional(),
    secret: SiemSecretSchema,
    enabled: z.boolean().default(true),
  })
  .superRefine((input, ctx) => {
    if (input.authType === 'custom_header' && !input.customHeaderName) {
      ctx.addIssue({
        code: 'custom',
        path: ['customHeaderName'],
        message: 'Custom header authentication requires a header name',
      });
    }
    if (input.authType !== 'custom_header' && input.customHeaderName !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['customHeaderName'],
        message: 'Custom header name is only valid with custom header authentication',
      });
    }
  });

export type CreateSiemDestinationInput = z.infer<typeof CreateSiemDestinationSchema>;

export const UpdateSiemDestinationSchema = z
  .object({
    name: z.string().trim().min(1).max(255).optional(),
    url: SiemEndpointUrlSchema.optional(),
    authType: z.enum(SIEM_AUTH_TYPES).optional(),
    customHeaderName: SiemCustomHeaderNameSchema.optional(),
    secret: SiemSecretSchema.optional(),
    enabled: z.boolean().optional(),
  })
  .superRefine((input, ctx) => {
    if (Object.keys(input).length === 0) {
      ctx.addIssue({ code: 'custom', message: 'Provide at least one destination field to update' });
    }
    if (input.authType === 'custom_header' && !input.customHeaderName) {
      ctx.addIssue({
        code: 'custom',
        path: ['customHeaderName'],
        message: 'Custom header authentication requires a header name',
      });
    }
    if (input.authType && input.authType !== 'custom_header' && input.customHeaderName !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['customHeaderName'],
        message: 'Custom header name is only valid with custom header authentication',
      });
    }
  });

export type UpdateSiemDestinationInput = z.infer<typeof UpdateSiemDestinationSchema>;

export const SiemDeliveryListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  destinationId: z.string().uuid().optional(),
  status: z.enum(SIEM_DELIVERY_STATUSES).optional(),
});

export type SiemDeliveryListQuery = z.infer<typeof SiemDeliveryListQuerySchema>;
