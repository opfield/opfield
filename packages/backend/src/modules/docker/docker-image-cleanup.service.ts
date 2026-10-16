import { and, eq } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { dockerBuilds, dockerImageCleanupSettings, nodes } from '@/db/schema/index.js';
import { createChildLogger } from '@/lib/logger.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type { DockerManagementService } from './docker.service.js';
import type { ImageCleanupUpsertInput } from './docker-image-cleanup.schemas.js';
import {
  DEFAULT_IMAGE_RETENTION_COUNT,
  groupImagesByRepository,
  type ImageRetentionEntry,
  imageRetentionRepository,
  isBuildImageRepository,
  isSourceBuildRepository,
  selectDanglingImages,
  selectImageRetention,
} from './docker-image-retention.js';

const logger = createChildLogger('DockerImageCleanupService');

type CleanupRow = typeof dockerImageCleanupSettings.$inferSelect;

/** How long the cleanup after an image change waits, so the replaced container is gone from the node's list. */
const CLEANUP_DELAY_MS = 5000;

type CleanupDocker = Pick<DockerManagementService, 'listAllImages' | 'listAllContainers' | 'removeUnusedImage'>;

export interface NodeImageRetentionOptions {
  /** Only these build repositories (all when omitted). */
  repositories?: (repository: string) => boolean;
  /** Also images nothing names and no container uses. */
  dangling?: boolean;
  /** List what would be removed without removing it. */
  dryRun?: boolean;
  /** The user of a manual prune, for the audit log. */
  userId?: string | null;
}

export interface NodeImageRetentionCandidate {
  id: string;
  /** The build repository, or null for a dangling image. */
  repository: string | null;
  size: number;
}

export interface NodeImageRetentionResult {
  removed: string[];
  freedBytes: number;
  candidates: NodeImageRetentionCandidate[];
}

export type DockerImageCleanupSettingsDto =
  | CleanupRow
  | {
      id: null;
      nodeId: string;
      targetType: 'container' | 'deployment';
      containerName: string | null;
      deploymentId: string | null;
      enabled: boolean;
      retentionCount: number;
      createdAt: null;
      updatedAt: null;
    };

export class DockerImageCleanupService {
  private eventBus?: EventBusService;
  private protectedDigests?: () => Promise<ReadonlySet<string>>;
  private readonly nodeRuns = new Map<string, Promise<unknown>>();
  private sourceQueue: Promise<void> = Promise.resolve();

  constructor(
    private db: DrizzleClient,
    private docker: CleanupDocker
  ) {}

  setEventBus(bus: EventBusService) {
    this.eventBus = bus;
  }

  /** The builds the internal registry keeps (`<repository>@<digest>`): a node never removes those. */
  setProtectedDigestsProvider(provider: () => Promise<ReadonlySet<string>>) {
    this.protectedDigests = provider;
  }

  async getForContainer(nodeId: string, containerName: string): Promise<DockerImageCleanupSettingsDto> {
    const [row] = await this.db
      .select()
      .from(dockerImageCleanupSettings)
      .where(
        and(
          eq(dockerImageCleanupSettings.nodeId, nodeId),
          eq(dockerImageCleanupSettings.targetType, 'container'),
          eq(dockerImageCleanupSettings.containerName, containerName)
        )
      )
      .limit(1);
    return (
      row ?? {
        id: null,
        nodeId,
        targetType: 'container',
        containerName,
        deploymentId: null,
        enabled: true,
        retentionCount: 2,
        createdAt: null,
        updatedAt: null,
      }
    );
  }

  async upsertForContainer(
    nodeId: string,
    containerName: string,
    input: ImageCleanupUpsertInput
  ): Promise<DockerImageCleanupSettingsDto> {
    const existing = await this.getPersistedForContainer(nodeId, containerName);
    if (existing) {
      const [updated] = await this.db
        .update(dockerImageCleanupSettings)
        .set({
          enabled: input.enabled ?? existing.enabled,
          retentionCount: input.retentionCount ?? existing.retentionCount,
          updatedAt: new Date(),
        })
        .where(eq(dockerImageCleanupSettings.id, existing.id))
        .returning();
      this.emit('updated', updated);
      return updated;
    }

    const [created] = await this.db
      .insert(dockerImageCleanupSettings)
      .values({
        nodeId,
        targetType: 'container',
        containerName,
        enabled: input.enabled ?? true,
        retentionCount: input.retentionCount ?? 2,
      })
      .returning();
    this.emit('created', created);
    return created;
  }

