import { z } from 'zod';
import { certificateNameText } from './cert.schemas.js';

export const CreateRootCASchema = z.object({
  commonName: certificateNameText(255, 1),
  keyAlgorithm: z.enum(['rsa-2048', 'rsa-4096', 'ecdsa-p256', 'ecdsa-p384']),
  validityYears: z.number().int().min(1).max(30),
  pathLengthConstraint: z.number().int().min(0).optional(),
  maxValidityDays: z.number().int().min(1).max(3650).default(365),
  /** Destination CA folder; needs pki:ca:edit there, like moving the root CA into it. */
  folderId: z.string().uuid().nullable().optional(),
});

export const CreateIntermediateCASchema = z.object({
  commonName: certificateNameText(255, 1),
  keyAlgorithm: z.enum(['rsa-2048', 'rsa-4096', 'ecdsa-p256', 'ecdsa-p384']),
  validityYears: z.number().int().min(1).max(20),
  pathLengthConstraint: z.number().int().min(0).optional(),
  maxValidityDays: z.number().int().min(1).max(3650).default(365),
  /** An intermediate CA is listed in the folder of its root CA; when given, it must be that folder. */
  folderId: z.string().uuid().nullable().optional(),
});

export const RevokeCASchema = z.object({
  reason: z.string().min(1).max(255),
});

export const ExportCAKeySchema = z.object({
  passphrase: z.string().min(8),
});

export const UpdateCASchema = z.object({
  crlDistributionUrl: z.string().url().max(500).optional().nullable(),
  caIssuersUrl: z.string().url().max(500).optional().nullable(),
  maxValidityDays: z.number().int().min(1).max(3650).optional(),
});

export type CreateRootCAInput = z.infer<typeof CreateRootCASchema>;
export type CreateIntermediateCAInput = z.infer<typeof CreateIntermediateCASchema>;
export type UpdateCAInput = z.infer<typeof UpdateCASchema>;
