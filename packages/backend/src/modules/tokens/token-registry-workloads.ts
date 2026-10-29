import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import { inject, injectable } from 'tsyringe';
import { container, TOKENS } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import {
  dockerAccessResources,
  dockerBuildArtifacts,
  dockerComposeProjects,
  dockerComposeRevisions,
  dockerDeploymentSlots,
  dockerDeployments,
  dockerSourceBindings,
  nodes,
} from '@/db/schema/index.js';
import { LEGACY_REGISTRY_NAMESPACE } from '@/lib/legacy-compat.js';
import { INTERNAL_REGISTRY_PREFIX, parseInternalImageReference } from '@/modules/docker/docker-image-source.js';
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
 * The workloads whose images live in an internal registry repository: from the registry's own naming (a build
 * repository names its Git source, whose target is the workload, and every artifact recorded in the repository names
 * its source or its owner), and every container, deployment and Compose project that runs an image of it, so a
 * repository pushed from outside belongs to the workloads that use it. A repository nothing uses has none: only the
 * broad or the legacy per-repository registry scope reaches it.
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
    targets.push(...(await this.runningTargets(repository)));
    const unique = new Map(targets.map((target) => [targetKey(target), target]));
    const workloads: RegistryRepositoryWorkload[] = [];
    for (const target of unique.values()) {
      const workload = await this.resolveTarget(target);
      if (workload) workloads.push(workload);
    }
    return workloads;
  }

  /**
   * The workloads that run an image of the repository from the internal registry (`127.0.0.1:5443/<repository>`),
   * also one pushed from outside: deployments by their desired config and blue/green slots, Compose projects by their
   * active revision, containers by the nodes' container snapshots.
   */
  private async runningTargets(repository: string): Promise<RegistryWorkloadTarget[]> {
    const runs = (image: unknown) =>
      typeof image === 'string' && parseInternalImageReference(image)?.repository === repository;
    // A prefilter only (`_` is a wildcard in LIKE); every match is parsed again.
    const like = `%${INTERNAL_REGISTRY_PREFIX}${repository}%`;
    const [deployments, slots, projects, dockerNodes] = await Promise.all([
      this.db
        .select({ id: dockerDeployments.id, config: dockerDeployments.desiredConfig })
        .from(dockerDeployments)
        .where(sql`${dockerDeployments.desiredConfig}->>'image' like ${like}`),
      this.db
        .select({
          deploymentId: dockerDeploymentSlots.deploymentId,
          image: dockerDeploymentSlots.image,
          config: dockerDeploymentSlots.desiredConfig,
        })
        .from(dockerDeploymentSlots)
        .where(
          sql`${dockerDeploymentSlots.image} like ${like} or ${dockerDeploymentSlots.desiredConfig}->>'image' like ${like}`
        ),
      this.db
        .select({ id: dockerComposeProjects.id, model: dockerComposeRevisions.normalizedModel })
        .from(dockerComposeProjects)
        .innerJoin(dockerComposeRevisions, eq(dockerComposeRevisions.id, dockerComposeProjects.activeRevisionId))
        .where(sql`${dockerComposeRevisions.normalizedModel}::text like ${like}`),
      this.db.select({ id: nodes.id }).from(nodes).where(eq(nodes.type, 'docker')),
    ]);
    const targets: RegistryWorkloadTarget[] = [];
    for (const deployment of deployments) {
      if (runs(deployment.config?.image)) targets.push({ kind: 'deployment', deploymentId: deployment.id });
    }
    for (const slot of slots) {
      if (runs(slot.image) || runs(slot.config?.image)) {
        targets.push({ kind: 'deployment', deploymentId: slot.deploymentId });
      }
    }
    for (const project of projects) {
      if (Object.values(project.model?.services ?? {}).some((service) => runs(service?.image))) {
        targets.push({ kind: 'compose_project', composeProjectId: project.id });
      }
    }
    const snapshots = (await import('@/modules/docker/docker-snapshot.service.js')).DockerSnapshotService;
    for (const node of dockerNodes) {
      const list = await container.resolve(snapshots).getList<Record<string, unknown>[]>(node.id, 'containers');
      for (const item of Array.isArray(list.data) ? list.data : []) {
        const name = String(item.name ?? item.Name ?? '').replace(/^\/+/, '');
        if (name && runs(item.image ?? item.Image)) {
          targets.push({ kind: 'container', nodeId: node.id, containerName: name });
        }
      }
    }
    return targets;
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
