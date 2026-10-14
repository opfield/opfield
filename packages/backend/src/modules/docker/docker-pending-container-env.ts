import { container, TOKENS } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import { inheritedContainerLayer } from '@/modules/apps/app-container-layer.js';
import { AuditService } from '@/modules/audit/audit.service.js';
import { DockerManagementService } from './docker.service.js';
import { envMapToList } from './docker-env-operations.js';
import { DockerEnvironmentService } from './docker-environment.service.js';
import { DockerSecretService } from './docker-secret.service.js';
import { DockerSourceService } from './docker-source.service.js';

/**
 * Env and secrets of a Git source container its first build has not created yet. They are stored under the
 * container's reserved name, as a created container's are, and the first build creates the container with them.
 */

/** The pending Git source container `identifier` names on the node (its reserved name), else null. */
export async function pendingSourceContainer(
  nodeId: string,
  identifier: string
): Promise<{ containerName: string; scopeResourceId: string } | null> {
  if (!identifier || !container.isRegistered(DockerSourceService)) return null;
  const pending = await container.resolve(DockerSourceService).getPendingContainer(nodeId, identifier);
  return pending ? { containerName: pending.containerName, scopeResourceId: pending.scopeResourceId } : null;
}

/** The reserved name when `identifier` names a pending Git source container on the node, else null. */
export async function pendingSourceContainerName(nodeId: string, identifier: string): Promise<string | null> {
  return (await pendingSourceContainer(nodeId, identifier))?.containerName ?? null;
}

/** The stored env (KEY=value, like a container's env) and what the app environment adds to it. */
export async function getPendingContainerEnv(nodeId: string, name: string) {
  const env = await container.resolve(DockerEnvironmentService).getDecryptedMap(nodeId, name);
  const db = container.resolve(TOKENS.DrizzleClient) as DrizzleClient;
  // As for a created container, the app environment part is shown when it can be read.
  const inherited = await inheritedContainerLayer(db, nodeId, name).catch(() => null);
  return { data: envMapToList(env), inherited };
}

/** Saves the env for the first build; secret keys stay secrets. A running first build owns it (409). */
export async function updatePendingContainerEnv(
  nodeId: string,
  name: string,
  env: Record<string, string> | undefined,
  removeEnv: string[] | undefined,
  userId: string
) {
  await container
    .resolve(DockerManagementService)
    .assertBuildRolloutAllowed({ kind: 'container', nodeId, containerName: name });
  const environment = container.resolve(DockerEnvironmentService);
  const secretKeys = await container.resolve(DockerSecretService).getSecretKeys(nodeId, name);
  const next: Record<string, string> = { ...(await environment.getDecryptedMap(nodeId, name)), ...(env ?? {}) };
  for (const key of removeEnv ?? []) delete next[key];
  for (const key of secretKeys) delete next[key];
  await environment.replace(nodeId, name, next);
  await container.resolve(AuditService).log({
    action: 'docker.container.env.update',
    userId,
    resourceType: 'docker-container',
    resourceId: name,
    details: { nodeId, name, containerName: name, pendingSourceBuild: true },
  });
  return { pendingSourceBuild: true as const, name, env: envMapToList(next) };
}
