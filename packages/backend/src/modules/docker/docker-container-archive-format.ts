import { z } from 'zod';
import { LEGACY_LABEL_PREFIX } from '@/lib/legacy-compat.js';

const DOCKER_IMAGE_ID = /^sha256:[0-9a-f]{64}$/;
const IMMUTABLE_IMAGE_REFERENCE = /@sha256:[0-9a-f]{64}$/;

const StringMapSchema = z.record(z.string(), z.string());
const OfcaPortSchema = z
  .object({
    containerPort: z.number().int().min(1).max(65535),
    hostPort: z.number().int().min(0).max(65535),
    protocol: z.enum(['tcp', 'udp']),
  })
  .strict();
const OfcaMountSchema = z
  .object({
    type: z.enum(['bind', 'volume']),
    source: z.string().min(1),
    target: z.string().min(1),
    readOnly: z.boolean(),
    driver: z.string().optional(),
    labels: StringMapSchema.optional(),
    createNew: z.boolean().optional(),
    requiresMapping: z.boolean().optional(),
  })
  .strict();
const OfcaNetworkSchema = z
  .object({
    name: z.string().min(1),
    driver: z.string().optional(),
    subnet: z.string().optional(),
    gateway: z.string().optional(),
    createable: z.boolean(),
    createNew: z.boolean().optional(),
    requiresMapping: z.boolean().optional(),
  })
  .strict();

export const OfcaContainerSchema = z
  .object({
    schemaVersion: z.literal(1),
    name: z.string().min(1),
    platform: z.string().optional(),
    imageReference: z.string().optional(),
    entrypoint: z.array(z.string()).optional(),
    command: z.array(z.string()).optional(),
    workingDir: z.string().optional(),
    user: z.string().optional(),
    hostname: z.string().optional(),
    labels: StringMapSchema.optional(),
    environment: StringMapSchema.optional(),
    secrets: StringMapSchema.optional(),
    ports: z.array(OfcaPortSchema).max(256).optional(),
    mounts: z.array(OfcaMountSchema).max(256).optional(),
    networks: z.array(OfcaNetworkSchema).max(64).optional(),
    restartPolicy: z.enum(['', 'no', 'always', 'unless-stopped', 'on-failure']).optional(),
    maxRetries: z.number().int().min(0).optional(),
    stopTimeout: z.number().int().min(0).max(300).nullable().optional(),
    resources: z
      .object({
        memoryLimit: z.number().int().min(0).optional(),
        memorySwap: z.number().int().min(-1).optional(),
        nanoCPUs: z.number().int().min(0).optional(),
        cpuShares: z.number().int().min(0).optional(),
        pidsLimit: z.number().int().min(0).optional(),
      })
      .strict()
      .optional(),
    warnings: z.array(z.string()).max(128).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const envKeys = new Set(Object.keys(value.environment ?? {}));
    for (const key of Object.keys(value.secrets ?? {})) {
      if (envKeys.has(key)) {
        context.addIssue({ code: 'custom', message: `Environment and secrets contain duplicate key ${key}` });
      }
    }
  });

export type OfcaContainerManifest = z.infer<typeof OfcaContainerSchema>;

const RESERVED_LABEL_PREFIXES = [
  'com.docker.compose.',
  'net.opfield.archive.',
  'net.opfield.deployment.',
  'net.opfield.migration.',
  // legacy-name: LEGACY_LABEL_PREFIX* labels — remove once every node reports none
  `${LEGACY_LABEL_PREFIX}archive.`,
  `${LEGACY_LABEL_PREFIX}deployment.`,
  `${LEGACY_LABEL_PREFIX}migration.`,
] as const;

export function stripReservedOfcaLabels(labels: Record<string, string> | undefined): Record<string, string> {
  return Object.fromEntries(
    Object.entries(labels ?? {}).filter(([key]) => !RESERVED_LABEL_PREFIXES.some((prefix) => key.startsWith(prefix)))
  );
}

export const OfcaManifestSchema = z
  .object({
    format: z.literal('ofca'),
    version: z.literal(1),
    createdAt: z.string().datetime(),
    captureMode: z.enum(['image', 'container-commit-no-pause', 'registry-reference']),
    volumes: z.object({ contentsIncluded: z.literal(false) }).strict(),
    container: OfcaContainerSchema,
    image: z
      .object({
        id: z.string().regex(DOCKER_IMAGE_ID),
        tags: z.array(z.string()).max(256),
        embedded: z.boolean().optional(),
        pullReference: z.string().optional(),
      })
      .strict(),
  })
  .strict()
  .superRefine((manifest, context) => {
    const registryBacked = manifest.captureMode === 'registry-reference';
    if ((manifest.image.embedded === false) !== registryBacked) {
      context.addIssue({ code: 'custom', message: 'Archive image mode does not match capture mode' });
    }
    if (registryBacked && !IMMUTABLE_IMAGE_REFERENCE.test(manifest.image.pullReference ?? '')) {
      context.addIssue({ code: 'custom', message: 'Registry-backed archive requires an immutable image digest' });
    }
  });

export type OfcaManifest = z.infer<typeof OfcaManifestSchema>;

export interface OfcaImportResolution {
  networks?: Record<string, string>;
  createNetworks?: string[];
  volumes?: Record<string, string>;
  createVolumes?: string[];
  ports?: Record<string, number>;
}
