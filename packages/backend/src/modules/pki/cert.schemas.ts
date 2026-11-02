import { z } from 'zod';

/** Control characters: a line break in a certificate name left the attribute empty. */
export function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 0x20 || code === 0x7f;
  });
}

/** Text of a certificate name attribute: what x509.Name cannot express is refused here, not lost on the way. */
export const certificateNameText = (max: number, min = 0) =>
  z
    .string()
    .min(min)
    .max(max)
    .refine((value) => !hasControlCharacter(value), 'Control characters are not allowed');

export const IssueCertificateSchema = z.object({
  caId: z.string().uuid(),
  templateId: z.string().uuid().optional(),
  type: z.enum(['tls-server', 'tls-client', 'code-signing', 'email']),
  commonName: certificateNameText(255, 1),
  sans: z.array(z.string()).default([]),
  keyAlgorithm: z.enum(['rsa-2048', 'rsa-4096', 'ecdsa-p256', 'ecdsa-p384']),
  validityDays: z.number().int().min(1).max(3650),
  /** End the certificate with its CA when the requested validity would outlive it (instead of failing). */
  clampToCaValidity: z.boolean().optional(),
  subjectDnFields: z
    .object({
      o: certificateNameText(255).optional(),
      ou: certificateNameText(255).optional(),
      l: certificateNameText(255).optional(),
      st: certificateNameText(255).optional(),
      c: certificateNameText(2).optional(),
    })
    .optional(),
  /** Destination certificate folder; needs pki:cert:folders:manage, like moving the certificate there. */
  folderId: z.string().uuid().nullable().optional(),
});

export const IssueCertFromCSRSchema = z.object({
  caId: z.string().uuid(),
  templateId: z.string().uuid().optional(),
  type: z.enum(['tls-server', 'tls-client', 'code-signing', 'email']),
  csrPem: z.string().min(1),
  validityDays: z.number().int().min(1).max(3650),
  overrideSans: z.array(z.string()).optional(),
  /** End the certificate with its CA when the requested validity would outlive it (instead of failing). */
  clampToCaValidity: z.boolean().optional(),
  /** Destination certificate folder; needs pki:cert:folders:manage, like moving the certificate there. */
  folderId: z.string().uuid().nullable().optional(),
});

export const RevokeCertificateSchema = z.object({
  reason: z
    .enum([
      'unspecified',
      'keyCompromise',
      'caCompromise',
      'affiliationChanged',
      'superseded',
      'cessationOfOperation',
      'certificateHold',
    ])
    .default('unspecified'),
});

export const CertificateListQuerySchema = z.object({
  caId: z.string().uuid().optional(),
  status: z.enum(['active', 'revoked', 'expired']).optional(),
  type: z.enum(['tls-server', 'tls-client', 'code-signing', 'email']).optional(),
  search: z.string().optional(),
  showSystem: z.preprocess((v) => (v === 'true' ? true : v === 'false' ? false : undefined), z.boolean().optional()),
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(20),
  sortBy: z.enum(['commonName', 'createdAt', 'notAfter', 'type']).default('createdAt'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

export const ExportCertificateQuerySchema = z.object({
  format: z.enum(['pem', 'der', 'pkcs12', 'jks', 'chain', 'fullchain', 'private-key', 'pem-bundle']),
  passphrase: z.string().optional(),
});

export type IssueCertificateInput = z.infer<typeof IssueCertificateSchema>;
export type IssueCertFromCSRInput = z.infer<typeof IssueCertFromCSRSchema>;
export type CertificateListQuery = z.infer<typeof CertificateListQuerySchema>;
