import { z } from 'zod';
import { appListQueryFields } from '@/modules/apps/app-list-query.js';
import { NODE_APPEARANCE_COLORS } from '@/modules/nodes/nodes.schemas.js';

export const PageProjectListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().max(255).optional(),
  folderId: z.string().uuid().optional().nullable(),
  ...appListQueryFields,
});

/** Placement options for a create into `folderId`: inside an app environment only the nodes it allows. */
export const PageProjectPlacementOptionsQuerySchema = z.object({
  folderId: z.string().uuid().optional(),
});

export const CreatePageProjectSchema = z.object({
  name: z.string().trim().min(1).max(255),
  nodeId: z.string().uuid(),
  description: z.string().trim().max(2000).optional().nullable(),
  folderId: z.string().uuid().optional().nullable(),
  maxDeployments: z.number().int().min(1).max(500).default(20),
  storageQuotaBytes: z.number().int().min(1_048_576).max(Number.MAX_SAFE_INTEGER).default(1_073_741_824),
});

export const MigratePageProjectSchema = z.object({
  targetNodeId: z.string().uuid(),
});

const PageFallbackUrlSchema = z
  .string()
  .trim()
  .max(2048)
  .url()
  .refine((value) => ['http:', 'https:'].includes(new URL(value).protocol), 'Fallback URL must use HTTP or HTTPS')
  .refine((value) => !/[\s;'"{}\\`$#]/.test(value), 'Fallback URL contains unsupported characters');

export const UpdatePageProjectSchema = z
  .object({
    name: z.string().trim().min(1).max(255).optional(),
    description: z.string().trim().max(2000).optional().nullable(),
    appearanceColor: z.enum(NODE_APPEARANCE_COLORS).nullable().optional(),
    previewsEnabled: z.boolean().optional(),
    spaFallback: z.boolean().optional(),
    fallbackUrl: PageFallbackUrlSchema.nullable().optional(),
    maxDeployments: z.number().int().min(1).max(500).optional(),
    storageQuotaBytes: z.number().int().min(1_048_576).max(Number.MAX_SAFE_INTEGER).optional(),
    /** Access list applied to every preview host of the Project; null removes it. */
    accessListId: z.string().uuid().nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'At least one field must be provided');

export type PageProjectListQuery = z.infer<typeof PageProjectListQuerySchema>;
export type CreatePageProjectInput = z.infer<typeof CreatePageProjectSchema>;
export type UpdatePageProjectInput = z.infer<typeof UpdatePageProjectSchema>;
export type MigratePageProjectInput = z.infer<typeof MigratePageProjectSchema>;
