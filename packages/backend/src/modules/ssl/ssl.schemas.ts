import { z } from 'zod';
import { queryFlag } from '@/modules/apps/app-membership.js';

const domainRegex = /^(\*\.)?([a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;

export const RequestACMECertSchema = z
  .object({
    domains: z.array(z.string().regex(domainRegex, 'Invalid domain format')).min(1, 'At least one domain is required'),
    challengeType: z.enum(['http-01', 'dns-01']),
    provider: z.enum(['letsencrypt', 'letsencrypt-staging']).default('letsencrypt'),
    folderId: z.string().uuid().nullable().optional(),
    dnsProvider: z.enum(['cloudflare']).optional(),
    autoRenew: z.boolean().optional(),
  })
  .transform((data) => ({
    ...data,
    autoRenew: data.challengeType === 'http-01' || data.dnsProvider === 'cloudflare' ? (data.autoRenew ?? true) : false,
  }));

export const UploadCertSchema = z.object({
  name: z.string().min(1).max(255),
  folderId: z.string().uuid().nullable().optional(),
  certificatePem: z.string().refine((v) => v.trimStart().startsWith('-----BEGIN CERTIFICATE-----'), {
    message: 'Certificate must start with -----BEGIN CERTIFICATE-----',
  }),
  privateKeyPem: z.string().refine((v) => v.trimStart().startsWith('-----BEGIN'), {
    message: 'Private key must start with -----BEGIN',
  }),
  chainPem: z.string().optional(),
});

export const LinkInternalCertSchema = z.object({
  internalCertId: z.string().uuid(),
  name: z.string().min(1).max(255).optional(),
  folderId: z.string().uuid().nullable().optional(),
});

export const SetSslAutoRenewSchema = z.object({
  enabled: z.boolean(),
  provider: z.enum(['cloudflare']).optional(),
});

export const SSLCertListQuerySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(20),
  type: z.enum(['acme', 'upload', 'internal']).optional(),
  status: z.enum(['active', 'expired', 'pending', 'error']).optional(),
  search: z.string().optional(),
  showSystem: z.preprocess((v) => (v === 'true' ? true : v === 'false' ? false : undefined), z.boolean().optional()),
  /** Leave out certificates that belong to an app (the normal list). */
  excludeAppMembers: z.preprocess(queryFlag, z.boolean().optional()),
  /** Only the certificates of this app (any environment). */
  appId: z.string().uuid().optional(),
});

export type RequestACMECertInput = z.output<typeof RequestACMECertSchema>;
export type UploadCertInput = z.infer<typeof UploadCertSchema>;
export type LinkInternalCertInput = z.infer<typeof LinkInternalCertSchema>;
export type SetSslAutoRenewInput = z.infer<typeof SetSslAutoRenewSchema>;
export type SSLCertListQuery = z.infer<typeof SSLCertListQuerySchema>;