  async getForDeployment(nodeId: string, deploymentId: string): Promise<DockerImageCleanupSettingsDto> {
    const [row] = await this.db
      .select()
      .from(dockerImageCleanupSettings)
      .where(
        and(
          eq(dockerImageCleanupSettings.nodeId, nodeId),
          eq(dockerImageCleanupSettings.targetType, 'deployment'),
          eq(dockerImageCleanupSettings.deploymentId, deploymentId)
        )
      )
      .limit(1);
    return (
      row ?? {
        id: null,
        nodeId,
        targetType: 'deployment',
        containerName: null,
        deploymentId,
        enabled: true,
        retentionCount: 2,
        createdAt: null,
        updatedAt: null,
      }
    );
  }

  async upsertForDeployment(
    nodeId: string,
    deploymentId: string,
    input: ImageCleanupUpsertInput
  ): Promise<DockerImageCleanupSettingsDto> {
    const existing = await this.getPersistedForDeployment(nodeId, deploymentId);
    if (existing) {
      const [updated] = await this.db
        .update(dockerImageCleanupSettings)
        .set({
          enabled: input.enabled ?? existing.enabled,
          retentionCount: input.retentionCount ?? existing.retentionCount,
          updatedAt: new Date(),
        })
        .where(eq(dockerImageCleanupSettings.id, existing.id))
        .returning();
      this.emit('updated', updated);
      return updated;
    }

    const [created] = await this.db
      .insert(dockerImageCleanupSettings)
      .values({
        nodeId,
        targetType: 'deployment',
        deploymentId,
        enabled: input.enabled ?? true,
        retentionCount: input.retentionCount ?? 2,
      })
      .returning();
    this.emit('created', created);
    return created;
  }

