import { z } from 'zod';
import { appListQueryFields } from '@/modules/apps/app-list-query.js';

const domainNameRegex = /^(\*\.)?([a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;

export const CreateDomainSchema = z.object({
  domain: z.string().trim().toLowerCase().min(1).max(253).regex(domainNameRegex, 'Invalid domain name format'),
  dnsProvider: z.enum(['cloudflare', 'external']).default('cloudflare'),
  description: z.string().max(1000).optional(),
  folderId: z.string().uuid().optional().nullable(),
  ttl: z.coerce.number().int().min(1).max(86_400).optional(),
  proxied: z.boolean().optional(),
  overwriteDns: z.boolean().optional(),
  nginxNodeId: z.string().uuid().optional(),
  /** Serve the domain from every member of this ingress group; DNS gets the union of the members' addresses. */
  ingressGroupId: z.string().uuid().optional(),
});

export const PreviewDomainSchema = CreateDomainSchema.pick({
  domain: true,
  dnsProvider: true,
  ttl: true,
  proxied: true,
  nginxNodeId: true,
  ingressGroupId: true,
});

export const UpdateDomainSchema = z.object({
  description: z.string().max(1000).optional().nullable(),
  proxied: z.boolean().optional(),
  /**
   * Move the domain and every route on it onto this ingress group (a planned operation: config and certificates on
   * the new members first, then DNS), or with null back to `nginxNodeId`, a current member (DNS first).
   */
  ingressGroupId: z.string().uuid().nullable().optional(),
  nginxNodeId: z.string().uuid().optional(),
});

/** Change where a domain and its routes are served: onto an ingress group, or back to one member node. */
export const DomainIngressPlacementSchema = z
  .object({
    ingressGroupId: z.string().uuid().nullable(),
    nginxNodeId: z.string().uuid().optional(),
  })
  .refine((value) => value.ingressGroupId !== null || !!value.nginxNodeId, {
    message: 'Pass nginxNodeId (a current group member) to serve the domain from one node',
    path: ['nginxNodeId'],
  });

export const DeleteDomainSchema = z.object({
  deleteDns: z.boolean().optional(),
});

export const ResolveCloudflareMigrationSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('retry') }),
  z.object({ action: z.literal('keep_external') }),
  z.object({ action: z.literal('update_dns'), nginxNodeId: z.string().uuid() }),
]);

/** Optional body for issuing an ACME certificate from a domain: the SSL certificate folder to create it in. */
export const IssueDomainCertificateSchema = z.object({
  folderId: z.string().uuid().optional().nullable(),
});

export const DomainIngressMigrationSchema = z.object({
  targetNodeId: z.string().uuid(),
});

export const DomainListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(1000).default(20),
  dnsStatus: z.enum(['valid', 'invalid', 'pending', 'unknown']).optional(),
  search: z.string().max(255).optional(),
  ...appListQueryFields,
});

export type CreateDomainInput = z.input<typeof CreateDomainSchema>;
export type PreviewDomainInput = z.input<typeof PreviewDomainSchema>;
export type UpdateDomainInput = z.infer<typeof UpdateDomainSchema>;
export type DeleteDomainInput = z.infer<typeof DeleteDomainSchema>;
export type ResolveCloudflareMigrationInput = z.infer<typeof ResolveCloudflareMigrationSchema>;
export type DomainIngressMigrationInput = z.infer<typeof DomainIngressMigrationSchema>;
export type DomainIngressPlacementInput = z.infer<typeof DomainIngressPlacementSchema>;
export type IssueDomainCertificateInput = z.infer<typeof IssueDomainCertificateSchema>;
export type DomainListQuery = z.infer<typeof DomainListQuerySchema>;
