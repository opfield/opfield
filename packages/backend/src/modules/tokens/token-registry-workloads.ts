import { and, eq, inArray, ne } from 'drizzle-orm';
import { inject, injectable } from 'tsyringe';
import { container, TOKENS } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import {
  dockerAccessResources,
  dockerBuildArtifacts,
  dockerComposeProjects,
  dockerDeployments,
  dockerSourceBindings,
} from '@/db/schema/index.js';
import { LEGACY_REGISTRY_NAMESPACE } from '@/lib/legacy-compat.js';
import type { RegistryRepositoryWorkload, RegistryRepositoryWorkloads } from './token-registry-access.js';

/** A workload a repository's images belong to, before its node and access resource are looked up. */
export type RegistryWorkloadTarget =
  | { kind: 'container'; nodeId: string; containerName: string }
  | { kind: 'deployment'; deploymentId: string }
  | { kind: 'compose_project'; composeProjectId: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The build worker pushes to `<LEGACY_REGISTRY_NAMESPACE>/builds/<source binding>[/<Compose service>]`. */
const BUILD_REPOSITORY = new RegExp(String.raw`^${LEGACY_REGISTRY_NAMESPACE}\/builds\/([^/]+)(?:\/.+)?$`);

/** The source binding a build repository belongs to, or null for any other repository. */
export function buildRepositorySourceBindingId(repository: string): string | null {
  const id = BUILD_REPOSITORY.exec(repository)?.[1];
  return id && UUID.test(id) ? id : null;
}

/**
 * The workload an artifact's owner key names: `container:<node>:<name>` (a container's kept build, an app promotion
 * copy) or `deployment:<id>` (an app promotion copy). Other owners (Availability) are reached through their source
 * binding only.
 */
export function artifactOwnerWorkloadTarget(ownerKey: string | null): RegistryWorkloadTarget | null {
  if (!ownerKey) return null;
  const container = /^container:([^:]+):(.+)$/.exec(ownerKey);
  if (container && UUID.test(container[1]!)) {
    return { kind: 'container', nodeId: container[1]!, containerName: container[2]! };
  }
  const deployment = /^deployment:(.+)$/.exec(ownerKey);
  if (deployment && UUID.test(deployment[1]!)) return { kind: 'deployment', deploymentId: deployment[1]! };
  return null;
}

/** The workload a Git source builds for; a Pages project is no Docker workload. */
export function sourceBindingWorkloadTarget(binding: {
  targetKind: string;
  nodeId: string | null;
  containerName: string | null;
  deploymentId: string | null;
  composeProjectId: string | null;
}): RegistryWorkloadTarget | null {
  if (binding.targetKind === 'container' && binding.nodeId && binding.containerName) {
    return { kind: 'container', nodeId: binding.nodeId, containerName: binding.containerName };
  }
  if (binding.targetKind === 'deployment' && binding.deploymentId) {
    return { kind: 'deployment', deploymentId: binding.deploymentId };
  }
  if (binding.targetKind === 'compose_project' && binding.composeProjectId) {
    return { kind: 'compose_project', composeProjectId: binding.composeProjectId };
  }
  return null;
}

function targetKey(target: RegistryWorkloadTarget): string {
  if (target.kind === 'container') return `container:${target.nodeId}:${target.containerName}`;
  return target.kind === 'deployment' ? `deployment:${target.deploymentId}` : `compose:${target.composeProjectId}`;
}

/**
 * The workloads whose images live in an internal registry repository, read from the registry's own naming: a build
 * repository names its Git source (whose target is the workload), and every artifact recorded in the repository names
 * its source or its owner. A repository Opfield did not create (pushed from outside) has none: only the broad or the
 * legacy per-repository registry scope reaches it.
 */
@injectable()
export class RegistryRepositoryWorkloadService {
  constructor(@inject(TOKENS.DrizzleClient) private readonly db: DrizzleClient) {}

  async workloads(repository: string): Promise<RegistryRepositoryWorkload[]> {
    const artifacts = await this.db
      .selectDistinct({
        sourceBindingId: dockerBuildArtifacts.sourceBindingId,
        ownerKey: dockerBuildArtifacts.ownerKey,
      })
      .from(dockerBuildArtifacts)
      .where(and(eq(dockerBuildArtifacts.registryRepository, repository), ne(dockerBuildArtifacts.status, 'deleted')));
    const targets = artifacts
      .map((artifact) => artifactOwnerWorkloadTarget(artifact.ownerKey))
      .filter((target): target is RegistryWorkloadTarget => target !== null);
    const bindingIds = new Set(
      artifacts.map((artifact) => artifact.sourceBindingId).filter((id): id is string => id !== null)
    );
    const ownBinding = buildRepositorySourceBindingId(repository);
    if (ownBinding) bindingIds.add(ownBinding);
    if (bindingIds.size > 0) {
      const bindings = await this.db
        .select({
          targetKind: dockerSourceBindings.targetKind,
          nodeId: dockerSourceBindings.nodeId,
          containerName: dockerSourceBindings.containerName,
          deploymentId: dockerSourceBindings.deploymentId,
          composeProjectId: dockerSourceBindings.composeProjectId,
        })
        .from(dockerSourceBindings)
        .where(inArray(dockerSourceBindings.id, [...bindingIds]));
      for (const binding of bindings) {
        const target = sourceBindingWorkloadTarget(binding);
        if (target) targets.push(target);
      }
    }
    const unique = new Map(targets.map((target) => [targetKey(target), target]));
    const workloads: RegistryRepositoryWorkload[] = [];
    for (const target of unique.values()) {
      const workload = await this.resolveTarget(target);
      if (workload) workloads.push(workload);
    }
    return workloads;
  }

  /** The node and access resource id the workload's scopes are qualified with; null once the workload is gone. */
  private async resolveTarget(target: RegistryWorkloadTarget): Promise<RegistryRepositoryWorkload | null> {
    if (target.kind === 'container') {
      // A pending Git source container exists only as its name reservation until its first build creates it.
      const [resource] = await this.db
        .select({ id: dockerAccessResources.id })
        .from(dockerAccessResources)
        .where(
          and(
            eq(dockerAccessResources.nodeId, target.nodeId),
            eq(dockerAccessResources.resourceType, 'container'),
            eq(dockerAccessResources.resourceKey, target.containerName)
          )
        )
        .limit(1);
      return { kind: 'containers', nodeId: target.nodeId, resourceId: resource?.id ?? null };
    }
    if (target.kind === 'deployment') {
      const [deployment] = await this.db
        .select({ nodeId: dockerDeployments.nodeId })
        .from(dockerDeployments)
        .where(eq(dockerDeployments.id, target.deploymentId))
        .limit(1);
      return deployment ? { kind: 'containers', nodeId: deployment.nodeId, resourceId: target.deploymentId } : null;
    }
    const [project] = await this.db
      .select({ nodeId: dockerComposeProjects.nodeId })
      .from(dockerComposeProjects)
      .where(eq(dockerComposeProjects.id, target.composeProjectId))
      .limit(1);
    return project ? { kind: 'compose', nodeId: project.nodeId, resourceId: target.composeProjectId } : null;
  }
}

/** RegistryRepositoryWorkloadService.workloads, resolved only when a check needs it. */
export const registryRepositoryWorkloads: RegistryRepositoryWorkloads = (repository) =>
  container.resolve(RegistryRepositoryWorkloadService).workloads(repository);
