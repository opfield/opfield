import { z } from 'zod';
import { PageTagNameSchema } from '@/modules/pages/tokens/page-deploy-token.schemas.js';
import {
  DOCKER_DEPLOYMENT_ROUTES_MAX,
  DockerDeploymentHealthSchema,
  DockerDeploymentNameSchema,
  DockerDeploymentRouteSchema,
} from './docker-deployment.schemas.js';

const RelativeBuildPathSchema = z
  .string()
  .min(1)
  .max(500)
  .refine((value) => !value.startsWith('/') && !value.split('/').includes('..'), {
    message: 'Build paths must stay inside the repository',
  });

const PagesBuildPathSchema = RelativeBuildPathSchema.refine((value) => /^[A-Za-z0-9._/-]+$/.test(value), {
  message: 'Pages build paths may contain only letters, numbers, dots, underscores, dashes, and slashes',
});

const BuildEnvironmentNameSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
export const PagesBuildPackageManagerSchema = z.enum(['npm', 'pnpm', 'yarn']);
export const PagesBuildNodeVersionSchema = z.enum(['20', '22', '24']);
export const PagesBuildScriptSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .refine(
    (value) => [...value].every((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127),
    'Build script name contains control characters'
  );

export const DockerBuildCommitShaSchema = z.string().regex(/^[0-9a-f]{40,64}$/i, 'Invalid commit SHA');
export const DockerBuildPlatformSchema = z.string().regex(/^linux\/(amd64|arm64)(\/v[1-4])?$/);

export const DockerSourceTargetSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('container'),
    nodeId: z.string().uuid(),
    containerName: z.string().min(1).max(255),
  }),
  z.object({
    kind: z.literal('deployment'),
    deploymentId: z.string().uuid(),
  }),
  z.object({
    kind: z.literal('compose_project'),
    composeProjectId: z.string().uuid(),
  }),
  z.object({
    kind: z.literal('pages_project'),
    pageProjectId: z.string().uuid(),
  }),
]);

export const DockerSourceBindingConfigSchema = z.object({
  connectorId: z.string().uuid(),
  projectId: z.string().uuid({
    message:
      'Expected the repository id (a UUID) from GET /api/docker/sources/connectors/{connectorId}/repositories (manage_docker_source repositories), not the repository owner/name',
  }),
  branch: z.string().trim().min(1).max(500),
  dockerfilePath: RelativeBuildPathSchema.default('Dockerfile'),
  contextPath: RelativeBuildPathSchema.default('.'),
  composeFilePath: RelativeBuildPathSchema.optional(),
  composeVariables: z.record(z.string().max(65_536)).default({}),
  composeSecretKeys: z
    .array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/))
    .max(256)
    .default([]),
  autoBuild: z.boolean().default(true),
  autoDeploy: z.boolean().default(true),
  buildArgs: z.record(z.string().max(16_384)).default({}),
  buildSecretNames: z.array(z.string().min(1).max(255)).max(128).default([]),
  applicationRoot: PagesBuildPathSchema.optional(),
  packageManager: PagesBuildPackageManagerSchema.optional(),
  packageManagerVersion: z.string().trim().min(1).max(64).optional(),
  nodeVersion: PagesBuildNodeVersionSchema.optional(),
  buildScript: PagesBuildScriptSchema.optional(),
  artifactDirectory: PagesBuildPathSchema.optional(),
  publishTag: PageTagNameSchema.optional(),
  policy: z
    .object({
      vulnerabilityThreshold: z.enum(['critical', 'high', 'medium', 'low', 'none', 'disabled']).optional(),
      vulnerabilityScope: z
        .enum(['all', 'application', 'fixable_application', 'fixable_all'])
        .optional()
        .describe(
          'Findings that count against the threshold: all = every package; application = OS packages (deb, rpm, apk, alpm) are report-only; fixable_application = only findings with a released fix, OS packages report-only; fixable_all = only findings with a released fix in any package. Default all.'
        ),
    })
    .passthrough()
    .default({}),
});

export const DockerBuildSecretNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z_][A-Za-z0-9_.-]*$/, 'Invalid Build Secret name');

export const DockerBuildSecretValueSchema = z.object({
  value: z.string().min(1).max(65_536),
});

export const DockerSourceBindingUpsertSchema = DockerSourceBindingConfigSchema.extend({
  target: DockerSourceTargetSchema,
}).superRefine((value, ctx) => {
  if (value.target.kind === 'compose_project' && !value.composeFilePath) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['composeFilePath'],
      message: 'Compose file path is required for a Compose project source',
    });
  }
  if (value.target.kind !== 'compose_project' && value.composeFilePath) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['composeFilePath'],
      message: 'Compose file path is only valid for a Compose project source',
    });
  }
  if (value.target.kind === 'pages_project') {
    for (const [field, present] of [
      ['packageManager', Boolean(value.packageManager)],
      ['nodeVersion', Boolean(value.nodeVersion)],
      ['buildScript', Boolean(value.buildScript)],
      ['artifactDirectory', Boolean(value.artifactDirectory)],
      ['publishTag', Boolean(value.publishTag)],
    ] as const) {
      if (!present) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: `${field} is required for a Pages project source`,
        });
      }
    }
    for (const name of Object.keys(value.buildArgs)) {
      if (!BuildEnvironmentNameSchema.safeParse(name).success) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['buildArgs', name],
          message: 'Pages build variable names must be valid environment variable names',
        });
      }
    }
    for (const name of value.buildSecretNames) {
      if (!BuildEnvironmentNameSchema.safeParse(name).success) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['buildSecretNames'],
          message: 'Pages Build Secret names must be valid environment variable names',
        });
      } else if (name.startsWith('VITE_')) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['buildSecretNames'],
          message: 'VITE_* values are public build variables and cannot be stored as secrets',
        });
      }
    }
  }
});

