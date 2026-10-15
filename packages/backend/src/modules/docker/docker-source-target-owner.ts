import { and, eq } from 'drizzle-orm';
import { container, TOKENS } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import { dockerComposeProjects, dockerDeployments } from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import { DockerManagementService } from './docker.service.js';
import { dockerDeploymentIdLabel } from './docker-deployment-labels.js';
import { type DockerLabels, labelString } from './docker-managed-labels.js';

/** The Compose project or blue/green deployment a container belongs to. */
export interface DockerSourceTargetOwner {
  kind: 'compose_project' | 'deployment';
  id: string | null;
  name: string;
}

export interface DockerSourceTargetOwnerDeps {
  inspect(nodeId: string, containerName: string): Promise<{ Config?: { Labels?: DockerLabels | null } } | null>;
  composeProjectId(nodeId: string, name: string): Promise<string | null>;
  deploymentName(id: string): Promise<string | null>;
}

function defaultDeps(): DockerSourceTargetOwnerDeps {
  const db = () => container.resolve<DrizzleClient>(TOKENS.DrizzleClient);
  return {
    inspect: async (nodeId, containerName) =>
      container.resolve(DockerManagementService).inspectContainer(nodeId, containerName),
    composeProjectId: async (nodeId, name) => {
      const [row] = await db()
        .select({ id: dockerComposeProjects.id })
        .from(dockerComposeProjects)
        .where(and(eq(dockerComposeProjects.nodeId, nodeId), eq(dockerComposeProjects.name, name)))
        .limit(1);
      return row?.id ?? null;
    },
    deploymentName: async (id) => {
      const [row] = await db()
        .select({ name: dockerDeployments.name })
        .from(dockerDeployments)
        .where(eq(dockerDeployments.id, id))
        .limit(1);
      return row?.name ?? null;
    },
  };
}

/**
 * The Compose project or blue/green deployment that owns a container, from its labels; null for a standalone container,
 * one that does not exist (a Git source container its first build has not created) or one the node cannot inspect now.
 */
export async function findContainerSourceTargetOwner(
  nodeId: string,
  containerName: string,
  deps: DockerSourceTargetOwnerDeps = defaultDeps()
): Promise<DockerSourceTargetOwner | null> {
  const inspect = await deps.inspect(nodeId, containerName).catch(() => null);
  const labels: Record<string, unknown> = inspect?.Config?.Labels ?? {};
  const deploymentId = dockerDeploymentIdLabel(labels);
  if (deploymentId) {
    return { kind: 'deployment', id: deploymentId, name: (await deps.deploymentName(deploymentId)) ?? deploymentId };
  }
  const project = String(labels['com.docker.compose.project'] ?? '').trim();
  if (!project) return null;
  const id = labelString(labels, 'compose.project-id') || (await deps.composeProjectId(nodeId, project));
  return { kind: 'compose_project', id: id || null, name: project };
}

/** What a container owned by a Compose project or deployment needs instead of its own Git source. */
export function sourceTargetOwnedAdvice(containerName: string, owner: DockerSourceTargetOwner): string {
  if (owner.kind === 'deployment') {
    return `Container "${containerName}" is a slot of the blue/green deployment "${owner.name}", which replaces it on every release. Attach the Git source to that deployment instead (targetType deployment, deploymentId ${owner.id}).`;
  }
  const target = owner.id
    ? `targetType compose, composeProjectId ${owner.id}`
    : 'targetType compose, after adopting it';
  return `Container "${containerName}" is a service container of the Compose project "${owner.name}", which defines and recreates it. Attach the Git source to that Compose Project instead (${target}).`;
}

/**
 * A Git source on a container builds and recreates that container on its own, so a container that a Compose project or
 * a blue/green deployment owns cannot take one: refused with 409 SOURCE_TARGET_OWNED, naming the owner to attach to.
 */
export async function assertContainerSourceTargetNotOwned(
  nodeId: string,
  containerName: string,
  deps?: DockerSourceTargetOwnerDeps
): Promise<void> {
  const owner = await findContainerSourceTargetOwner(nodeId, containerName, deps);
  if (!owner) return;
  throw new AppError(409, 'SOURCE_TARGET_OWNED', sourceTargetOwnedAdvice(containerName, owner), {
    ownerKind: owner.kind,
    ownerId: owner.id,
    ownerName: owner.name,
  });
}
