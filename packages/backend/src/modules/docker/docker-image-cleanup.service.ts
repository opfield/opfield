import { and, eq } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { dockerBuilds, dockerImageCleanupSettings, nodes } from '@/db/schema/index.js';
import { createChildLogger } from '@/lib/logger.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type { DockerManagementService } from './docker.service.js';
import { imageReferenceDigest, releaseContainerImage, renameContainerImage } from './docker-container-kept-image.js';
import type { ImageCleanupUpsertInput } from './docker-image-cleanup.schemas.js';
import {
  DEFAULT_IMAGE_RETENTION_COUNT,
  groupImagesByRepository,
  type ImageRetentionEntry,
  imageRetentionRepository,
  isBuildImageRepository,
  isSourceBuildRepository,
  isToolImageRepository,
  selectDanglingImages,
  selectImageRetention,
} from './docker-image-retention.js';
import {
  DrizzleImageRetentionStore,
  type ImageRetentionContext,
  type ImageRetentionStore,
  type ImageUnusedSince,
} from './docker-image-retention-store.js';
import { opfieldInternalImageKind } from './docker-internal-images.js';
import { labelString } from './docker-managed-labels.js';

const logger = createChildLogger('DockerImageCleanupService');

type CleanupRow = typeof dockerImageCleanupSettings.$inferSelect;

/** How long the cleanup after an image change waits, so the replaced container is gone from the node's list. */
const CLEANUP_DELAY_MS = 5000;
/**
 * An older image of a repository a container or deployment on the node runs (its rollback images beyond the setting)
 * is removed once cleanups this far apart both found it removable: a rollout that pulled it again a moment ago and is
 * about to create its container keeps it. Cleanups after a change check again once this passed.
 */
export const REPLACED_IMAGE_GRACE_MS = 2 * 60_000;
/**
 * Any other unused image (of a removed container, an earlier Compose tag, a superseded engine or tool, a deleted
 * source's builds, a dangling layer) is removed only once it has been unused this long, as Opfield saw it: housekeeping
 * removes it at its next run after that.
 */
export const UNUSED_IMAGE_MIN_AGE_MS = 12 * 60 * 60_000;
/** How long one read of Opfield's records serves the cleanups of several nodes. */
const CONTEXT_TTL_MS = 15_000;
/** Cleanups after node events: at most one per node in this interval. */
const NODE_EVENT_CLEANUP_INTERVAL_MS = 2 * 60_000;

type CleanupDocker = Pick<DockerManagementService, 'listAllImages' | 'listNodeContainers' | 'removeUnusedImage'>;

export interface NodeImageRetentionOptions {
  /** Only these repositories (all when omitted). */
  repositories?: (repository: string) => boolean;
  /** Also images nothing names and no container uses (default true; never with `repositories`). */
  dangling?: boolean;
  /** List what would be removed without removing it. */
  dryRun?: boolean;
  /** The user of a manual prune, for the audit log. */
  userId?: string | null;
}

export interface NodeImageRetentionCandidate {
  id: string;
  /** The repository, or null for a dangling image. */
  repository: string | null;
  size: number;
  /** How long the image must have been found removable before it goes (see REPLACED_IMAGE_GRACE_MS). */
  minUnusedMs: number;
  /** When a cleanup may remove it: the first cleanup that found it removable plus `minUnusedMs` (ISO time). */
  removableAt?: string;
}

export interface NodeImageRetentionResult {
  removed: string[];
  freedBytes: number;
  /** The images removed now, or with dryRun those a run now would remove. */
  candidates: NodeImageRetentionCandidate[];
  /** Removable images still within their wait (removed by a later cleanup). */
  waiting: NodeImageRetentionCandidate[];
}

interface RepositoryPlan {
  retentionCount: number;
  minUnusedMs: number;
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
  private unsubscribeEvents: Array<() => void> = [];
  private protectedDigests?: () => Promise<ReadonlySet<string>>;
  private readonly nodeRuns = new Map<string, Promise<unknown>>();
  private sourceQueue: Promise<void> = Promise.resolve();
  private readonly store: ImageRetentionStore;
  private contextCache: { at: number; value: Promise<ImageRetentionContext> } | null = null;
  /** The last tracking state of a node whose save failed: used until a save succeeds. */
  private readonly unsavedUnusedSince = new Map<string, ImageUnusedSince>();
  /** Pending follow-up cleanups per node, with the repositories they cover (null: all). */
  private readonly followUps = new Map<
    string,
    { timer: ReturnType<typeof setTimeout>; filters: Array<(repository: string) => boolean> | null }
  >();
  private readonly nodeEventCleanups = new Map<string, { timer: ReturnType<typeof setTimeout> | null; at: number }>();

