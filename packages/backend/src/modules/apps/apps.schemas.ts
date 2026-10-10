import { z } from '@hono/zod-openapi';
import { APP_MEMBER_TYPES } from './app-families.js';

const name = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((value) => ![...value].some((char) => char.charCodeAt(0) < 32), 'Name contains control characters');

export const CreateAppSchema = z.object({ name: name(255) }).strict();

export const UpdateAppSchema = z
  .object({
    name: name(255).optional(),
    maintenanceOverride: z.boolean().optional(),
  })
  .strict();

export const CreateAppEnvironmentSchema = z.object({ name: name(64) }).strict();

export const UpdateAppEnvironmentSchema = z
  .object({
    name: name(64).optional(),
    /** Only `true`: the Production marker moves to this environment. */
    isProduction: z.literal(true).optional(),
    maintenanceEnabled: z.boolean().optional(),
  })
  .strict();

export const AppMemberRefSchema = z
  .object({
    type: z.enum(APP_MEMBER_TYPES),
    id: z.string().min(1).max(512).optional(),
    nodeId: z.string().uuid().optional(),
    /** Containers: the container name (same as id). */
    resourceKey: z.string().min(1).max(512).optional(),
  })
  .strict();

export const PlaceAppMembersSchema = z
  .object({
    target: z.object({ appId: z.string().uuid(), environmentId: z.string().uuid() }).strict().nullable(),
    members: z.array(AppMemberRefSchema).min(1).max(200),
  })
  .strict();

export const AppMembersQuerySchema = z.object({ environmentId: z.string().uuid().optional() });

export type CreateAppInput = z.infer<typeof CreateAppSchema>;
export type UpdateAppInput = z.infer<typeof UpdateAppSchema>;
export type CreateAppEnvironmentInput = z.infer<typeof CreateAppEnvironmentSchema>;
export type UpdateAppEnvironmentInput = z.infer<typeof UpdateAppEnvironmentSchema>;
export type PlaceAppMembersInput = z.infer<typeof PlaceAppMembersSchema>;
export type AppMemberRefInput = z.infer<typeof AppMemberRefSchema>;

export const SetAppVariablesSchema = z
  .object({
    variables: z.array(z.object({ key: z.string().min(1).max(255), value: z.string() }).strict()).max(200),
  })
  .strict();

export const PatchAppSecretsSchema = z
  .object({
    set: z.record(z.string().min(1).max(255), z.string()).optional(),
    delete: z.array(z.string().min(1).max(255)).max(200).optional(),
  })
  .strict();
