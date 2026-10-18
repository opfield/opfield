import { z } from 'zod';

export const WebhookListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  enabled: z.coerce.boolean().optional(),
  search: z.string().optional(),
  /** Only the webhooks in this folder (not its subfolders). */
  folderId: z.string().uuid().optional(),
});

export type WebhookListQuery = z.infer<typeof WebhookListQuerySchema>;

export const CreateWebhookSchema = z.object({
  name: z.string().min(1).max(255),
  url: z.string().url().max(2048),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH']).default('POST'),
  enabled: z.boolean().default(true),
  signingSecret: z.string().max(500).optional(),
  signingHeader: z.string().max(100).default('X-Signature-256'),
  templatePreset: z.string().max(50).nullable().optional(),
  bodyTemplate: z.string().max(65536).optional(),
  headers: z.record(z.string(), z.string()).default({}),
  /** Destination folder (null or omitted: ungrouped); needs notifications:webhooks:manage there. */
  folderId: z.string().uuid().nullable().optional(),
});

export type CreateWebhookInput = z.infer<typeof CreateWebhookSchema>;

export const UpdateWebhookSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  url: z.string().url().max(2048).optional(),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH']).optional(),
  enabled: z.boolean().optional(),
  signingSecret: z.string().max(500).nullable().optional(),
  signingHeader: z.string().max(100).optional(),
  templatePreset: z.string().max(50).nullable().optional(),
  bodyTemplate: z.string().max(65536).optional(),
  headers: z.record(z.string(), z.string()).optional(),
});

export type UpdateWebhookInput = z.infer<typeof UpdateWebhookSchema>;
