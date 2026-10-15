import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { container, TOKENS } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import { dockerComposeProjects, dockerDeployments } from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import { ComposeProjectNameSchema } from '@/modules/docker/compose/compose.schemas.js';
import { DockerComposeService } from '@/modules/docker/compose/compose.service.js';
import type { User } from '@/types.js';
import { DockerManagementService } from './docker.service.js';
import {
  DockerSourceBindingConfigSchema,
  type DockerSourceResourceCreateSchema,
  type DockerSourceTarget,
} from './docker-build.schemas.js';
import { DockerBuildService } from './docker-build.service.js';
import { assertDockerCreationAccess, placeCreatedDockerResource } from './docker-creation-access.js';
import { DockerDeploymentService } from './docker-deployment.service.js';
import { DockerEnvironmentService } from './docker-environment.service.js';
import { DockerSecretService } from './docker-secret.service.js';
import { DockerSourceService } from './docker-source.service.js';

/**
 * Creation of Git-source workloads, shared by the REST routes and the AI/MCP
 * source tool. Callers check the entry scope and the license entitlement.
 */

const PENDING_SOURCE_IMAGE = 'gateway.invalid/pending-source-build:latest';

export const ComposeSourceProjectCreateSchema = z
  .object({
    folderId: z.string().uuid().nullable().optional(),
    projectName: ComposeProjectNameSchema,
    source: DockerSourceBindingConfigSchema,
  })
  .superRefine((value, ctx) => {
    if (!value.source.composeFilePath) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['source', 'composeFilePath'],
        message: 'Compose file path is required',
      });
    }
  });

/**
 * The first build is queued while every Build Worker is paused for new builds: the answer says it waits (it is claimed
 * once a worker is unlocked).
 */
async function firstBuildWaiting(): Promise<{ firstBuildWaiting?: { code: string; message: string } }> {
  const admission = await container
    .resolve(DockerBuildService)
    .admissionStatus()
    .catch(() => null);
  if (admission?.code !== 'BUILD_WORKERS_PAUSED') return {};
  return {
    firstBuildWaiting: {
      code: 'BUILD_WORKERS_PAUSED',
      message:
        'All Build Workers are paused for new builds. The first build is queued and runs once a Build Worker is unlocked.',
    },
  };
}

export function initialDockerSourceBuildError(error: unknown): { code: string; message: string } {
  // Never expose provider errors, credential-bearing URLs, SQL or raw build input.
  const messages: Record<string, string> = {
    BUILD_WORKER_REQUIRED: 'A Build Worker is required. The resource was saved; retry from Source.',
    NO_BUILD_WORKER_AVAILABLE: 'No online Build Worker can run the build. The resource was saved; retry from Source.',
    BUILD_CAPACITY_UNAVAILABLE: 'Build capacity is unavailable. The resource was saved; retry from Source.',
    BUILD_SCHEDULER_UNAVAILABLE: 'The build scheduler is unavailable. The resource was saved; retry from Source.',
    BUILD_ARTIFACT_POLICY_REJECTED: 'The build was rejected by security policy. Review the policy in Source and retry.',
    SOURCE_COMMIT_STALE: 'The source branch changed. The resource was saved; retry from Source.',
    COMPOSE_BUILD_PLAN_MISSING: 'The Compose build plan is unavailable. Review Source configuration and retry.',
  };
  if (error instanceof AppError && Object.hasOwn(messages, error.code)) {
    return { code: error.code, message: messages[error.code]! };
  }
  return {
    code: 'INITIAL_BUILD_ENQUEUE_FAILED',
    message: 'The resource was saved, but its initial build could not be queued. Review Source and retry.',
  };
}

export function assertDockerSourceTargetNode(
  requestedNodeId: string,
  actualNodeId: string | undefined,
  resource: 'compose' | 'deployment'
): void {
  if (actualNodeId === requestedNodeId) return;
  if (resource === 'compose') {
    throw new AppError(404, 'COMPOSE_PROJECT_NOT_FOUND', 'Compose project not found');
  }
  throw new AppError(404, 'NOT_FOUND', 'Deployment not found');
}

