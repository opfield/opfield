import { AppError } from '@/middleware/error-handler.js';
import { dockerDeploymentIdLabel } from './docker-deployment-labels.js';
import { labelString } from './docker-managed-labels.js';
import type { DockerSecretService } from './docker-secret.service.js';

/** Stored secrets whose values reach a container's environment, and how they show up there. */
export interface DockerSecretEnvOwner {
  nodeId: string | null | undefined;
  containerName: string;
  /**
   * Compose project secrets reach a service's environment through interpolation, under any variable name, so an
   * entry carries one when its value contains the secret's value. Container and deployment secrets keep their key.
   */
  matchValues?: boolean;
}

/**
 * The secret owners a container's environment draws from: the container itself, the deployment it runs a slot of
 * (the deployment's secrets, its database and storage link credentials included), and the Compose project it runs a
 * service of. The labels are reserved for Opfield; one that names another owner only masks more.
 */
export function dockerSecretEnvOwners(nodeId: string, inspect: unknown): DockerSecretEnvOwner[] {
  const record = (inspect ?? {}) as Record<string, any>;
  const name = String(record.Name ?? record.name ?? '').replace(/^\/+/, '');
  const labels = (record.Config?.Labels ?? record.Labels ?? record.labels ?? {}) as Record<string, unknown>;
  const owners: DockerSecretEnvOwner[] = name ? [{ nodeId, containerName: name }] : [];
  const deploymentId = dockerDeploymentIdLabel(labels);
  if (deploymentId) owners.push({ nodeId, containerName: `deployment:${deploymentId}` });
  const composeProjectId = labelString(labels, 'compose.project-id');
  if (composeProjectId) {
    owners.push({ nodeId, containerName: `compose:${composeProjectId}`, matchValues: true });
  }
  return owners;
}

/**
 * A predicate telling whether a `KEY=value` environment entry carries a secret of the owners, or null when they
 * store none.
 */
export async function dockerSecretEnvMatcher(
  secrets: Pick<DockerSecretService, 'getSecretKeys' | 'getDecryptedMap'>,
  owners: ReadonlyArray<DockerSecretEnvOwner>
): Promise<((entry: string) => boolean) | null> {
  const keys = new Set<string>();
  const values = new Set<string>();
  for (const owner of owners) {
    if (!owner.nodeId || !owner.containerName) continue;
    if (owner.matchValues) {
      for (const value of Object.values(await secrets.getDecryptedMap(owner.nodeId, owner.containerName))) {
        if (value) values.add(value);
      }
      continue;
    }
    for (const key of await secrets.getSecretKeys(owner.nodeId, owner.containerName)) keys.add(key);
  }
  if (keys.size === 0 && values.size === 0) return null;
  return (entry) => {
    const eqIndex = entry.indexOf('=');
    if (keys.has(eqIndex === -1 ? entry : entry.slice(0, eqIndex))) return true;
    if (eqIndex === -1) return false;
    const value = entry.slice(eqIndex + 1);
    for (const secret of values) if (value.includes(secret)) return true;
    return false;
  };
}

/** Docker daemons that leave named variables out of a duplicate advertise this capability. */
export const DOCKER_DUPLICATE_ENV_REMOVAL_CAPABILITY = 'docker_duplicate_env_removal_v1';

function hasDuplicateEnvRemovalCapability(capabilities: unknown): boolean {
  if (!capabilities || typeof capabilities !== 'object') return false;
  const list = (capabilities as { capabilities?: unknown }).capabilities;
  return Array.isArray(list) && list.includes(DOCKER_DUPLICATE_ENV_REMOVAL_CAPABILITY);
}

/**
 * A duplicate is not linked: the variables the source's database and storage links inject carry the link's
 * credentials and are left out of the copy. Older daemons copy the whole environment, so duplicating a linked
 * container there is refused.
 */
export function assertDuplicateDropsLinkEnvironment(linkEnvKeys: readonly string[], nodeCapabilities: unknown): void {
  if (linkEnvKeys.length === 0 || hasDuplicateEnvRemovalCapability(nodeCapabilities)) return;
  throw new AppError(
    409,
    'UNSUPPORTED_DAEMON',
    `This container has database or storage links whose variables (${linkEnvKeys.join(', ')}) this Docker daemon ` +
      'would copy into the duplicate. Update the Docker daemon before duplicating it.'
  );
}
