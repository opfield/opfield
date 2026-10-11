import { z } from 'zod';
import { queryFlag } from '@/modules/apps/app-membership.js';

// ---------------------------------------------------------------------------
// Create folder
// ---------------------------------------------------------------------------

export const CreateFolderSchema = z.object({
  name: z.string().min(1).max(255),
  parentId: z.string().uuid().optional(),
});

// ---------------------------------------------------------------------------
// Update folder (rename only)
// ---------------------------------------------------------------------------

export const UpdateFolderSchema = z.object({
  name: z.string().min(1).max(255),
});

// ---------------------------------------------------------------------------
// Move folder to new parent
// ---------------------------------------------------------------------------

export const MoveFolderSchema = z.object({
  parentId: z.string().uuid().nullable(),
});

// ---------------------------------------------------------------------------
// Reorder folders within a parent
// ---------------------------------------------------------------------------

export const ReorderFoldersSchema = z.object({
  items: z
    .array(
      z.object({
        id: z.string().uuid(),
        sortOrder: z.number().int().min(0),
      })
    )
    .min(1),
});

// ---------------------------------------------------------------------------
// Grouped hosts query — filters without pagination
// ---------------------------------------------------------------------------

export const GroupedHostsQuerySchema = z.object({
  type: z.enum(['proxy', 'redirect', '404']).optional(),
  enabled: z.coerce.boolean().optional(),
  healthStatus: z.enum(['online', 'offline', 'degraded', 'unknown', 'disabled']).optional(),
  search: z.string().max(255).optional(),
  /** Leave out routes that belong to an app (always the case without `appId`). */
  excludeAppMembers: z.preprocess(queryFlag, z.boolean().optional()),
  /** Only the routes of this app (any environment), listed in `ungroupedHosts` with their `app`. */
  appId: z.string().uuid().optional(),
});

// ---------------------------------------------------------------------------
// Move hosts to folder (batch)
// ---------------------------------------------------------------------------

export const MoveHostsToFolderSchema = z.object({
  hostIds: z.array(z.string().uuid()).min(1),
  folderId: z.string().uuid().nullable(),
});

// ---------------------------------------------------------------------------
// Reorder hosts within a folder
// ---------------------------------------------------------------------------

export const ReorderHostsSchema = z.object({
  items: z
    .array(
      z.object({
        id: z.string().uuid(),
        sortOrder: z.number().int().min(0),
      })
    )
    .min(1),
});

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------

export type CreateFolderInput = z.infer<typeof CreateFolderSchema>;
export type UpdateFolderInput = z.infer<typeof UpdateFolderSchema>;
export type MoveFolderInput = z.infer<typeof MoveFolderSchema>;
export type ReorderFoldersInput = z.infer<typeof ReorderFoldersSchema>;
export type GroupedHostsQuery = z.infer<typeof GroupedHostsQuerySchema>;
export type MoveHostsToFolderInput = z.infer<typeof MoveHostsToFolderSchema>;
export type ReorderHostsInput = z.infer<typeof ReorderHostsSchema>;
