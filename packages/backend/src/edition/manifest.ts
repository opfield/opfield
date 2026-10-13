import { z } from 'zod';
import { verifySignedPayload } from '@/lib/update-artifact-trust.js';
import { COMMERCIAL_HOST_API_VERSION } from './contract.js';

export const COMMERCIAL_MANIFEST_MAX_BYTES = 1024 * 1024;
export const COMMERCIAL_BACKEND_MAX_BYTES = 64 * 1024 * 1024;
export const COMMERCIAL_RELEASE_ID = /^[a-f0-9]{64}$/;

const pathSchema = z
  .string()
  .max(240)
  .regex(/^(?:backend|frontend)\/[a-zA-Z0-9_./-]+$/)
  .refine((path) => path.split('/').every((part) => part !== '' && part !== '.' && part !== '..'));
const fileSchema = z
  .object({
    path: pathSchema,
    sha256: z.string().regex(COMMERCIAL_RELEASE_ID),
    size: z
      .number()
      .int()
      .nonnegative()
      .max(1024 * 1024 * 1024),
  })
  .strict();

export const commercialManifestSchema = z
  .object({
    // legacy-name: `gateway-commercial` manifest kind — 2.12.0 verifies the private core of the release it updates to
    // and the license server checks the kind, so commercial builds keep emitting it; remove once 2.12.0 is no longer an
    // update source (2.13.0 core emits `opfield-commercial`).
    kind: z.enum(['opfield-commercial', 'gateway-commercial']),
    version: z.string().min(1).max(80),
    hostVersion: z.string().min(1).max(80),
    hostApiVersion: z.literal(COMMERCIAL_HOST_API_VERSION),
    backendEntry: z.literal('backend/index.cjs'),
    files: z.array(fileSchema).min(1).max(4096),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    const paths = manifest.files.map((file) => file.path);
    if (new Set(paths).size !== paths.length || !paths.includes(manifest.backendEntry)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Manifest contains duplicate paths or no backend entry' });
    }
    // A single self-contained backend bundle is imported from verified bytes. No
    // relative imports or sibling executable files can evade the entry hash.
    if (paths.some((path) => path.startsWith('backend/') && path !== manifest.backendEntry)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Backend must be a single bundled module' });
    }
    if (
      manifest.files.some((file) => file.path === manifest.backendEntry && file.size > COMMERCIAL_BACKEND_MAX_BYTES)
    ) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Backend bundle exceeds the size limit' });
    }
  });

export type CommercialManifest = z.infer<typeof commercialManifestSchema>;

export function verifyCommercialManifest(
  signed: string,
  hostVersion: string,
  publicKey?: string | Buffer
): CommercialManifest {
  if (Buffer.byteLength(signed) > COMMERCIAL_MANIFEST_MAX_BYTES) throw new Error('Commercial manifest is too large');
  const manifest = commercialManifestSchema.parse(verifySignedPayload<unknown>(signed, publicKey));
  if (manifest.hostVersion !== hostVersion) throw new Error('Commercial package does not match the Opfield release');
  return manifest;
}