/** A deployment or Compose source target must belong to the node named in the request. */
export async function assertDockerSourceTargetOnNode(
  requestedNodeId: string,
  target: { kind: 'deployment'; deploymentId: string } | { kind: 'compose_project'; composeProjectId: string }
): Promise<void> {
  const db = container.resolve(TOKENS.DrizzleClient) as DrizzleClient;
  if (target.kind === 'compose_project') {
    const [project] = await db
      .select({ nodeId: dockerComposeProjects.nodeId })
      .from(dockerComposeProjects)
      .where(eq(dockerComposeProjects.id, target.composeProjectId))
      .limit(1);
    assertDockerSourceTargetNode(requestedNodeId, project?.nodeId, 'compose');
    return;
  }
  const [deployment] = await db
    .select({ nodeId: dockerDeployments.nodeId })
    .from(dockerDeployments)
    .where(eq(dockerDeployments.id, target.deploymentId))
    .limit(1);
  assertDockerSourceTargetNode(requestedNodeId, deployment?.nodeId, 'deployment');
}

/** Create a container or blue/green deployment whose image comes from a Git source build. */
export async function createDockerSourceResource(
  nodeId: string,
  input: z.infer<typeof DockerSourceResourceCreateSchema>,
  actor: User
) {
  const db = container.resolve<DrizzleClient>(TOKENS.DrizzleClient);
  await assertDockerCreationAccess(db, actor.scopes, 'docker:containers:create', nodeId, input.resource.folderId);
  const reservedEnvironment = input.resource.kind === 'container' ? reservedContainerEnvironment(input.resource) : null;
  if (reservedEnvironment && Object.keys(reservedEnvironment.secrets).length > 0) {
    // Secrets saved with the container need the secrets permission where it is created, as they do once it exists.
    await assertDockerCreationAccess(db, actor.scopes, 'docker:containers:secrets', nodeId, input.resource.folderId);
  }
  const sourceService = container.resolve(DockerSourceService);
  const deploymentService = container.resolve(DockerDeploymentService);
  let target: DockerSourceTarget;
  let initialConfig: Record<string, unknown> | null = null;
  let pendingDeploymentId: string | null = null;

  if (input.resource.kind === 'deployment') {
    const deployment = await deploymentService.createPending(
      nodeId,
      { ...input.resource, image: PENDING_SOURCE_IMAGE },
      actor.id,
      actor.scopes
    );
    pendingDeploymentId = deployment.id;
    target = { kind: 'deployment', deploymentId: deployment.id };
  } else {
    // Volumes chosen with the container are kept in its creation settings: its first build creates it with them, so
    // its first start already has its data. They are checked now with the creator's access, and again by that create.
    if (input.resource.volumes?.length) {
      await container
        .resolve(DockerManagementService)
        .assertCreationMounts(nodeId, { volumes: input.resource.volumes }, actor.scopes);
    }
    const containers = await container.resolve(DockerManagementService).listContainers(nodeId);
    const existing = Array.isArray(containers)
      ? containers.some((candidate: any) => {
          const name = String(candidate.name ?? candidate.Name ?? '').replace(/^\//, '');
          return name === input.resource.name;
        })
      : false;
    if (existing) {
      throw new AppError(409, 'CONTAINER_NAME_CONFLICT', 'A container with this name already exists');
    }
    // A deployment's folder placement is keyed by its name too: sharing it would move the deployment's placement.
    const [deployment] = await db
      .select({ id: dockerDeployments.id })
      .from(dockerDeployments)
      .where(and(eq(dockerDeployments.nodeId, nodeId), eq(dockerDeployments.name, input.resource.name)))
      .limit(1);
    if (deployment) {
      throw new AppError(409, 'CONTAINER_NAME_CONFLICT', 'A deployment with this name already exists');
    }
    // The source reserves a free name: links still saved for it belonged to a container that is gone, and its
    // first build would otherwise start with them.
    await container.resolve(DockerManagementService).releaseContainerLinks(nodeId, input.resource.name, actor.id);
    target = { kind: 'container', nodeId, containerName: input.resource.name };
    // Env and secrets are stored by the reserved name below, never in the creation settings.
    const { kind: _kind, env: _env, secrets: _secrets, ...config } = input.resource;
    initialConfig = config;
  }

  let source: Awaited<ReturnType<DockerSourceService['upsert']>>;
  try {
    source = await sourceService.upsert({ ...input.source, target }, actor, {
      allowMissingTarget: input.resource.kind === 'container',
      initialConfig,
      createOnly: true,
    });
    if (input.resource.kind === 'container') {
      await placeCreatedDockerResource(db, nodeId, 'container', input.resource.name, input.resource.folderId);
    }
  } catch (error) {
    if (pendingDeploymentId) {
      await deploymentService.discardPending(nodeId, pendingDeploymentId).catch(() => false);
    }
    throw error;
  }
  if (reservedEnvironment && target.kind === 'container') {
    await storeReservedContainerEnvironment(nodeId, target.containerName, reservedEnvironment, actor.id);
  }
  try {
    const queued = await sourceService.createBuild(target, { force: false, queueWhilePaused: true }, actor);
    return { source, build: queued.build, target, ...(await firstBuildWaiting()) };
  } catch (error) {
    return { source, target, build: null, initialBuildError: initialDockerSourceBuildError(error) };
  }
}

/** The env and secrets of a container created from a Git source; a name is either a variable or a secret. */
function reservedContainerEnvironment(resource: { env?: Record<string, string>; secrets?: Record<string, string> }) {
  const env = resource.env ?? {};
  const secrets = resource.secrets ?? {};
  const both = Object.keys(env).filter((key) => Object.hasOwn(secrets, key));
  if (both.length > 0) {
    throw new AppError(
      400,
      'ENV_SECRET_NAME_CONFLICT',
      `A name cannot be both an environment variable and a secret: ${both.join(', ')}`
    );
  }
  return { env, secrets };
}

/** Saves them for the reserved name; the first build creates and starts the container with them. */
async function storeReservedContainerEnvironment(
  nodeId: string,
  containerName: string,
  values: { env: Record<string, string>; secrets: Record<string, string> },
  userId: string
) {
  if (Object.keys(values.env).length > 0) {
    await container.resolve(DockerEnvironmentService).replace(nodeId, containerName, values.env);
  }
  const secrets = container.resolve(DockerSecretService);
  for (const [key, value] of Object.entries(values.secrets)) {
    await secrets.create(nodeId, containerName, key, value, userId);
  }
}

/** Create a pending Compose Project whose revisions come from a Git source build. */
export async function createComposeProjectFromSource(
  nodeId: string,
  input: z.infer<typeof ComposeSourceProjectCreateSchema>,
  actor: User
) {
  const composeService = container.resolve(DockerComposeService);
  const sourceService = container.resolve(DockerSourceService);
  const project = await composeService.createPendingGitProject(
    nodeId,
    input.projectName,
    actor.id,
    actor.scopes,
    input.folderId
  );
  const target = { kind: 'compose_project' as const, composeProjectId: project.id };
  let source: Awaited<ReturnType<DockerSourceService['upsert']>>;
  try {
    source = await sourceService.upsert({ ...input.source, target }, actor, { createOnly: true });
  } catch (error) {
    await composeService.discardPendingGitProject(project.id).catch(() => false);
    throw error;
  }
  try {
    const queued = await sourceService.createBuild(target, { force: false, queueWhilePaused: true }, actor);
    return { project, source, target, ...queued, ...(await firstBuildWaiting()) };
  } catch (error) {
    return {
      project,
      source,
      target,
      build: null,
      builds: [],
      created: false,
      initialBuildError: initialDockerSourceBuildError(error),
    };
  }
}