  constructor(
    private db: DrizzleClient,
    private docker: CleanupDocker,
    store?: ImageRetentionStore,
    private readonly now: () => number = () => Date.now()
  ) {
    this.store = store ?? new DrizzleImageRetentionStore(db);
  }

  /**
   * Subscribes to the changes that leave images behind on a node (a container removed or given another image, a
   * Compose project applied or deleted, a deployment changed or deleted, a migration moved a workload): the node is
   * cleaned shortly after, at most once per NODE_EVENT_CLEANUP_INTERVAL_MS.
   */
  setEventBus(bus: EventBusService) {
    for (const unsubscribe of this.unsubscribeEvents) unsubscribe();
    this.eventBus = bus;
    const onNode = (payload: unknown, keys: string[]) => {
      if (!payload || typeof payload !== 'object') return;
      for (const key of keys) {
        const nodeId = (payload as Record<string, unknown>)[key];
        if (typeof nodeId === 'string' && nodeId) this.scheduleNodeCleanup(nodeId);
      }
    };
    this.unsubscribeEvents = [
      bus.subscribe('docker.container.changed', (payload) => {
        const action = (payload as { action?: unknown } | null)?.action;
        if (action === 'removed' || action === 'recreated' || action === 'updated' || action === 'deployment') {
          onNode(payload, ['nodeId']);
        }
      }),
      bus.subscribe('docker.compose.changed', (payload) => onNode(payload, ['nodeId'])),
      bus.subscribe('docker.deployment.changed', (payload) => {
        if ((payload as { action?: unknown } | null)?.action !== 'transitioning') onNode(payload, ['nodeId']);
      }),
      bus.subscribe('docker.migration.changed', (payload) => onNode(payload, ['sourceNodeId', 'targetNodeId'])),
    ];
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
   * After a container's image changed: the node is cleaned with every owner's setting (see enforceNode), so the
   * container keeps the image it runs and `retentionCount - 1` to roll back to of its repository, and its earlier
   * repository is cleaned too when it changed. Build images pulled by digest count like tagged ones. Nothing happens
   * when the container's cleanup is off.
   */
  async scheduleCleanupForContainer(nodeId: string, containerName: string, imageRef: string | undefined) {
    // A build kept for the container after its source was detached is released once it runs another image.
    if (imageRef) {
      await releaseContainerImage(this.db, { nodeId, containerName }, imageReferenceDigest(imageRef)).catch((err) =>
        logger.debug('The kept image of a container could not be released', {
          nodeId,
          containerName,
          error: err instanceof Error ? err.message : String(err),
        })
      );
    }
    const repository = imageRef ? imageRetentionRepository(imageRef) : null;
    if (!repository) return;
    try {
      const settings = await this.getForContainer(nodeId, containerName);
      if (!settings.enabled) return;
      await delay(CLEANUP_DELAY_MS);
      await this.enforceNode(nodeId);
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
      await this.enforceNode(nodeId);
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
   * A change on the node left images behind (see setEventBus): the node is cleaned a moment later, at most once per
   * NODE_EVENT_CLEANUP_INTERVAL_MS. Runs in the background and never throws.
   */
  scheduleNodeCleanup(nodeId: string): void {
    const state = this.nodeEventCleanups.get(nodeId);
    if (state?.timer) return;
    const wait = Math.max(CLEANUP_DELAY_MS, (state?.at ?? 0) + NODE_EVENT_CLEANUP_INTERVAL_MS - this.now());
    const timer = setTimeout(() => {
      this.nodeEventCleanups.set(nodeId, { timer: null, at: this.now() });
      void this.enforceNode(nodeId).catch((err) => {
        logger.debug('Image cleanup after a node change failed; housekeeping applies it again', {
          nodeId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, wait);
    timer.unref?.();
    this.nodeEventCleanups.set(nodeId, { timer, at: state?.at ?? 0 });
  }

  /**
   * A container was removed: a later container with its name does not inherit its image cleanup setting, and the
   * build kept for it after its source was detached is released.
   */
  async forgetContainer(nodeId: string, containerName: string): Promise<void> {
    await releaseContainerImage(this.db, { nodeId, containerName });
    await this.db
      .delete(dockerImageCleanupSettings)
      .where(
        and(
          eq(dockerImageCleanupSettings.nodeId, nodeId),
          eq(dockerImageCleanupSettings.targetType, 'container'),
          eq(dockerImageCleanupSettings.containerName, containerName)
        )
      );
  }

  /** A container was renamed: its image cleanup setting and its kept build go with it. */
  async renameContainer(nodeId: string, oldName: string, newName: string): Promise<void> {
    await renameContainerImage(this.db, nodeId, oldName, newName);
    await this.db
      .update(dockerImageCleanupSettings)
      .set({ containerName: newName, updatedAt: new Date() })
      .where(
        and(
          eq(dockerImageCleanupSettings.nodeId, nodeId),
          eq(dockerImageCleanupSettings.targetType, 'container'),
          eq(dockerImageCleanupSettings.containerName, oldName)
        )
      );
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
   * Applies the image cleanup rules to one node. Per repository:
   * - one a container or deployment on the node runs (a build repository, or any other): the images containers use,
   *   and the newest others up to the setting of the containers or deployment running it (2 when none is saved; the
   *   largest when several run it; a deployment's or Availability copy's setting is its workload's, on any node).
   *   A repository whose owner has cleanup off is left alone. The rest goes after REPLACED_IMAGE_GRACE_MS;
   * - a build repository nothing on the node runs: its source's setting, or nothing kept when the source is gone;
   * - Opfield's tool images: the newest one;
   * - any other: nothing kept.
   * Images a container uses, the builds the internal registry keeps and images Opfield's records name always stay
   * (see ImageRetentionContext). Everything except a running owner's older images waits UNUSED_IMAGE_MIN_AGE_MS,
   * counted from the first cleanup that found it removable. Opfield's connector images have their own rule
   * (housekeeping). `dangling` (default) also removes images nothing names and no container uses.
   * Housekeeping, the manual prune and the cleanups after changes run this; `dryRun` only lists what would go.
   */
  async enforceNode(nodeId: string, options: NodeImageRetentionOptions = {}): Promise<NodeImageRetentionResult> {
    return this.onNode(nodeId, async () => {
      const snapshot = await this.nodeSnapshot(nodeId);
      const context = await this.retentionContext();
      const imagesById = new Map(snapshot.images.map((image) => [String(image.Id ?? image.id ?? ''), image]));
      const groups = groupImagesByRepository(snapshot.images, snapshot.inUseImageIds);
      const kept = new Set<string>();
      const evaluated = new Set<string>();
      const proposals = new Map<string, NodeImageRetentionCandidate>();
      for (const [repository, entries] of groups) {
        const keepAll = () => {
          for (const entry of entries) kept.add(entry.id);
        };
        if (options.repositories && !options.repositories(repository)) {
          keepAll();
          continue;
        }
        for (const entry of entries) evaluated.add(entry.id);
        if (entries.some((entry) => isConnectorImage(imagesById.get(entry.id)))) {
          keepAll();
          continue;
        }
        const plan = repositoryPlan(nodeId, repository, entries, snapshot.containers, context);
        if (!plan) {
          keepAll();
          continue;
        }
        const selection = selectImageRetention(entries, plan.retentionCount, context.protectedKeys);
        for (const entry of selection.kept) kept.add(entry.id);
        for (const entry of selection.removable) {
          const previous = proposals.get(entry.id);
          proposals.set(entry.id, {
            id: entry.id,
            repository,
            size: entry.size,
            minUnusedMs: Math.max(previous?.minUnusedMs ?? 0, plan.minUnusedMs),
          });
        }
      }
      if (options.dangling !== false && !options.repositories) {
        for (const image of selectDanglingImages(snapshot.images, snapshot.inUseImageIds)) {
          evaluated.add(image.id);
          proposals.set(image.id, {
            id: image.id,
            repository: null,
            size: image.size,
            minUnusedMs: UNUSED_IMAGE_MIN_AGE_MS,
          });
        }
      }
      const removable = [...proposals.values()].filter((candidate) => !kept.has(candidate.id));
      const since = await this.trackUnused(nodeId, removable, evaluated, imagesById);
      const now = this.now();
      for (const candidate of removable) {
        candidate.removableAt = new Date(since[candidate.id]! + candidate.minUnusedMs).toISOString();
      }
      const ready = removable.filter((candidate) => now - since[candidate.id]! >= candidate.minUnusedMs);
      const waiting = removable.filter((candidate) => now - since[candidate.id]! < candidate.minUnusedMs);
      if (options.dryRun) return { removed: [], freedBytes: 0, candidates: ready, waiting };
      this.followUpReplaced(nodeId, waiting, since, options.repositories);
      return { ...(await this.removeImages(nodeId, ready, options.userId ?? null)), candidates: ready, waiting };
    });
  }

  /** Online Docker nodes, where images are cleaned (database and storage nodes clean their own). */
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

  /** Opfield's records for this cleanup, read at most once per CONTEXT_TTL_MS for the nodes of one run. */
  private async retentionContext(): Promise<ImageRetentionContext> {
    const now = this.now();
    if (!this.contextCache || now - this.contextCache.at > CONTEXT_TTL_MS) {
      const value = (async () => {
        const [context, registry] = await Promise.all([this.store.context(), this.protectedDigestKeys()]);
        return { ...context, protectedKeys: new Set([...context.protectedKeys, ...registry]) };
      })();
      this.contextCache = { at: now, value };
      value.catch(() => {
        if (this.contextCache?.value === value) this.contextCache = null;
      });
    }
    return this.contextCache.value;
  }

  /**
   * Since when each removable image was found removable: kept for those still removable, started now for new ones,
   * dropped for images used again, kept or gone. Images this run did not look at keep their entry. A failed save is
   * retried at the next cleanup; until then the unsaved state is used.
   */
  private async trackUnused(
    nodeId: string,
    removable: NodeImageRetentionCandidate[],
    evaluated: ReadonlySet<string>,
    imagesById: ReadonlyMap<string, unknown>
  ): Promise<ImageUnusedSince> {
    const previous = this.unsavedUnusedSince.get(nodeId) ?? (await this.store.unusedSince(nodeId));
    const now = this.now();
    const next: ImageUnusedSince = {};
    for (const [id, since] of Object.entries(previous)) {
      if (!evaluated.has(id) && imagesById.has(id)) next[id] = since;
    }
    for (const candidate of removable) next[candidate.id] = previous[candidate.id] ?? now;
    const changed =
      Object.keys(next).length !== Object.keys(previous).length ||
      Object.entries(next).some(([id, since]) => previous[id] !== since);
    if (changed || this.unsavedUnusedSince.has(nodeId)) {
      try {
        await this.store.saveUnusedSince(nodeId, next);
        this.unsavedUnusedSince.delete(nodeId);
      } catch (err) {
        this.unsavedUnusedSince.set(nodeId, next);
        logger.debug('Image cleanup tracking could not be saved; it is kept in memory', {
          nodeId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return next;
  }

  /**
   * Older images of a running owner still within their grace: one more cleanup of the node, of the same
   * repositories, once it passed.
   */
  private followUpReplaced(
    nodeId: string,
    waiting: NodeImageRetentionCandidate[],
    since: ImageUnusedSince,
    repositories: ((repository: string) => boolean) | undefined
  ): void {
    const due = waiting
      .filter((candidate) => candidate.minUnusedMs <= REPLACED_IMAGE_GRACE_MS)
      .map((candidate) => since[candidate.id]! + candidate.minUnusedMs);
    if (due.length === 0) return;
    const pending = this.followUps.get(nodeId);
    if (pending) {
      pending.filters = pending.filters && repositories ? [...pending.filters, repositories] : null;
      return;
    }
    const followUp = {
      filters: repositories ? [repositories] : null,
      timer: setTimeout(
        () => {
          this.followUps.delete(nodeId);
          const filters = followUp.filters;
          void this.enforceNode(
            nodeId,
            filters ? { repositories: (repository) => filters.some((filter) => filter(repository)) } : {}
          ).catch((err) => {
            logger.debug('Image cleanup follow-up failed; housekeeping applies it again', {
              nodeId,
              error: err instanceof Error ? err.message : String(err),
            });
          });
        },
        Math.max(1000, Math.max(...due) - this.now() + 1000)
      ),
    };
    followUp.timer.unref?.();
    this.followUps.set(nodeId, followUp);
  }

  /**
   * The node's images and containers. Without the container list nothing is removed. The containers are Docker's own
   * list: a deployment's slot containers carry the deployment label its image cleanup setting is found by (the
   * user-facing list shows a deployment as one row without labels, which fell back to the default of 2).
   */
  private async nodeSnapshot(nodeId: string) {
    const images = await this.docker.listAllImages(nodeId);
    if (!Array.isArray(images)) throw new Error('The node did not list its images');
    const containers = await this.docker.listNodeContainers(nodeId);
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

/** Opfield's connector images: housekeeping keeps the current and one more of each (selectObsoleteOpfieldConnectorImages). */
function isConnectorImage(image: unknown): boolean {
  if (!image || typeof image !== 'object') return false;
  const kind = opfieldInternalImageKind(image as Record<string, unknown>);
  return kind === 'secure-link-connector' || kind === 'database-connector';
}

function containerName(container: Record<string, any>): string {
  return String(container.Names?.[0] ?? container.name ?? container.Name ?? '').replace(/^\/+/, '');
}

function deploymentSetting(context: ImageRetentionContext, deploymentId: string): CleanupRow | undefined {
  return context.settings.find((row) => row.targetType === 'deployment' && row.deploymentId === deploymentId);
}

function containerSetting(context: ImageRetentionContext, nodeId: string, name: string): CleanupRow | undefined {
  return context.settings.find(
    (row) => row.targetType === 'container' && row.nodeId === nodeId && row.containerName === name
  );
}

/**
 * The setting of the workload a container on the node belongs to: its deployment's (both label namespaces), the
 * workload an Availability copy belongs to (the source container on its own node, or the deployment), else the
 * container's own on this node.
 */
function ownerSetting(
  nodeId: string,
  container: Record<string, any>,
  context: ImageRetentionContext
): CleanupRow | undefined {
  const labels = (container.Labels ?? container.labels ?? {}) as Record<string, unknown>;
  // A deployment row of the user-facing list names its deployment without labels.
  const deploymentId =
    labelString(labels, 'deployment.id') ||
    (container.kind === 'deployment' && typeof container.deploymentId === 'string' ? container.deploymentId : '');
  if (deploymentId) return deploymentSetting(context, deploymentId);
  const policyId = labelString(labels, 'availability.policy');
  const owner = policyId ? context.availabilityOwners.get(policyId) : undefined;
  if (owner?.deploymentId) return deploymentSetting(context, owner.deploymentId);
  if (owner?.nodeId && owner.containerName) {
    return (
      containerSetting(context, owner.nodeId, owner.containerName) ??
      containerSetting(context, nodeId, containerName(container))
    );
  }
  return containerSetting(context, nodeId, containerName(container));
}

/** The setting of a Git source's target workload, wherever its build images are. */
function sourceSetting(sourceBindingId: string, context: ImageRetentionContext): CleanupRow | undefined | null {
  const binding = context.sourceBindings.get(sourceBindingId);
  if (!binding) return null;
  if (binding.targetKind === 'deployment' && binding.deploymentId)
    return deploymentSetting(context, binding.deploymentId);
  if (binding.targetKind === 'container' && binding.nodeId && binding.containerName) {
    return containerSetting(context, binding.nodeId, binding.containerName);
  }
  return undefined;
}

/** How a repository on the node is cleaned (see enforceNode); null leaves it alone. */
function repositoryPlan(
  nodeId: string,
  repository: string,
  entries: ImageRetentionEntry[],
  containers: Array<Record<string, any>>,
  context: ImageRetentionContext
): RepositoryPlan | null {
  const imageIds = new Set(entries.flatMap((entry) => [entry.id, entry.id.replace(/^sha256:/, '')]));
  let retention: number | null = null;
  for (const container of containers) {
    const imageId = String(container.ImageID ?? container.imageId ?? '');
    const imageRef = String(container.Image ?? container.image ?? '');
    const runsRepository =
      (imageId && (imageIds.has(imageId) || imageIds.has(imageId.replace(/^sha256:/, '')))) ||
      (imageRef && imageRetentionRepository(imageRef) === repository);
    if (!runsRepository) continue;
    const setting = ownerSetting(nodeId, container, context);
    if (setting && !setting.enabled) return null;
    retention = Math.max(retention ?? 0, setting?.retentionCount ?? DEFAULT_IMAGE_RETENTION_COUNT);
  }
  if (retention !== null) return { retentionCount: retention, minUnusedMs: REPLACED_IMAGE_GRACE_MS };
  if (isBuildImageRepository(repository)) {
    const sourceBindingId = repository.split('/')[2] ?? '';
    const setting = sourceSetting(sourceBindingId, context);
    // The source is gone (its container, deployment or Pages project was deleted, or it was detached): no workload
    // can deploy these builds any more.
    if (setting === null) return { retentionCount: 1, minUnusedMs: UNUSED_IMAGE_MIN_AGE_MS };
    if (setting && !setting.enabled) return null;
    return {
      retentionCount: setting?.retentionCount ?? DEFAULT_IMAGE_RETENTION_COUNT,
      minUnusedMs: REPLACED_IMAGE_GRACE_MS,
    };
  }
  if (isToolImageRepository(repository)) return { retentionCount: 2, minUnusedMs: UNUSED_IMAGE_MIN_AGE_MS };
  return { retentionCount: 1, minUnusedMs: UNUSED_IMAGE_MIN_AGE_MS };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
