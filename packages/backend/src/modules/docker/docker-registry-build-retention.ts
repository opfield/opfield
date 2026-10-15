import { createChildLogger } from '@/lib/logger.js';
import type {
  DockerRegistryMaintenanceExecutor,
  DockerRegistryMaintenanceStore,
  RegistryState,
} from './docker-registry-maintenance.js';
import { REGISTRY_BUILDS_KEPT_PER_CONTAINER, selectRegistryRetentionCandidates } from './docker-registry-retention.js';

const logger = createChildLogger('DockerRegistryBuildRetention');

/**
 * Builds finish in series (the services of one Compose project, a push to several apps): one garbage collection runs
 * this long after the last of them deleted a build, not one per build.
 */
export const BUILD_RETENTION_GC_DELAY_MS = 2 * 60_000;
/** Registry states in which it answers manifest deletions and may be garbage-collected. */
const SERVING_STATUSES = new Set(['ready', 'degraded', 'read_only']);

export interface DockerRegistryBuildRetentionHost {
  store: DockerRegistryMaintenanceStore;
  executor(): DockerRegistryMaintenanceExecutor;
  getState(): Promise<RegistryState>;
  /** Whether a maintenance run of this process is in flight. */
  maintenanceRunning(): boolean;
  collectGarbage(reason: string): Promise<unknown>;
}

/**
 * Keeps the registry at the builds kept per container as builds finish: the finished build's source loses every
 * other build at once (its manifests are deleted while the registry runs), and a coalesced garbage collection frees
 * their layers once no build or Availability change uses the registry. Housekeeping applies the same rule as a
 * safety net.
 */
export class DockerRegistryBuildRetention {
  private queue: Promise<void> = Promise.resolve();
  private collectionTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly host: DockerRegistryBuildRetentionHost,
    private readonly collectionDelayMs = BUILD_RETENTION_GC_DELAY_MS
  ) {}

  /** A build reached a final state. Never holds the build result up and never throws. */
  buildFinished(buildId: string): void {
    this.queue = this.queue
      .then(() => this.prune(buildId))
      .then(() => undefined)
      .catch((error) => {
        logger.warn('Builds beyond those kept per container stay until the next build or housekeeping', {
          buildId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }

  /** Deletes the finished build's source builds beyond those kept per container; returns how many went. */
  async prune(buildId: string): Promise<number> {
    const { store } = this.host;
    const scope = await store.buildRetentionScope?.(buildId);
    // Another build of this source still runs: it prunes when it finishes, with its own artifact recorded.
    if (!scope || scope.busy) return 0;
    // A collection in progress applies the same rule itself; a registry that is down answers no deletion.
    if (!this.serving(await this.host.getState())) return 0;
    const { candidates } = selectRegistryRetentionCandidates(await store.listRetentionArtifacts(new Date()));
    const removable = candidates.filter((artifact) => artifact.sourceBindingId === scope.sourceBindingId);
    for (const artifact of removable) {
      await this.host.executor().deleteManifest(artifact.repository, artifact.digest);
      await store.markArtifactDeleted(artifact.id, new Date());
    }
    if (removable.length > 0) {
      logger.info('Deleted builds beyond those kept per container', {
        sourceBindingId: scope.sourceBindingId,
        kept: REGISTRY_BUILDS_KEPT_PER_CONTAINER,
        deleted: removable.length,
      });
      this.scheduleCollection();
    }
    return removable.length;
  }

  private scheduleCollection(): void {
    if (this.collectionTimer) return;
    const timer = setTimeout(() => {
      this.collectionTimer = null;
      void this.collect().catch((error) => {
        logger.warn('Garbage collection after finished builds failed; housekeeping runs it again', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, this.collectionDelayMs);
    timer.unref?.();
    this.collectionTimer = timer;
  }

  /** Collects the deleted builds' layers, or waits again while the registry is in use or not serving. */
  async collect(): Promise<void> {
    const { store } = this.host;
    const state = await this.host.getState();
    // A collection stops the registry: a build pushing or a node pulling meanwhile would fail.
    if (!this.serving(state) || (await store.hasActiveRegistryUsers?.())) {
      this.scheduleCollection();
      return;
    }
    if (store.hasUncollectedDeletions && !(await store.hasUncollectedDeletions(state.lastGcAt))) return;
    await this.host.collectGarbage('builds finished: freeing the layers of builds beyond those kept per container');
  }

  private serving(state: RegistryState): boolean {
    return (
      !this.host.maintenanceRunning() &&
      SERVING_STATUSES.has(state.status) &&
      (state.maintenancePhase === 'idle' || state.maintenancePhase === 'failed')
    );
  }
}
