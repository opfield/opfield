import { z } from 'zod';
import { BUILTIN_GROUP_NAMES, extractBaseScope } from '@/lib/scopes.js';
import {
  DelegatedScopeStringWithGitPathsSchema,
  GroupUpdateScopeStringSchema,
  MAX_DELEGATED_SCOPES,
} from '@/lib/scopes-schemas.js';

const assignable = <T extends z.ZodType<string>>(schema: T) =>
  schema
    .refine((scope) => extractBaseScope(scope) !== 'admin:system', 'admin:system cannot be assigned to custom groups')
    .refine(
      (scope) => extractBaseScope(scope) !== 'inference:setup',
      'inference:setup is an OAuth-only scope and cannot be assigned to custom groups'
    );

// Git path qualifiers are resolved to stable IDs by the group actions before anything is stored.
const scopeString = assignable(DelegatedScopeStringWithGitPathsSchema);
// Docker target IDs of an update are checked against the group's stored scopes (updateGroupForActor).
const updateScopeString = assignable(GroupUpdateScopeStringSchema);

export const CreateGroupSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'Name must be lowercase alphanumeric with hyphens')
    .refine((name) => !BUILTIN_GROUP_NAMES.includes(name), 'Cannot use a built-in group name'),
  description: z.string().max(500).optional(),
  scopes: z.array(scopeString).max(MAX_DELEGATED_SCOPES),
  parentId: z.string().uuid().nullable().optional(),
  folderId: z.string().uuid().nullable().optional(),
  requireGateway2fa: z.boolean().optional(),
});

export const UpdateGroupSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'Name must be lowercase alphanumeric with hyphens')
    .refine((name) => !BUILTIN_GROUP_NAMES.includes(name), 'Cannot use a built-in group name')
    .optional(),
  description: z.string().max(500).nullable().optional(),
  scopes: z.array(updateScopeString).max(MAX_DELEGATED_SCOPES).optional(),
  parentId: z.string().uuid().nullable().optional(),
  requireGateway2fa: z.boolean().optional(),
});

export const AssignGroupSchema = z.object({
  groupId: z.string().uuid(),
});

export const GroupResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  isBuiltin: z.boolean(),
  scopes: z.array(z.string()),
  requireGateway2fa: z.boolean(),
  memberCount: z.number().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type CreateGroupInput = z.infer<typeof CreateGroupSchema>;
export type UpdateGroupInput = z.infer<typeof UpdateGroupSchema>;
