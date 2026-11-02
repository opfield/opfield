import { z } from 'zod';
import { queryFlag } from '@/lib/query-flag.js';

export const IntegrationProviderSchema = z.enum(['gitlab', 'github', 'git', 'cloudflare', 'ssh']);
export const GitLabAllowlistModeSchema = z.enum(['selected', 'all_visible']);
export const GitLabAllowlistEntryTypeSchema = z.enum(['group', 'project']);

export const GitLabConnectorSettingsSchema = z.object({
  autoSyncEnabled: z.boolean().default(true),
  autoSyncIntervalSeconds: z.coerce.number().int().min(300).max(86_400).default(900),
  cloneShallow: z.boolean().default(true),
  cloneDepth: z.coerce.number().int().min(1).max(100).default(1),
  cloneLfs: z.boolean().default(false),
  cloneSubmodules: z.boolean().default(false),
  cloneMaxSizeMb: z.coerce.number().int().min(1).max(102_400).default(1024),
  cloneTimeoutSeconds: z.coerce.number().int().min(10).max(3600).default(300),
});

export const GitLabAllowlistEntrySchema = z.object({
  entryType: GitLabAllowlistEntryTypeSchema,
  remoteId: z.string().trim().min(1).max(128),
  fullPath: z.string().trim().min(1).max(2048),
  name: z.string().trim().min(1).max(1024).optional(),
  webUrl: z.string().url().max(2048).nullable().optional(),
});

export const GitLabConnectorCreateSchema = z.object({
  name: z.string().trim().min(1).max(255),
  baseUrl: z.string().trim().url().max(2048),
  enabled: z.boolean().default(true),
  token: z.string().min(1).max(4096),
  allowlistMode: GitLabAllowlistModeSchema.default('selected'),
  settings: GitLabConnectorSettingsSchema.partial().optional(),
  allowlistEntries: z.array(GitLabAllowlistEntrySchema).max(1000).optional(),
});

export const GitLabConnectorUpdateSchema = z.object({
  name: z.string().trim().min(1).max(255).optional(),
  baseUrl: z.string().trim().url().max(2048).optional(),
  enabled: z.boolean().optional(),
  token: z.string().min(1).max(4096).optional(),
  allowlistMode: GitLabAllowlistModeSchema.optional(),
  settings: GitLabConnectorSettingsSchema.partial().optional(),
  allowlistEntries: z.array(GitLabAllowlistEntrySchema).max(1000).optional(),
});

export const GitLabConnectorRotateTokenSchema = z.object({
  token: z.string().min(1).max(4096),
});

export const GitLabUserCredentialAuthorizeSchema = z.object({
  token: z.string().trim().min(1).max(4096),
});

export const GitUserCredentialAuthorizeSchema = z.object({
  username: z.string().trim().min(1).max(255).optional(),
  token: z.string().trim().min(1).max(4096),
});

export const GitLabConnectorListQuerySchema = z.object({
  enabled: z.preprocess(queryFlag, z.boolean().optional()),
});

export const GitLabAllowlistSearchQuerySchema = z.object({
  q: z.string().trim().min(1).max(200),
});

export const GitLabAllowlistPreviewSearchSchema = z.object({
  baseUrl: z.string().trim().url().max(2048),
  token: z.string().min(1).max(4096),
  q: z.string().trim().min(1).max(200),
});

export const GitLabConnectorPreviewTestSchema = z.object({
  baseUrl: z.string().trim().url().max(2048),
  token: z.string().min(1).max(4096),
});

export const GitConnectorModeSchema = z.enum(['single_repository', 'multi_repository']);
export const GitConnectorAuthModeSchema = z.enum(['token', 'oauth']);

const GitConnectorRepositoryFieldsSchema = z.object({
  name: z.string().trim().min(1).max(255),
  baseUrl: z.string().trim().url().max(2048),
  enabled: z.boolean().default(true),
  username: z.string().trim().min(1).max(255).optional(),
  allowlistEntries: z.array(GitLabAllowlistEntrySchema).min(1).max(1000),
});

export const GitConnectorCreateSchema = GitConnectorRepositoryFieldsSchema.extend({
  authMode: z.literal('token').default('token'),
  token: z.string().min(1).max(4096),
});

export const GitHubConnectorCreateSchema = z.object({
  name: z.string().trim().min(1).max(255),
  baseUrl: z.string().trim().url().max(2048),
  enabled: z.boolean().default(true),
  authMode: z.literal('token').default('token'),
  token: z.string().min(1).max(4096),
});

export const GitHubConnectorPreviewTestSchema = z.object({
  baseUrl: z.string().trim().url().max(2048),
  token: z.string().min(1).max(4096),
});

export const GitConnectorPreviewTestSchema = z.object({
  baseUrl: z.string().trim().url().max(2048),
  repositoryUrl: z.string().trim().url().max(2048),
  username: z.string().trim().min(1).max(255),
  token: z.string().min(1).max(4096),
});

export const GitHubOAuthStartSchema = z.object({
  connectorId: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(255),
  enabled: z.boolean().default(true),
});