export const PagesBuildDiscoverySchema = z.object({
  connectorId: z.string().uuid(),
  projectId: z.string().uuid(),
  branch: z.string().trim().min(1).max(500),
  applicationRoot: PagesBuildPathSchema.default('.'),
});

/**
 * A managed volume a Git source container is created with by its first build, as the container create takes it
 * (`volumes`); host paths cannot be mounted.
 */
const DockerSourceContainerVolumeSchema = z
  .object({
    name: z.string().trim().min(1).max(255),
    containerPath: z
      .string()
      .min(1)
      .max(4096)
      .refine((path) => path.startsWith('/'), 'Path must be absolute')
      .refine((path) => !path.split('/').includes('..'), "Path must not contain '..'"),
    readOnly: z.boolean().default(false),
  })
  .strict();

/** The whole volume list of a Git source container its first build has not created yet. */
export const DockerPendingContainerVolumesSchema = z
  .object({ volumes: z.array(DockerSourceContainerVolumeSchema).max(64) })
  .strict();

export const DockerSourceResourceCreateSchema = z.object({
  source: DockerSourceBindingConfigSchema,
  resource: z.discriminatedUnion('kind', [
    z
      .object({
        kind: z.literal('container'),
        folderId: z.string().uuid().nullable().optional(),
        name: z.string().trim().min(1).max(255),
        volumes: z.array(DockerSourceContainerVolumeSchema).max(64).optional(),
        restartPolicy: z.enum(['no', 'always', 'unless-stopped', 'on-failure']).default('no'),
        runtimeProfile: z.enum(['default', 'secure']).default('default'),
        // Saved for the container's reserved name; its first build creates and starts it with them.
        env: z.record(BuildEnvironmentNameSchema, z.string()).optional(),
        secrets: z.record(BuildEnvironmentNameSchema, z.string()).optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal('deployment'),
        folderId: z.string().uuid().nullable().optional(),
        name: DockerDeploymentNameSchema,
        routes: z.array(DockerDeploymentRouteSchema).min(1).max(DOCKER_DEPLOYMENT_ROUTES_MAX),
        health: DockerDeploymentHealthSchema.default({}),
        drainSeconds: z.number().int().min(0).max(3600).default(30),
        routerImage: z.string().min(1).default('nginx:alpine'),
        restartPolicy: z.enum(['no', 'always', 'unless-stopped', 'on-failure']).default('unless-stopped'),
        runtimeProfile: z.enum(['default', 'secure']).default('default'),
      })
      .strict(),
  ]),
});

export const DockerBuildCreateSchema = z.object({
  commitSha: DockerBuildCommitShaSchema.optional(),
  force: z.boolean().default(false),
});

export const DockerBuildListQuerySchema = z.object({
  sourceBindingId: z.string().uuid().optional(),
  builderNodeId: z.string().uuid().optional(),
  status: z
    .enum([
      'queued',
      'claimed',
      'checking_out',
      'building',
      'scanning',
      'pushing',
      'deploying',
      'succeeded',
      'failed',
      'cancelled',
      'superseded',
    ])
    .optional(),
  provider: z.enum(['gitlab', 'github', 'git']).optional(),
  branch: z.string().max(500).optional(),
  search: z.string().max(500).optional(),
  /** Builds of the Git source of this container on `nodeId`, a container its first build has not created included. */
  containerName: z.string().min(1).max(255).optional(),
  nodeId: z.string().uuid().optional(),
  cursor: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const DockerBuildLogQuerySchema = z.object({
  afterSequence: z.coerce.number().int().min(-1).default(-1),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

export const DockerInternalRegistrySettingsSchema = z
  .object({
    externalAccessEnabled: z.boolean(),
    externalHostname: z.string().trim().min(1).max(253).optional(),
    externalNginxNodeId: z.string().uuid().optional(),
    externalCertificateId: z.string().uuid().optional(),
  })
  .superRefine((value, ctx) => {
    if (!value.externalAccessEnabled) return;
    for (const [field, present] of [
      ['externalHostname', Boolean(value.externalHostname)],
      ['externalNginxNodeId', Boolean(value.externalNginxNodeId)],
      ['externalCertificateId', Boolean(value.externalCertificateId)],
    ] as const) {
      if (!present)
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: 'Required for external access' });
    }
  });

export type DockerSourceBindingUpsertInput = z.infer<typeof DockerSourceBindingUpsertSchema>;
export type DockerSourceTarget = z.infer<typeof DockerSourceTargetSchema>;
export type DockerBuildCreateInput = z.infer<typeof DockerBuildCreateSchema>;
export type DockerBuildListQuery = z.infer<typeof DockerBuildListQuerySchema>;
export type DockerInternalRegistrySettingsInput = z.infer<typeof DockerInternalRegistrySettingsSchema>;
export type PagesBuildDiscoveryInput = z.infer<typeof PagesBuildDiscoverySchema>;
