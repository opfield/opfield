import { container } from '@/container.js';
import { AppError } from '@/middleware/error-handler.js';
import { DockerAvailabilityService } from '../availability/docker-availability.service.js';
import { DockerManagementService } from '../docker.service.js';
import { labelString } from '../docker-managed-labels.js';
import { DockerSnapshotService } from '../docker-snapshot.service.js';
import { DockerComposeService } from './compose.service.js';
import { isComposeOwnedNetwork, isComposeOwnedVolume } from './compose-discovery.service.js';

function labelsFor(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object') return {};
  const record = value as Record<string, unknown>;
  const labels = record.labels ?? record.Labels ?? (record.Config as Record<string, unknown> | undefined)?.Labels;
  if (!labels || typeof labels !== 'object' || Array.isArray(labels)) return {};
  return Object.fromEntries(
    Object.entries(labels).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  );
}

export async function assertComposeChildMutationAllowed(nodeId: string, containerId: string) {
  if (
    container.isRegistered(DockerAvailabilityService) &&
    (await container.resolve(DockerAvailabilityService).isContainerManaged(nodeId, containerId))
  ) {
    return;
  }
  const detail = await container.resolve(DockerManagementService).inspectContainer(nodeId, containerId);
  const labels = labelsFor(detail);
  const projectName = labels['com.docker.compose.project']?.trim();
  if (!projectName) return;

  const persisted = await container.resolve(DockerComposeService).findByName(nodeId, projectName);
  throw new AppError(
    409,
    'COMPOSE_RESOURCE_MANAGED',
    'This container belongs to a Compose project and must be changed through the Compose project',
    {
      nodeId,
      projectId: labelString(labels, 'compose.project-id') || persisted?.id || null,
      projectName,
    }
  );
}

async function assertComposeOwnedResourceMutationAllowed(
  nodeId: string,
  resourceId: string,
  kind: 'volumes' | 'networks'
) {
  const snapshots = container.resolve(DockerSnapshotService);
  const snapshot = await snapshots.getList<Record<string, unknown>[]>(nodeId, kind);
  if (snapshot.revision === 0 || snapshot.refreshStatus === 'error') {
    throw new AppError(
      409,
      'DOCKER_RESOURCE_OWNERSHIP_UNAVAILABLE',
      `Cannot verify ${kind === 'volumes' ? 'volume' : 'network'} ownership while the Docker snapshot is unavailable`
    );
  }
  const resource = Array.isArray(snapshot.data)
    ? snapshot.data.find((item) => {
        const record = item as Record<string, unknown>;
        return String(record.id ?? record.Id ?? record.name ?? record.Name ?? '') === resourceId;
      })
    : undefined;
  if (!resource) {
    throw new AppError(
      409,
      'DOCKER_RESOURCE_OWNERSHIP_UNAVAILABLE',
      `Cannot verify ${kind === 'volumes' ? 'volume' : 'network'} ownership until the Docker snapshot contains the target resource`
    );
  }
  const composeOwned = kind === 'volumes' ? isComposeOwnedVolume(resource) : isComposeOwnedNetwork(resource);
  if (!composeOwned) return;
  const labels = labelsFor(resource);
  throw new AppError(
    409,
    'COMPOSE_RESOURCE_MANAGED',
    `This ${kind === 'volumes' ? 'volume' : 'network'} belongs to a Compose project and must be changed through the Compose project`,
    {
      nodeId,
      projectName: labels['com.docker.compose.project'] ?? null,
      resourceId,
    }
  );
}

export async function assertComposeVolumeMutationAllowed(nodeId: string, volumeName: string) {
  return assertComposeOwnedResourceMutationAllowed(nodeId, volumeName, 'volumes');
}

export async function assertComposeNetworkMutationAllowed(nodeId: string, networkId: string) {
  return assertComposeOwnedResourceMutationAllowed(nodeId, networkId, 'networks');
}
