import { z } from 'zod';
import { certificateNameText } from './cert.schemas.js';

const KeyUsageValues = [
  'digitalSignature',
  'keyEncipherment',
  'dataEncipherment',
  'keyAgreement',
  'nonRepudiation',
] as const;

const _ExtKeyUsageValues = [
  'serverAuth',
  'clientAuth',
  'codeSigning',
  'emailProtection',
  'timeStamping',
  'ocspSigning',
] as const;

const SubjectDnFieldsSchema = z
  .object({
    o: certificateNameText(255).optional(),
    ou: certificateNameText(255).optional(),
    l: certificateNameText(255).optional(),
    st: certificateNameText(255).optional(),
    c: certificateNameText(2).optional(),
    serialNumber: z.string().max(255).optional(),
  })
  .default({});

const AuthorityInfoAccessSchema = z
  .object({
    caIssuersUrl: z.string().url().max(500).optional(),
  })
  .default({});

const CertificatePolicySchema = z.object({
  oid: z.string().regex(/^\d+(\.\d+)+$/, 'Must be a valid OID'),
  qualifier: z.string().max(1024).optional(),
});

const CustomExtensionSchema = z.object({
  oid: z.string().regex(/^\d+(\.\d+)+$/, 'Must be a valid OID'),
  critical: z.boolean().default(false),
  value: z
    .string()
    .regex(/^[0-9a-fA-F]+$/, 'Must be non-empty hex-encoded DER')
    .min(4, 'Must be at least 2 bytes (4 hex chars)')
    .max(10000)
    .refine((v) => v.length % 2 === 0, 'Must have even length'),
});

export const CreateTemplateSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  certType: z.enum(['tls-server', 'tls-client', 'code-signing', 'email']),
  keyAlgorithm: z.enum(['rsa-2048', 'rsa-4096', 'ecdsa-p256', 'ecdsa-p384']).default('ecdsa-p256'),
  validityDays: z.number().int().min(1).max(3650).default(365),
  keyUsage: z.array(z.enum(KeyUsageValues)),
  extKeyUsage: z.array(z.string().min(1).max(255)), // allows both named + custom OIDs
  requireSans: z.boolean().default(true),
  sanTypes: z.array(z.enum(['dns', 'ip', 'email', 'uri'])).default(['dns', 'ip']),
  subjectDnFields: SubjectDnFieldsSchema.optional(),
  crlDistributionPoints: z.array(z.string().url().max(500)).default([]),
  authorityInfoAccess: AuthorityInfoAccessSchema.optional(),
  certificatePolicies: z.array(CertificatePolicySchema).default([]),
  customExtensions: z.array(CustomExtensionSchema).default([]),
  /** Destination template folder; needs pki:templates:folders:manage, like moving the template there. */
  folderId: z.string().uuid().nullable().optional(),
});

// Placement changes go through the folder routes, which check the move rules.
export const UpdateTemplateSchema = CreateTemplateSchema.omit({ folderId: true }).partial();

export type CreateTemplateInput = z.infer<typeof CreateTemplateSchema>;
export type UpdateTemplateInput = z.infer<typeof UpdateTemplateSchema>;
