import { and, eq, inArray, sql } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import {
  dockerAvailabilityOperations,
  dockerAvailabilityPlacements,
  dockerAvailabilityPolicies,
  dockerBuildArtifacts,
  dockerComposeProjects,
  dockerComposeRevisions,
  dockerDeploymentReleases,
  dockerDeploymentSlots,
  dockerDeployments,
  dockerImageCleanupSettings,
  dockerSourceBindings,
  dockerTasks,
  settings,
} from '@/db/schema/index.js';
import { imageProtectionKeys, imageRetentionDigestKey } from './docker-image-retention.js';

type CleanupRow = typeof dockerImageCleanupSettings.$inferSelect;

export interface ImageRetentionSourceBinding {
  targetKind: string;
  nodeId: string | null;
  containerName: string | null;
  deploymentId: string | null;
}

/** The workload an Availability policy copies: a container on its source node, or a deployment. */
export interface ImageRetentionPolicyOwner {
  nodeId: string | null;
  containerName: string | null;
  deploymentId: string | null;
}

/** What node image retention reads from Opfield's records, the same for every node of one run. */
export interface ImageRetentionContext {
  /** Every image cleanup setting, of every node. */
  settings: CleanupRow[];
  /**
   * Images a node keeps whatever their age: imageProtectionKeys of the images Opfield's records name (deployment
   * configs and slots, rollback releases, Compose revisions, Availability specs, placements and operations, pulls
   * under way) and of the Availability and promotion copies the internal registry holds.
   */
  protectedKeys: ReadonlySet<string>;
  sourceBindings: ReadonlyMap<string, ImageRetentionSourceBinding>;
  availabilityOwners: ReadonlyMap<string, ImageRetentionPolicyOwner>;
}

/** Since when each removable image of a node was found removable (epoch ms), by image ID. */
export type ImageUnusedSince = Record<string, number>;

export interface ImageRetentionStore {
  context(): Promise<ImageRetentionContext>;
  unusedSince(nodeId: string): Promise<ImageUnusedSince>;
  saveUnusedSince(nodeId: string, state: ImageUnusedSince): Promise<void>;
}

const UNUSED_SINCE_KEY_PREFIX = 'docker:image_cleanup:unused_since:';
/** A deployment keeps the images of its newest releases: the running one and the one a rollback goes back to. */
const RELEASES_KEPT_PER_DEPLOYMENT = 2;
/** A Compose project keeps the images of its active revision and the newest ones besides (a rollback, an apply). */
const COMPOSE_REVISIONS_KEPT_PER_PROJECT = 2;
const IMAGE_FIELD = /^(image|imageRef|imageReference|routerImage|sourceImageReference)$/i;

/**
 * The image references in a record: every string under a key named like an image (`image`, `imageRef`,
 * `imageReference`, …) at any depth, so policy specs and requested policies count without knowing their shape.
 */
export function collectImageReferences(value: unknown, into: Set<string> = new Set(), depth = 0): Set<string> {
  if (depth > 12 || value === null || typeof value !== 'object') return into;
  if (Array.isArray(value)) {
    for (const item of value) collectImageReferences(item, into, depth + 1);
    return into;
  }
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item === 'string') {
      if (IMAGE_FIELD.test(key) && item.trim()) into.add(item.trim());
    } else {
      collectImageReferences(item, into, depth + 1);
    }
  }
  return into;
}

function newestPerOwner<T>(rows: T[], owner: (row: T) => string, created: (row: T) => number, keep: number): T[] {
  const byOwner = new Map<string, T[]>();
  for (const row of rows) byOwner.set(owner(row), [...(byOwner.get(owner(row)) ?? []), row]);
  return [...byOwner.values()].flatMap((group) => group.sort((a, b) => created(b) - created(a)).slice(0, keep));
}

export class DrizzleImageRetentionStore implements ImageRetentionStore {
  constructor(private readonly db: DrizzleClient) {}