export const GitConnectorUpdateSchema = z.object({
  name: z.string().trim().min(1).max(255).optional(),
  baseUrl: z.string().trim().url().max(2048).optional(),
  enabled: z.boolean().optional(),
  username: z.string().trim().min(1).max(255).nullable().optional(),
  token: z.string().min(1).max(4096).optional(),
  authMode: z.literal('token').optional(),
  allowlistEntries: z.array(GitLabAllowlistEntrySchema).min(1).max(1000).optional(),
});

export const CloudflareConnectorSettingsSchema = z.object({
  autoSyncEnabled: z.boolean().default(true),
  autoSyncIntervalSeconds: z.coerce.number().int().min(300).max(86_400).default(900),
  defaultTtl: z.coerce.number().int().min(1).max(86_400).default(1),
  defaultProxied: z.boolean().default(true),
});

export const CloudflareConnectorCreateSchema = z.object({
  name: z.string().trim().min(1).max(255),
  enabled: z.boolean().default(true),
  token: z.string().min(1).max(4096),
  settings: CloudflareConnectorSettingsSchema.partial().optional(),
});

export const CloudflareConnectorUpdateSchema = z.object({
  name: z.string().trim().min(1).max(255).optional(),
  enabled: z.boolean().optional(),
  settings: CloudflareConnectorSettingsSchema.partial().optional(),
});

export const CloudflareConnectorRotateTokenSchema = z.object({
  token: z.string().min(1).max(4096),
});

export const CloudflareConnectorListQuerySchema = z.object({
  enabled: z.preprocess(queryFlag, z.boolean().optional()),
});

export const CloudflareConnectorPreviewTestSchema = z.object({
  token: z.string().min(1).max(4096),
});

export const ExternalSshHostKeySchema = z.object({
  host: z.string().trim().min(1).max(255),
  port: z.number().int().min(1).max(65535).optional(),
  jumpConnectorId: z.string().uuid().nullable().optional(),
});

export const ExternalSshConnectorCreateSchema = z.object({
  name: z.string().trim().min(1).max(255),
  host: z.string().trim().min(1).max(255),
  port: z.number().int().min(1).max(65535).optional(),
  username: z.string().trim().min(1).max(255),
  authMethod: z.enum(['password', 'private_key']),
  secret: z.string().max(16_384).optional(),
  hostFingerprint: z.string().trim().min(1).max(255),
  jumpConnectorId: z.string().uuid().nullable().optional(),
  enabled: z.boolean().optional(),
  generatePrivateKey: z.boolean().optional(),
  reuseCredentialFromConnectorId: z.string().uuid().optional(),
});

export const ExternalSshConnectorUpdateSchema = z.object({ name: z.string().trim().min(1).max(255) }).strict();

export type GitLabConnectorCreateInput = z.infer<typeof GitLabConnectorCreateSchema>;
export type GitLabConnectorUpdateInput = z.infer<typeof GitLabConnectorUpdateSchema>;
export type GitLabConnectorRotateTokenInput = z.infer<typeof GitLabConnectorRotateTokenSchema>;
export type GitLabUserCredentialAuthorizeInput = z.infer<typeof GitLabUserCredentialAuthorizeSchema>;
export type GitUserCredentialAuthorizeInput = z.infer<typeof GitUserCredentialAuthorizeSchema>;
export type GitLabConnectorListQuery = z.infer<typeof GitLabConnectorListQuerySchema>;
export type GitLabAllowlistEntryInput = z.infer<typeof GitLabAllowlistEntrySchema>;
export type GitLabAllowlistPreviewSearchInput = z.infer<typeof GitLabAllowlistPreviewSearchSchema>;
export type GitLabConnectorPreviewTestInput = z.infer<typeof GitLabConnectorPreviewTestSchema>;
export type GitConnectorCreateInput = z.infer<typeof GitConnectorCreateSchema>;
export type GitHubConnectorCreateInput = z.infer<typeof GitHubConnectorCreateSchema>;
export type GitHubConnectorPreviewTestInput = z.infer<typeof GitHubConnectorPreviewTestSchema>;
export type GitConnectorPreviewTestInput = z.infer<typeof GitConnectorPreviewTestSchema>;
export type GitConnectorUpdateInput = z.infer<typeof GitConnectorUpdateSchema>;
export type GitHubOAuthStartInput = z.infer<typeof GitHubOAuthStartSchema>;
export type CloudflareConnectorCreateInput = z.infer<typeof CloudflareConnectorCreateSchema>;
export type CloudflareConnectorUpdateInput = z.infer<typeof CloudflareConnectorUpdateSchema>;
export type CloudflareConnectorRotateTokenInput = z.infer<typeof CloudflareConnectorRotateTokenSchema>;
export type CloudflareConnectorListQuery = z.infer<typeof CloudflareConnectorListQuerySchema>;
export type CloudflareConnectorSettingsInput = z.infer<typeof CloudflareConnectorSettingsSchema>;
export type CloudflareConnectorPreviewTestInput = z.infer<typeof CloudflareConnectorPreviewTestSchema>;