  /**
   * After a container's image changed: the node keeps the image it runs and `retentionCount - 1` to roll back to of
   * that repository (see selectImageRetention). Build images pulled by digest count like tagged ones.
   */
  async scheduleCleanupForContainer(nodeId: string, containerName: string, imageRef: string | undefined) {
    const repository = imageRef ? imageRetentionRepository(imageRef) : null;
    if (!repository) return;
    try {
      const settings = await this.getForContainer(nodeId, containerName);
      if (!settings.enabled) return;
      await delay(CLEANUP_DELAY_MS);
      await this.enforceRepository(nodeId, repository, settings.retentionCount);
    } catch (err) {
      logger.warn('Image cleanup failed; housekeeping applies it again', {
        nodeId,
        containerName,
        repository,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async scheduleCleanupForDeployment(nodeId: string, deploymentId: string, imageRef: string | undefined) {
    const repository = imageRef ? imageRetentionRepository(imageRef) : null;
    if (!repository) return;
    try {
      const settings = await this.getForDeployment(nodeId, deploymentId);
      if (!settings.enabled) return;
      await delay(CLEANUP_DELAY_MS);
      await this.enforceRepository(nodeId, repository, settings.retentionCount);
    } catch (err) {
      logger.warn('Deployment image cleanup failed; housekeeping applies it again', {
        nodeId,
        deploymentId,
        repository,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * A build reached a final state: its source's build images are cleaned on every online Docker node, so Availability
   * replicas and Compose services on other nodes keep only their running and rollback builds too. Runs in the
   * background and never throws.
   */
  buildFinished(buildId: string): void {
    this.enqueueSource({ buildId }, async () => {
      const [build] = await this.db
        .select({ sourceBindingId: dockerBuilds.sourceBindingId })
        .from(dockerBuilds)
        .where(eq(dockerBuilds.id, buildId))
        .limit(1);
      if (build?.sourceBindingId) await this.enforceSource(build.sourceBindingId);
    });
  }

  /** A source's builds were deployed outside a build's own transition (a Compose batch applied or recovered). */
  sourceApplied(sourceBindingId: string): void {
    this.enqueueSource({ sourceBindingId }, () => this.enforceSource(sourceBindingId));
  }

  /**
   * Applies the image cleanup settings to the build images on one node: per build repository, the images containers
   * use, the builds the internal registry keeps for rollback, and the newest others up to the setting of the
   * containers or deployment running that repository (2 when none is saved or none runs it). A repository whose
   * container or deployment has cleanup off is left alone. `dangling` also removes images nothing names or uses.
   * Housekeeping and the manual prune run this; `dryRun` only lists what would go.
   */
  async enforceNode(nodeId: string, options: NodeImageRetentionOptions = {}): Promise<NodeImageRetentionResult> {
    return this.onNode(nodeId, async () => {
      const snapshot = await this.nodeSnapshot(nodeId);
      const groups = groupImagesByRepository(snapshot.images, snapshot.inUseImageIds);
      const buildGroups = [...groups].filter(
        ([repository]) =>
          isBuildImageRepository(repository) && (!options.repositories || options.repositories(repository))
      );
      const candidates: NodeImageRetentionCandidate[] = [];
      if (buildGroups.length > 0) {
        const [settings, protectedKeys] = await Promise.all([this.nodeSettings(nodeId), this.protectedDigestKeys()]);
        for (const [repository, entries] of buildGroups) {
          const retention = repositoryRetention(entries, repository, snapshot.containers, settings);
          if (retention === null) continue;
          for (const entry of selectImageRetention(entries, retention, protectedKeys).removable) {
            candidates.push({ id: entry.id, repository, size: entry.size });
          }
        }
      }
      if (options.dangling) {
        for (const image of selectDanglingImages(snapshot.images, snapshot.inUseImageIds)) {
          candidates.push({ id: image.id, repository: null, size: image.size });
        }
      }
      const unique = [...new Map(candidates.map((candidate) => [candidate.id, candidate])).values()];
      if (options.dryRun) return { removed: [], freedBytes: 0, candidates: unique };
      return { ...(await this.removeImages(nodeId, unique, options.userId ?? null)), candidates: unique };
    });
  }

  /** Online Docker nodes, where build images are cleaned. */
  async onlineDockerNodeIds(): Promise<string[]> {
    const rows = await this.db
      .select({ id: nodes.id })
      .from(nodes)
      .where(and(eq(nodes.type, 'docker'), eq(nodes.status, 'online')));
    return rows.map((row) => row.id);
  }

  private async getPersistedForContainer(nodeId: string, containerName: string): Promise<CleanupRow | null> {
    const [row] = await this.db
      .select()
      .from(dockerImageCleanupSettings)
      .where(
        and(
          eq(dockerImageCleanupSettings.nodeId, nodeId),
          eq(dockerImageCleanupSettings.targetType, 'container'),
          eq(dockerImageCleanupSettings.containerName, containerName)
        )
      )
      .limit(1);
    return row ?? null;
  }

  private async getPersistedForDeployment(nodeId: string, deploymentId: string): Promise<CleanupRow | null> {
    const [row] = await this.db
      .select()
      .from(dockerImageCleanupSettings)
      .where(
        and(
          eq(dockerImageCleanupSettings.nodeId, nodeId),
          eq(dockerImageCleanupSettings.targetType, 'deployment'),
          eq(dockerImageCleanupSettings.deploymentId, deploymentId)
        )
      )
      .limit(1);
    return row ?? null;
  }

  private async enforceSource(sourceBindingId: string): Promise<void> {
    for (const nodeId of await this.onlineDockerNodeIds()) {
      try {
        await this.enforceNode(nodeId, {
          repositories: (repository) => isSourceBuildRepository(repository, sourceBindingId),
        });
      } catch (err) {
        logger.warn('Build image cleanup failed on a node; housekeeping applies it again', {
          nodeId,
          sourceBindingId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  private enqueueSource(context: Record<string, string>, task: () => Promise<void>): void {
    this.sourceQueue = this.sourceQueue.then(task).catch((err) => {
      logger.warn('Build image cleanup failed; housekeeping applies it again', {
        ...context,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  private async enforceRepository(nodeId: string, repository: string, retentionCount: number) {
    return this.onNode(nodeId, async () => {
      const snapshot = await this.nodeSnapshot(nodeId);
      const entries = groupImagesByRepository(snapshot.images, snapshot.inUseImageIds).get(repository) ?? [];
      if (entries.length <= 1) return;
      const protectedKeys = isBuildImageRepository(repository) ? await this.protectedDigestKeys() : new Set<string>();
      const { removable } = selectImageRetention(entries, retentionCount, protectedKeys);
      await this.removeImages(
        nodeId,
        removable.map((entry) => ({ id: entry.id, repository, size: entry.size })),
        null
      );
    });
  }

  /** The node's images and containers. Without the container list nothing is removed. */
  private async nodeSnapshot(nodeId: string) {
    const images = await this.docker.listAllImages(nodeId);
    if (!Array.isArray(images)) throw new Error('The node did not list its images');
    const containers = await this.docker.listAllContainers(nodeId);
    if (!Array.isArray(containers)) throw new Error('The node did not list its containers');
    const inUseImageIds = new Set<string>();
    for (const container of containers as Array<Record<string, any>>) {
      for (const id of [container.ImageID, container.imageId]) {
        if (typeof id === 'string' && id) {
          inUseImageIds.add(id);
          inUseImageIds.add(id.replace(/^sha256:/, ''));
        }
      }
    }
    return {
      images: images as Array<Record<string, any>>,
      containers: containers as Array<Record<string, any>>,
      inUseImageIds,
    };
  }

  private async nodeSettings(nodeId: string): Promise<CleanupRow[]> {
    return this.db.select().from(dockerImageCleanupSettings).where(eq(dockerImageCleanupSettings.nodeId, nodeId));
  }

  private async protectedDigestKeys(): Promise<ReadonlySet<string>> {
    return this.protectedDigests ? this.protectedDigests() : new Set();
  }

  /** Removes the images one by one; Docker refuses one a container uses (no force), which is then skipped. */
  private async removeImages(nodeId: string, candidates: NodeImageRetentionCandidate[], userId: string | null) {
    const removed: string[] = [];
    let freedBytes = 0;
    for (const candidate of candidates) {
      try {
        await this.docker.removeUnusedImage(nodeId, candidate.id, userId);
        removed.push(candidate.id);
        freedBytes += candidate.size;
      } catch (err) {
        logger.debug('Image kept: Docker refused to remove it', {
          nodeId,
          imageId: candidate.id,
          repository: candidate.repository,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (removed.length > 0) {
      logger.info('Removed old images', { nodeId, removed: removed.length, freedBytes });
    }
    return { removed, freedBytes };
  }

  /** One cleanup at a time per node: two runs never pick candidates from the same stale list. */
  private onNode<T>(nodeId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.nodeRuns.get(nodeId) ?? Promise.resolve();
    const run = previous.then(task);
    const tail = run.then(
      () => undefined,
      () => undefined
    );
    this.nodeRuns.set(nodeId, tail);
    void tail.then(() => {
      if (this.nodeRuns.get(nodeId) === tail) this.nodeRuns.delete(nodeId);
    });
    return run;
  }

  private emit(action: 'created' | 'updated', settings: DockerImageCleanupSettingsDto) {
    this.eventBus?.publish('docker.image-cleanup.changed', {
      action,
      id: settings.id,
      nodeId: settings.nodeId,
      targetType: settings.targetType,
      containerName: settings.containerName,
      deploymentId: settings.deploymentId,
      enabled: settings.enabled,
      retentionCount: settings.retentionCount,
      createdAt: settings.createdAt,
      updatedAt: settings.updatedAt,
    });
  }
}

const DEPLOYMENT_ID_LABEL = 'wiolett.gateway.deployment.id';

/**
 * The cleanup setting for a repository on a node: that of the containers (or the deployment of the slot containers)
 * running it, the largest when several do; null when one of them has cleanup off. The default when none runs it.
 */
function repositoryRetention(
  entries: ImageRetentionEntry[],
  repository: string,
  containers: Array<Record<string, any>>,
  settings: CleanupRow[]
): number | null {
  const imageIds = new Set(entries.flatMap((entry) => [entry.id, entry.id.replace(/^sha256:/, '')]));
  let retention: number | null = null;
  for (const container of containers) {
    const imageId = String(container.ImageID ?? container.imageId ?? '');
    const imageRef = String(container.Image ?? container.image ?? '');
    const runsRepository =
      (imageId && (imageIds.has(imageId) || imageIds.has(imageId.replace(/^sha256:/, '')))) ||
      (imageRef && imageRetentionRepository(imageRef) === repository);
    if (!runsRepository) continue;
    const labels = (container.Labels ?? container.labels ?? {}) as Record<string, string>;
    const deploymentId = labels[DEPLOYMENT_ID_LABEL];
    const name = String(container.Names?.[0] ?? container.name ?? container.Name ?? '').replace(/^\/+/, '');
    const setting = deploymentId
      ? settings.find((row) => row.targetType === 'deployment' && row.deploymentId === deploymentId)
      : settings.find((row) => row.targetType === 'container' && row.containerName === name);
    if (setting && !setting.enabled) return null;
    retention = Math.max(retention ?? 0, setting?.retentionCount ?? DEFAULT_IMAGE_RETENTION_COUNT);
  }
  return retention ?? DEFAULT_IMAGE_RETENTION_COUNT;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