  async context(): Promise<ImageRetentionContext> {
    const [cleanupSettings, bindings, policies, references, artifacts] = await Promise.all([
      this.db.select().from(dockerImageCleanupSettings),
      this.db
        .select({
          id: dockerSourceBindings.id,
          targetKind: dockerSourceBindings.targetKind,
          nodeId: dockerSourceBindings.nodeId,
          containerName: dockerSourceBindings.containerName,
          deploymentId: dockerSourceBindings.deploymentId,
        })
        .from(dockerSourceBindings),
      this.db
        .select({
          id: dockerAvailabilityPolicies.id,
          nodeId: dockerAvailabilityPolicies.sourceNodeId,
          containerName: dockerAvailabilityPolicies.containerName,
          deploymentId: dockerAvailabilityPolicies.deploymentId,
          spec: dockerAvailabilityPolicies.portableSpec,
          image: dockerAvailabilityPolicies.imageReference,
        })
        .from(dockerAvailabilityPolicies),
      this.recordReferences(),
      this.db
        .select({
          ownerKind: dockerBuildArtifacts.ownerKind,
          repository: dockerBuildArtifacts.registryRepository,
          digest: dockerBuildArtifacts.digest,
        })
        .from(dockerBuildArtifacts)
        .where(
          and(
            inArray(dockerBuildArtifacts.ownerKind, ['availability', 'promotion']),
            eq(dockerBuildArtifacts.status, 'ready')
          )
        ),
    ]);
    for (const policy of policies) collectImageReferences({ spec: policy.spec, image: policy.image }, references);
    const protectedKeys = new Set([...references].flatMap(imageProtectionKeys));
    for (const artifact of artifacts) {
      protectedKeys.add(imageRetentionDigestKey(artifact.repository, artifact.digest));
      // An Availability mirror is also tagged `:image` on the nodes that pulled it.
      if (artifact.ownerKind === 'availability') protectedKeys.add(`${artifact.repository}:image`);
    }
    return {
      settings: cleanupSettings,
      protectedKeys,
      sourceBindings: new Map(bindings.map(({ id, ...binding }) => [id, binding])),
      availabilityOwners: new Map(
        policies.map((policy) => [
          policy.id,
          { nodeId: policy.nodeId, containerName: policy.containerName, deploymentId: policy.deploymentId },
        ])
      ),
    };
  }

  /** The image references Opfield's records name, besides the Availability policies. */
  private async recordReferences(): Promise<Set<string>> {
    const [placements, operations, projects, revisions, deployments, slots, releases, tasks] = await Promise.all([
      this.db
        .select({
          image: dockerAvailabilityPlacements.imageReference,
          runtime: dockerAvailabilityPlacements.runtimeIdentity,
        })
        .from(dockerAvailabilityPlacements)
        .where(sql`${dockerAvailabilityPlacements.actualState} <> 'removed'`),
      this.db
        .select({ requested: dockerAvailabilityOperations.requestedPolicy })
        .from(dockerAvailabilityOperations)
        .where(inArray(dockerAvailabilityOperations.status, ['pending', 'running', 'waiting'])),
      this.db
        .select({ id: dockerComposeProjects.id, activeRevisionId: dockerComposeProjects.activeRevisionId })
        .from(dockerComposeProjects),
      this.db
        .select({
          id: dockerComposeRevisions.id,
          projectId: dockerComposeRevisions.projectId,
          revisionNumber: dockerComposeRevisions.revisionNumber,
        })
        .from(dockerComposeRevisions),
      this.db
        .select({ config: dockerDeployments.desiredConfig, routerImage: dockerDeployments.routerImage })
        .from(dockerDeployments),
      this.db
        .select({ image: dockerDeploymentSlots.image, config: dockerDeploymentSlots.desiredConfig })
        .from(dockerDeploymentSlots),
      this.db
        .select({
          deploymentId: dockerDeploymentReleases.deploymentId,
          image: dockerDeploymentReleases.image,
          createdAt: dockerDeploymentReleases.createdAt,
        })
        .from(dockerDeploymentReleases)
        .where(sql`${dockerDeploymentReleases.image} IS NOT NULL`),
      this.db
        .select({ tracking: dockerTasks.tracking })
        .from(dockerTasks)
        .where(inArray(dockerTasks.status, ['pending', 'running'])),
    ]);
    const references = new Set<string>();
    collectImageReferences({ placements, operations, deployments, slots, tasks }, references);
    const newestReleases = newestPerOwner(
      releases,
      (release) => release.deploymentId,
      (release) => release.createdAt.getTime(),
      RELEASES_KEPT_PER_DEPLOYMENT
    );
    collectImageReferences(newestReleases, references);

    const revisionIds = new Set(
      projects.flatMap((project) => (project.activeRevisionId ? [project.activeRevisionId] : []))
    );
    for (const revision of newestPerOwner(
      revisions,
      (row) => row.projectId,
      (row) => row.revisionNumber,
      COMPOSE_REVISIONS_KEPT_PER_PROJECT
    )) {
      revisionIds.add(revision.id);
    }
    if (revisionIds.size > 0) {
      const models = await this.db
        .select({ model: dockerComposeRevisions.normalizedModel })
        .from(dockerComposeRevisions)
        .where(inArray(dockerComposeRevisions.id, [...revisionIds]));
      collectImageReferences(models, references);
    }
    return references;
  }

  async unusedSince(nodeId: string): Promise<ImageUnusedSince> {
    const [row] = await this.db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, `${UNUSED_SINCE_KEY_PREFIX}${nodeId}`))
      .limit(1);
    const value = row?.value;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).filter(
        (entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1])
      )
    );
  }

  async saveUnusedSince(nodeId: string, state: ImageUnusedSince): Promise<void> {
    const key = `${UNUSED_SINCE_KEY_PREFIX}${nodeId}`;
    if (Object.keys(state).length === 0) {
      await this.db.delete(settings).where(eq(settings.key, key));
      return;
    }
    await this.db
      .insert(settings)
      .values({ key, value: state, updatedAt: new Date() })
      .onConflictDoUpdate({ target: settings.key, set: { value: state, updatedAt: new Date() } });
  }
}
