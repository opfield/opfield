import { mkdir, readdir, rename, unlink } from 'node:fs/promises';
import { injectable } from 'tsyringe';
import type { Env } from '@/config/env.js';
import type { InferenceCoreStateRow } from '@/db/schema/inference-core.js';
import { createChildLogger } from '@/lib/logger.js';
import type { TrustedOpenCodexImageArtifact } from '@/lib/update-artifact-trust.js';
import { AppError } from '@/middleware/error-handler.js';
import type { DockerCreateContainerConfig, DockerService } from '@/services/docker.service.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import { imageRepositoryFromRef } from '@/services/update.service.js';
import type { InferenceCredentialVault } from '../inference-credential-vault.js';
import { InferenceCoreClient } from './inference-core.client.js';
import {
  assertInferenceCoreTransition,
  INFERENCE_CORE_PROTOCOL_MAJOR,
  INFERENCE_CORE_STATE_SCHEMA_VERSION,
  type InferenceCoreOperation,
  type InferenceCoreOperationProgress,
  type InferenceCoreState,
  type InferenceCoreStatus,
  OPFIELD_CORE_CONTRACT_ID,
} from './inference-core.contract.js';
import {
  checkOpenCodexOpfieldCompatibility,
  compareOpenCodexVersions,
  fetchLatestOpenCodexTag,
  fetchOpenCodexImageManifest,
} from './inference-core.manifest.js';
import {
  CORE_USAGE_LOG_KEEP_BYTES,
  CORE_USAGE_LOG_MAX_BYTES,
  trimFileScript,
  UNROTATED_CORE_LOG_KEEP_BYTES,
  UNROTATED_CORE_LOG_MAX_BYTES,
} from './inference-core-disk-bound.js';
import { type CoreLayout, inferenceCoreLayout } from './inference-core-layout.js';
import {
  INFERENCE_CORE_CHANGED_CHANNEL,
  type InferenceCoreOperationService,
} from './inference-core-operation.service.js';
import type { InferenceCoreLatestInfo, InferenceCoreStore } from './inference-core-store.js';
import { LEGACY_CORE_ENV_PREFIX, LEGACY_CORE_INTERNAL_URL_KEY, LEGACY_CORE_LABEL_PREFIX, LEGACY_CORE_SECRETS_DIR } from '@/lib/legacy-compat.js';

const logger = createChildLogger('InferenceCoreRuntimeService');

const CORE_CONTAINER_ALIAS = 'inference-core';
const CORE_PORT = 10100;
const CORE_UID = '10001:10001';
const CORE_MEMORY_BYTES = 2 * 1024 * 1024 * 1024;
const CORE_PIDS_LIMIT = 1024;
const CORE_READY_TIMEOUT_MS = 120_000;
const CORE_STABILITY_WINDOW_MS = 20_000;
const CORE_DRAIN_TIMEOUT_MS = 8_000;
const CORE_BACKUP_MAX_BYTES = 2 * 1024 * 1024 * 1024;
const CORE_BACKUP_TIMEOUT_MS = 15_000;
/**
 * The core image's entrypoint always runs `ocx start` and treats a command as its arguments:
 * it prints usage and exits 0, so a probe reads no number and a cleanup silently does nothing.
 * Maintenance one-shots built from that image must replace the entrypoint.
 */
const CORE_IMAGE_SHELL: Pick<DockerCreateContainerConfig, 'Entrypoint'> = { Entrypoint: ['/bin/sh', '-c'] };
const CORE_BACKUP_KEEP = 3;
const HEALTH_PROBE_INTERVAL_MS = 60_000;
/** The core's container log rotates like the Opfield stack's services. */
const CORE_LOG_CONFIG = { Type: 'json-file', Config: { 'max-size': '50m', 'max-file': '3' } };
/** How often the core's disk use is bounded (usage ledger, a container log created before rotation). */
const CORE_DISK_BOUND_INTERVAL_MS = 60 * 60_000;

const LABEL_OWNED = `${LEGACY_CORE_LABEL_PREFIX}owned`;
const LABEL_PROJECT = `${LEGACY_CORE_LABEL_PREFIX}project`;
const LABEL_DIGEST = `${LEGACY_CORE_LABEL_PREFIX}digest`;
const LABEL_VERSION = `${LEGACY_CORE_LABEL_PREFIX}version`;
const LABEL_ROLE = `${LEGACY_CORE_LABEL_PREFIX}role`;
const ROLE_RUNTIME = 'runtime';
const ROLE_HELPER = 'helper';

const BACKUP_DIR = '/var/lib/opfield/inference-core-backups';

/** Stage labels rendered by the UI; keep in sync with ui-contract.md. */
const STAGE = {
  resolving: 'Resolving release',
  pulling: 'Downloading image',
  preparingStorage: 'Preparing storage',
  installing: 'Installing',
  starting: 'Starting',
  checkingReadiness: 'Checking readiness',
  updating: 'Updating',
  rollingBack: 'Rolling back',
} as const;

/** Sealed runtime credential blob; never leaves Opfield unencrypted. */
export interface InferenceCoreCredentials {
  dataCredential: string;
  managementCredential: string;
  callbackCredential: string;
}

/** Operation timings; overridable in tests so failure paths do not take minutes. */
export interface InferenceCoreTimings {
  readyTimeoutMs: number;
  readyPollMs: number;
  drainTimeoutMs: number;
  drainPollMs: number;
  stabilityWindowMs: number;
}

const DEFAULT_TIMINGS: InferenceCoreTimings = {
  readyTimeoutMs: CORE_READY_TIMEOUT_MS,
  readyPollMs: 2_000,
  drainTimeoutMs: CORE_DRAIN_TIMEOUT_MS,
  drainPollMs: 1_000,
  stabilityWindowMs: CORE_STABILITY_WINDOW_MS,
};

/** Test/lab seams for host-side paths and timings. */
export interface InferenceCoreRuntimeOptions {
  timings?: Partial<InferenceCoreTimings>;
  backupDir?: string;
}

function newCoreCredential(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return `ocx_${hex}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeReleaseVersion(version: string): string {
  return version.replace(/^v(?=\d)/, '');
}

/** Errors surfaced to the browser are redacted and bounded. */
export function redactedCoreError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/ocx_[0-9a-f]+/g, '[redacted]').slice(0, 500);
}

/**
 * Owns the managed OpenCodex core lifecycle on the local Docker host: install,
 * update with rollback, repair, health reconciliation. Every transition is
 * persisted before the Docker mutation it describes, and every persisted
 * change publishes one status DTO on `inference.core.changed`.
 *
 * Ownership discipline: the service only ever touches containers/volumes
 * carrying its exact ownership labels for the current Compose project. Foreign
 * resources that collide with the expected names fail the operation; they are
 * never adopted or deleted.
 */
@injectable()
export class InferenceCoreRuntimeService {
  private healthProbeTimer: NodeJS.Timeout | null = null;
  /** When boundCoreDiskUse last ran (ms); the first health probe after a start runs it. */
  private diskBoundAt = 0;
  private observedRequestLimits: { digest: string; supported: boolean } | null = null;

  constructor(
    private readonly store: InferenceCoreStore,
    private readonly docker: DockerService,
    private readonly env: Env,
    private readonly vault: InferenceCredentialVault,
    private readonly operations: InferenceCoreOperationService,
    private readonly eventBus: EventBusService,
    options: InferenceCoreRuntimeOptions = {}
  ) {
    this.timings = { ...DEFAULT_TIMINGS, ...options.timings };
    this.backupDir = options.backupDir ?? BACKUP_DIR;
  }

  private readonly timings: InferenceCoreTimings;
  private readonly backupDir: string;

  // ---------------------------------------------------------------- status

  async getStatus(): Promise<InferenceCoreStatus> {
    const row = await this.loadStateRow();
    const operation = await this.operations.current();
    const latest = await this.loadLatestInfo();
    return {
      state: row?.state ?? 'not_installed',
      installed: row?.installedDigest
        ? {
            version: row.installedVersion ?? 'unknown',
            digest: row.installedDigest,
            imageRef: row.installedImageRef ?? '',
          }
        : null,
      latest: latest
        ? {
            version: latest.version,
            digest: latest.digest,
            sizeBytes: latest.sizeBytes,
            releaseNotesUrl: latest.releaseNotesUrl,
          }
        : null,
      compatibility: this.compatibilityOf(row),
      health: {
        status: row?.healthStatus ?? 'unknown',
        version: row?.installedVersion ?? null,
        coreProtocolMajor: row?.coreProtocolMajor ?? null,
        stateSchemaVersion: row?.coreStateSchemaVersion ?? null,
        checkedAt: row?.healthCheckedAt?.toISOString() ?? null,
        requestLimitsCapability:
          this.observedRequestLimits && this.observedRequestLimits.digest === row?.installedDigest
            ? this.observedRequestLimits.supported
              ? 'negotiated-v1'
              : 'legacy'
            : 'unknown',
      },
      operation: operation ? this.toOperationDto(operation) : null,
      lastError: row?.lastError ?? null,
    };
  }

  /** Explicit "check for updates" action; persists the discovery result. */
  async checkForUpdates(): Promise<InferenceCoreLatestInfo | null> {
    const tag = await fetchLatestOpenCodexTag(this.env.RELEASES_API_URL);
    if (!tag) {
      await this.storeLatestInfo(null);
      return null;
    }
    const artifact = await fetchOpenCodexImageManifest(
      this.env.ARTIFACT_BASE_URL,
      tag,
      await this.trustedDistributionImages()
    );
    const info: InferenceCoreLatestInfo = {
      version: artifact.version,
      digest: artifact.digest,
      sizeBytes: artifact.sizeBytes,
      releaseNotesUrl: artifact.releaseNotesUrl ?? null,
      checkedAt: new Date().toISOString(),
    };
    await this.storeLatestInfo(info);

    const row = await this.loadStateRow();
    if (
      row?.state === 'ready' &&
      row.installedVersion &&
      compareOpenCodexVersions(tag, `v${row.installedVersion}`) > 0
    ) {
      await this.transition(row, 'update_available', null);
      await this.publishNow();
    }
    return info;
  }

  // ------------------------------------------------------------- operations

  /** Install the core. Idempotent: an already-ready core is a no-op. */
  async install(targetVersion?: string): Promise<InferenceCoreOperation> {
    const row = await this.loadStateRow();
    const state = row?.state ?? 'not_installed';
    if (state === 'ready') {
      const current = await this.operations.current();
      if (current) return this.toOperationDto(current);
      throw new AppError(409, 'CORE_ALREADY_READY', 'The inference core is already installed and ready');
    }
    assertInferenceCoreTransition(state, 'resolving');
    const operation = await this.operations.begin('install', {
      phase: 'resolving',
      ...(targetVersion ? { toVersion: targetVersion.replace(/^v/, '') } : {}),
    });
    void this.runGuarded(operation.id, async () => {
      const existing = await this.loadStateRow();
      if (existing) await this.transition(existing, 'resolving', null);
      else await this.upsertStateRow({ state: 'resolving' });
      await this.publishNow();

      const artifact = await this.resolveArtifact(targetVersion, operation.id);
      await this.transitionState('resolving', 'pulling');
      await this.pullImage(operation.id, artifact);
      await this.transitionState('pulling', 'installing');
      await this.operations.updatePhase(operation.id, 'installing', { stage: STAGE.preparingStorage });
      await this.installFreshContainer(artifact);
      await this.transitionState('installing', 'starting');
      await this.operations.updatePhase(operation.id, 'starting', { stage: STAGE.checkingReadiness });
      await this.startAndAwaitReady(artifact);
      const currentRow = await this.requireStateRow();
      await this.transition(currentRow, 'ready', null);
      await this.operations.succeed(operation.id);
      await this.publishNow();
    });
    return this.toOperationDto(operation);
  }

  /** Update to a newer release with pull-first, drain, backup, replace, rollback. */
  async update(targetVersion: string): Promise<InferenceCoreOperation> {
    const row = await this.loadStateRow();
    if (!row?.installedDigest || !row.installedImageRef) {
      throw new AppError(409, 'CORE_NOT_INSTALLED', 'The inference core is not installed');
    }
    assertInferenceCoreTransition(row.state, 'updating');
    const operation = await this.operations.begin('update', {
      phase: 'resolving',
      fromVersion: row.installedVersion,
      fromDigest: row.installedDigest,
      toVersion: targetVersion.replace(/^v/, ''),
    });
    void this.runGuarded(operation.id, async () => {
      const current = await this.requireStateRow();
      const artifact = await this.resolveArtifact(targetVersion, operation.id);
      await this.updateCoreContainer(operation.id, current, artifact);
      await this.operations.succeed(operation.id);
      await this.publishNow();
    });
    return this.toOperationDto(operation);
  }

  /** Repair a degraded/failed core: restart or recreate at the recorded digest. */
  async repair(): Promise<InferenceCoreOperation> {
    const row = await this.loadStateRow();
    if (!row?.installedDigest || !row.installedImageRef) {
      throw new AppError(409, 'CORE_NOT_INSTALLED', 'The inference core is not installed');
    }
    if (row.state !== 'degraded' && row.state !== 'failed') {
      throw new AppError(409, 'CORE_NOT_REPAIRABLE', `The inference core does not need repair (state: ${row.state})`);
    }
    const operation = await this.operations.begin('repair', {
      phase: 'starting',
      fromVersion: row.installedVersion,
      fromDigest: row.installedDigest,
    });
    void this.runGuarded(operation.id, async () => {
      const current = await this.requireStateRow();
      await this.transition(current, 'starting', null);
      await this.publishNow();
      await this.repairContainer(current);
      const after = await this.requireStateRow();
      await this.transition(after, 'ready', null);
      await this.operations.succeed(operation.id);
      await this.publishNow();
    });
    return this.toOperationDto(operation);
  }

  // --------------------------------------------------------- reconciliation

  /**
   * Startup reconciliation: fail interrupted operations, then align the
   * persisted state with observed Docker reality. Only exact ownership labels
   * are ever considered ours.
   */
  async reconcileOnStartup(): Promise<void> {
    await this.operations.failInterrupted();
    const row = await this.loadStateRow();
    if (!row?.containerName) return;

    let layout: CoreLayout;
    try {
      layout = await this.discoverLayout();
    } catch (error) {
      logger.warn('Core reconciliation skipped: no compose layout', { error: redactedCoreError(error) });
      return;
    }

    let owned: Awaited<ReturnType<DockerService['listContainersByLabel']>>;
    try {
      owned = await this.docker.listContainersByLabel(`${LABEL_OWNED}=true`);
    } catch (error) {
      logger.warn('Core reconciliation skipped: docker unreachable', { error: redactedCoreError(error) });
      return;
    }
    const matching = owned.filter(
      (c) => c.Labels?.[LABEL_PROJECT] === layout.project && c.Names.includes(`/${layout.containerName}`)
    );

    for (const helper of owned.filter(
      (c) =>
        c.Labels?.[LABEL_PROJECT] === layout.project &&
        (c.Labels?.[LABEL_ROLE] === ROLE_HELPER ||
          (c.State !== 'running' && c.Names.includes(`/${layout.containerName}-candidate`)))
    )) {
      logger.warn('Removing abandoned inference core helper container', { id: helper.Id.slice(0, 12) });
      if (helper.State === 'running') await this.docker.stopContainer(helper.Id).catch(() => {});
      await this.docker.removeContainer(helper.Id, { removeAnonymousVolumes: true }).catch((error) => {
        logger.warn('Inference core helper cleanup failed', {
          id: helper.Id.slice(0, 12),
          error: redactedCoreError(error),
        });
      });
    }

    // Never run two cores on one state volume: keep the recorded container,
    // remove owned duplicates that do not match it.
    for (const duplicate of matching) {
      if (matching.length > 1 && duplicate.Id !== row.containerId) {
        logger.warn('Removing duplicate owned core container', { id: duplicate.Id.slice(0, 12) });
        await this.docker.stopContainer(duplicate.Id).catch(() => {});
        await this.docker.removeContainer(duplicate.Id).catch(() => {});
      }
    }

    const container = matching.find((c) => c.Id === row.containerId) ?? matching[0];
    if (!container) {
      // A foreign container occupying our name is never adopted or deleted.
      const foreign = await this.findContainerByName(layout.containerName);
      if (foreign) {
        await this.transition(
          row,
          'failed',
          'A foreign container occupies the inference core name; remove it manually and retry'
        );
      } else {
        await this.transition(row, 'degraded', 'The inference core container is missing');
      }
      await this.publishNow();
      return;
    }

    const digest = container.Labels?.[LABEL_DIGEST];
    if (digest && row.installedDigest && digest !== row.installedDigest) {
      // Unexpectedly replaced/upgraded container (e.g. an interrupted update).
      await this.transition(
        row,
        'degraded',
        'The inference core container does not match the recorded version; run repair'
      );
      await this.publishNow();
      return;
    }

    if (container.State !== 'running') {
      await this.docker.startContainer(container.Id).catch((error) => {
        logger.warn('Core container restart during reconciliation failed', { error: redactedCoreError(error) });
      });
    }

    // An Opfield process can die after draining the old core but before replacing
    // it (for example while backing up its state volume). When the recorded
    // digest still matches, the old core is authoritative and safe to resume.
    if (row.state === 'updating' && row.installedVersion) {
      try {
        const credentials = this.openCredentials(row);
        const client = new InferenceCoreClient(this.coreBaseUrl(), credentials.managementCredential);
        await client.resume();
        await this.awaitReadyIdentity(layout, row.installedVersion);
        const current = await this.requireStateRow();
        await this.transition(current, 'ready', null);
        await this.publishNow();
      } catch (error) {
        logger.warn('Interrupted core update could not resume the previous container', {
          error: redactedCoreError(error),
        });
      }
    }
    await this.probeHealth(layout);
    const reconciled = await this.loadStateRow();
    if (reconciled?.state === 'ready' && reconciled.installedImageRef) {
      await this.pruneOldCoreImages(reconciled.installedImageRef);
    }
  }

  /** Periodic health probe between steady states; started from bootstrap. */
  startHealthProbe(): void {
    if (this.healthProbeTimer) return;
    this.healthProbeTimer = setInterval(() => {
      void this.probeHealthSafely();
    }, HEALTH_PROBE_INTERVAL_MS);
    this.healthProbeTimer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.healthProbeTimer) {
      clearInterval(this.healthProbeTimer);
      this.healthProbeTimer = null;
    }
  }

  // ------------------------------------------------------------ engine core

  /** Shared failure path for background operations: persist, mark, publish. */
  private async runGuarded(operationId: string, work: () => Promise<void>): Promise<void> {
    try {
      await work();
    } catch (error) {
      const message = redactedCoreError(error);
      logger.error('Core operation failed', { operationId, error: message });
      await this.operations.fail(operationId, message).catch(() => {});
      const row = await this.loadStateRow();
      // Only transient states are force-moved; a steady state (e.g. ready after
      // a completed rollback) is owned by the path that established it.
      const TRANSIENT: readonly InferenceCoreState[] = [
        'resolving',
        'pulling',
        'installing',
        'starting',
        'updating',
        'rolling_back',
      ];
      if (row && TRANSIENT.includes(row.state)) {
        // Rollback paths already moved the machine; plain failures land on
        // failed for a first install and degraded for an existing install.
        const fallback: InferenceCoreState = row.installedDigest ? 'degraded' : 'failed';
        await this.transition(row, fallback, message).catch(() => {});
      }
      await this.publishNow().catch(() => {});
    }
  }

  private async resolveArtifact(
    targetVersion: string | undefined,
    operationId: string
  ): Promise<TrustedOpenCodexImageArtifact> {
    await this.operations.heartbeat(operationId);
    const tag = targetVersion ?? (await fetchLatestOpenCodexTag(this.env.RELEASES_API_URL));
    if (!tag) throw new AppError(502, 'CORE_RELEASE_UNAVAILABLE', 'No published core release found');
    const artifact = await fetchOpenCodexImageManifest(
      this.env.ARTIFACT_BASE_URL,
      tag.startsWith('v') ? tag : `v${tag}`,
      await this.trustedDistributionImages()
    );
    const compatibility = checkOpenCodexOpfieldCompatibility(artifact, this.env.APP_VERSION);
    if (!compatibility.compatible) {
      throw new AppError(409, 'OPFIELD_UPDATE_REQUIRED', compatibility.reason ?? 'Opfield version is incompatible');
    }
    await this.upsertStateRow({ targetVersion: artifact.version, targetDigest: artifact.digest });
    return artifact;
  }

  private async pullImage(operationId: string, artifact: TrustedOpenCodexImageArtifact): Promise<void> {
    await this.operations.updatePhase(operationId, 'pulling', { stage: STAGE.pulling });
    if (await this.docker.imageExists(artifact.imageRef)) {
      await this.operations.updatePhase(operationId, 'pulling', { stage: STAGE.pulling });
      return;
    }
    await this.docker.pullImageRefStreaming(artifact.imageRef, (progress) => {
      const update: InferenceCoreOperationProgress = { stage: STAGE.pulling };
      if (progress.downloadedBytes !== undefined) update.downloadedBytes = progress.downloadedBytes;
      if (progress.totalBytes !== undefined) update.totalBytes = progress.totalBytes;
      if (progress.layersCompleted !== undefined) update.layersCompleted = progress.layersCompleted;
      if (progress.layersTotal !== undefined) update.layersTotal = progress.layersTotal;
      void this.operations.updatePhase(operationId, 'pulling', update).catch(() => {});
    });
  }

  /** Fresh install: credentials, volumes, container. */
  private async installFreshContainer(artifact: TrustedOpenCodexImageArtifact): Promise<void> {
    const layout = await this.discoverLayout();
    const credentials: InferenceCoreCredentials = {
      dataCredential: newCoreCredential(),
      managementCredential: newCoreCredential(),
      callbackCredential: newCoreCredential(),
    };
    await this.createOwnedVolumes(layout);
    await this.writeCredentialsFile(layout, credentials, artifact.imageRef);
    const sealed = this.vault.seal(credentials);
    await this.upsertStateRow({
      credentialsPayload: sealed.encryptedPayload,
      credentialsDek: sealed.encryptedDek,
      credentialKeyVersion: sealed.keyVersion,
      stateVolumeName: layout.stateVolume,
      secretVolumeName: layout.secretVolume,
      networkName: layout.network,
    });
    await this.createCoreContainer(layout, artifact, credentials);
  }

  private async createCoreContainer(
    layout: CoreLayout,
    artifact: TrustedOpenCodexImageArtifact,
    _credentials: InferenceCoreCredentials,
    recordState = true
  ): Promise<string> {
    await this.assertNoForeignContainer(layout.containerName);
    const id = await this.docker.createContainer(
      {
        Image: artifact.imageRef,
        User: CORE_UID,
        Env: [
          `${LEGACY_CORE_ENV_PREFIX}MODE=1`,
          `${LEGACY_CORE_ENV_PREFIX}CREDENTIALS_FILE=${LEGACY_CORE_SECRETS_DIR}/credentials.json`,
          'OPENCODEX_HOME=/var/lib/opencodex',
          'CODEX_HOME=/var/lib/opencodex',
          `OPENCODEX_PORT=${CORE_PORT}`,
          'OPENCODEX_HEADLESS=1',
        ],
        Labels: {
          [LABEL_OWNED]: 'true',
          [LABEL_PROJECT]: layout.project,
          [LABEL_DIGEST]: artifact.digest,
          [LABEL_VERSION]: artifact.version,
          [LABEL_ROLE]: ROLE_RUNTIME,
        },
        NetworkingConfig: {
          EndpointsConfig: { [layout.network]: { Aliases: [CORE_CONTAINER_ALIAS] } },
        },
        HostConfig: {
          Binds: [`${layout.stateVolume}:/var/lib/opencodex`, `${layout.secretVolume}:${LEGACY_CORE_SECRETS_DIR}:ro`],
          ReadonlyRootfs: true,
          CapDrop: ['ALL'],
          SecurityOpt: ['no-new-privileges'],
          PidsLimit: CORE_PIDS_LIMIT,
          Memory: CORE_MEMORY_BYTES,
          MemorySwap: CORE_MEMORY_BYTES,
          Tmpfs: { '/tmp': 'rw,noexec,nosuid,size=64m' },
          RestartPolicy: { Name: 'unless-stopped' },
          LogConfig: CORE_LOG_CONFIG,
        },
      },
      layout.containerName
    );
    if (recordState)
      await this.upsertStateRow({
        containerId: id,
        containerName: layout.containerName,
        stateVolumeName: layout.stateVolume,
        secretVolumeName: layout.secretVolume,
        networkName: layout.network,
      });
    return id;
  }

  /** Start the container and accept readiness only with a matching identity. */
  private async startAndAwaitReady(artifact: TrustedOpenCodexImageArtifact): Promise<void> {
    const row = await this.requireStateRow();
    if (!row.containerId) throw new Error('core container was not created');
    await this.docker.startContainer(row.containerId);
    const layout = await this.discoverLayout();
    const requestLimitsSupported = await this.awaitReadyIdentity(layout, artifact.version);
    await this.upsertStateRow({
      installedVersion: artifact.version,
      installedDigest: artifact.digest,
      installedImageRef: artifact.imageRef,
      targetVersion: null,
      targetDigest: null,
      coreProtocolMajor: INFERENCE_CORE_PROTOCOL_MAJOR,
      coreStateSchemaVersion: INFERENCE_CORE_STATE_SCHEMA_VERSION,
      healthStatus: 'healthy',
      healthCheckedAt: new Date(),
      lastReadyAt: new Date(),
      lastError: null,
    });
    this.observedRequestLimits = { digest: artifact.digest, supported: requestLimitsSupported };
  }

  /** Poll readiness until the identity matches the contract and the version. */
  private async awaitReadyIdentity(layout: CoreLayout, expectedVersion: string): Promise<boolean> {
    const row = await this.requireStateRow();
    const credentials = this.openCredentials(row);
    const client = new InferenceCoreClient(this.coreBaseUrl(), credentials.managementCredential);
    void layout;
    const deadline = Date.now() + this.timings.readyTimeoutMs;
    for (;;) {
      const probe = await client.ready();
      if (probe.status === 'failed') {
        throw new Error('core reported failed readiness');
      }
      if (probe.ready && probe.identity) {
        const identity = probe.identity;
        if (identity.contractId !== OPFIELD_CORE_CONTRACT_ID) {
          throw new Error('core readiness contract identity does not match Opfield');
        }
        if (identity.coreProtocolMajor !== INFERENCE_CORE_PROTOCOL_MAJOR) {
          throw new Error('core readiness protocol version does not match Opfield');
        }
        if (identity.stateSchemaVersion !== INFERENCE_CORE_STATE_SCHEMA_VERSION) {
          throw new Error('core readiness state schema does not match Opfield');
        }
        if (normalizeReleaseVersion(identity.version) !== normalizeReleaseVersion(expectedVersion)) {
          throw new Error(`core readiness version mismatch: expected ${expectedVersion}, received ${identity.version}`);
        }
        return identity.requestLimitsVersion === 1;
      }
      if (Date.now() > deadline) {
        throw new Error('core did not become ready with the expected identity in time');
      }
      await sleep(this.timings.readyPollMs);
    }
  }

  /** Prepare while serving, then stop the sole writer, snapshot and activate. */
  private async updateCoreContainer(
    operationId: string,
    row: InferenceCoreStateRow,
    artifact: TrustedOpenCodexImageArtifact
  ): Promise<void> {
    const layout = await this.discoverLayout();
    const previous = {
      version: row.installedVersion!,
      digest: row.installedDigest!,
      imageRef: row.installedImageRef!,
    };

    // Pull while the old core keeps serving.
    await this.pullImage(operationId, artifact);
    await this.operations.updatePhase(operationId, 'updating', { stage: STAGE.updating });
    const credentials = this.openCredentials(row);
    const client = new InferenceCoreClient(this.coreBaseUrl(), credentials.managementCredential);
    const initialStatus = await client.drainStatus();
    if (!initialStatus) throw new Error('Cannot verify core shutdown capabilities; update cancelled');
    const supportsDrainCompletion = typeof initialStatus.drained === 'boolean';
    // The size preflight is deliberately while the old core still serves. The
    // actual archive remains after its sole writer stops, and its streaming
    // byte ceiling still catches growth between this observation and cutover.
    await this.assertStateVolumeFitsBackupLimit(layout, previous.imageRef);
    // Docker creation/preparation does not start a second core or change the
    // active endpoint. Creation failures therefore leave the old core serving.
    const candidateId = await this.createCoreContainer(
      { ...layout, containerName: `${layout.containerName}-candidate` },
      artifact,
      credentials,
      false
    );
    let stopped = false;
    let accepted = false;
    let backupFile: string | null = null;
    const cutoverStartedAt = Date.now();
    try {
      await this.transition(await this.requireStateRow(), 'updating', null);
      await this.publishNow();
      if (supportsDrainCompletion) {
        await client.drain();
        await this.awaitDrain(client);
      }
      // Stop the sole writer before snapshotting. A live tar is not a rollback
      // snapshot: streams and settlements may still mutate its files.
      // Older cores cannot prove persistence completion. Keep their normal
      // bounded SIGTERM path, without a temporary drain lease blocking shutdown.
      if (row.containerId) await this.docker.stopContainer(row.containerId, supportsDrainCompletion ? 2 : 60);
      stopped = true;
      await this.operations.updatePhase(operationId, 'updating', { stage: STAGE.preparingStorage });
      backupFile = await this.backupStateVolume(layout, row.installedImageRef!);
      if (row.containerId) await this.docker.removeContainer(row.containerId);
      await this.docker.renameContainer(candidateId, layout.containerName);
      await this.upsertStateRow({ containerId: candidateId, containerName: layout.containerName });
      await this.operations.updatePhase(operationId, 'starting', { stage: STAGE.checkingReadiness });
      await this.startAndAwaitReady(artifact);
      await this.transition(await this.requireStateRow(), 'ready', null);
      accepted = true;
      logger.info('Core update cutover completed', { operationId, cutoverMs: Date.now() - cutoverStartedAt });
      await this.publishNow();
      // Readiness is the acceptance boundary. Subsequent health probes observe
      // stability; never restore a pre-update snapshot after serving new work.
      await this.pruneOldCoreImages(artifact.imageRef, previous.imageRef);
      await this.pruneOldBackups();
    } catch (error) {
      // Once new traffic is admitted, restoring the old snapshot would erase
      // its continuation/accounting state. Later health is handled by probes.
      if (accepted) throw error;
      await this.docker.removeContainer(candidateId).catch(() => {});
      if (!stopped) {
        // A failed resume must leave this installation degraded, not routable.
        if (supportsDrainCompletion) await client.resume();
        await this.transition(await this.requireStateRow(), 'ready', null);
        throw error;
      }
      await this.operations.updatePhase(operationId, 'rolling_back', { stage: STAGE.rollingBack }).catch(() => {});
      await this.rollbackToPrevious(layout, row, previous, backupFile, error);
      logger.info('Core update rollback completed', { operationId, recoveryMs: Date.now() - cutoverStartedAt });
      // The update failed even when the rollback restored the previous version;
      // the operation must close as failed so the UI never reports a success.
      throw error;
    }
  }

  /** Restore the recorded previous version and its backed-up state volume. */
  private async rollbackToPrevious(
    layout: CoreLayout,
    row: InferenceCoreStateRow,
    previous: { version: string; digest: string; imageRef: string },
    backupFile: string | null,
    cause: unknown
  ): Promise<void> {
    logger.error('Core update failed; rolling back', { error: redactedCoreError(cause) });
    const current = await this.requireStateRow();
    await this.transition(current, 'rolling_back', redactedCoreError(cause));
    await this.publishNow();
    try {
      if (current.containerId) {
        await this.docker.stopContainer(current.containerId, 10).catch(() => {});
        await this.docker.removeContainer(current.containerId).catch(() => {});
      }
      if (backupFile) await this.restoreStateVolume(layout, row.installedImageRef!, backupFile);
      if (!(await this.docker.imageExists(previous.imageRef))) {
        await this.docker.pullImageRef(previous.imageRef);
      }
      const credentials = this.openCredentials(row);
      const rollbackArtifact = {
        imageRef: previous.imageRef,
        digest: previous.digest,
        version: previous.version,
      } as TrustedOpenCodexImageArtifact;
      await this.createCoreContainer(layout, rollbackArtifact, credentials);
      await this.startAndAwaitReady(rollbackArtifact);
      const after = await this.requireStateRow();
      await this.transition(after, 'ready', `Update was rolled back; ${previous.version} remains active`);
    } catch (rollbackError) {
      const after = await this.loadStateRow();
      if (after) {
        await this.transition(
          after,
          'failed',
          `Rollback failed: ${redactedCoreError(rollbackError)}; the previous state backup is preserved`
        );
      }
    }
  }

  /** Recreate or restart the recorded container at the recorded digest. */
  private async repairContainer(row: InferenceCoreStateRow): Promise<void> {
    const layout = await this.discoverLayout();
    const artifact = {
      imageRef: row.installedImageRef!,
      digest: row.installedDigest!,
      version: row.installedVersion!,
    } as TrustedOpenCodexImageArtifact;
    const existing = row.containerId ? await this.inspectOwnedContainer(row.containerId) : null;
    if (existing?.State?.Running) {
      await this.docker.restartContainer(row.containerId!, 10);
    } else {
      if (existing) await this.docker.removeContainer(row.containerId!).catch(() => {});
      if (!(await this.docker.imageExists(artifact.imageRef))) {
        await this.docker.pullImageRef(artifact.imageRef);
      }
      const credentials = this.openCredentials(row);
      await this.createCoreContainer(layout, artifact, credentials);
    }
    await this.startAndAwaitReady(artifact);
  }

  // ------------------------------------------------------------- docker i/o

  /** Compose layout from self-inspection; fails without a stable alias. */
  private async discoverLayout(): Promise<CoreLayout> {
    const self = await this.docker.inspectSelf();
    const labels = self.Config.Labels ?? {};
    const project = labels['com.docker.compose.project'];
    const service = labels['com.docker.compose.service'];
    if (!project || !/^[a-zA-Z0-9_-]+$/.test(project) || !service) {
      throw new AppError(
        409,
        'CORE_LAYOUT_UNAVAILABLE',
        'The inference core requires the Compose-managed Opfield deployment'
      );
    }
    const networks = self.NetworkSettings?.Networks ?? {};
    for (const [name, attachment] of Object.entries(networks)) {
      if (attachment.Aliases?.includes(service)) {
        return inferenceCoreLayout(project, name, service, await this.loadStateRow());
      }
    }
    throw new AppError(
      409,
      'CORE_LAYOUT_UNAVAILABLE',
      'No stable internal Opfield network alias found; the core cannot be reached privately'
    );
  }

  /** Core images published next to the running Opfield image (a mirror or a self-built registry), newest name first. */
  private async siblingDistributionImages(): Promise<string[]> {
    const self = await this.docker.inspectSelf();
    const repository = imageRepositoryFromRef(self.Config.Image);
    // legacy-name: <repository>/opencodex — remove once every mirror publishes the core as <repository>/opfield-inference
    return [`${repository}/opfield-inference`, `${repository}/opencodex`];
  }

  private async trustedDistributionImages(): Promise<string[]> {
    if (this.env.INFERENCE_CORE_DISTRIBUTION_IMAGE) return [this.env.INFERENCE_CORE_DISTRIBUTION_IMAGE];
    const siblings = await this.siblingDistributionImages();
    const configured = (this.env.INFERENCE_CORE_UPDATE_IMAGE_REPOSITORIES ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
    return [...new Set([...siblings, ...configured])];
  }

  private coreBaseUrl(): string {
    return `http://${CORE_CONTAINER_ALIAS}:${CORE_PORT}`;
  }

  private async createOwnedVolumes(layout: CoreLayout): Promise<void> {
    const labels = { [LABEL_OWNED]: 'true', [LABEL_PROJECT]: layout.project };
    await this.docker.createVolume(layout.stateVolume, labels);
    await this.docker.createVolume(layout.secretVolume, labels);
    for (const name of [layout.stateVolume, layout.secretVolume]) {
      const volume = await this.docker.inspectVolume(name);
      if (volume?.Labels?.[LABEL_OWNED] !== 'true' || volume.Labels?.[LABEL_PROJECT] !== layout.project) {
        throw new AppError(409, 'CORE_VOLUME_FOREIGN', `Volume ${name} exists without core ownership labels`);
      }
    }
  }

  /**
   * Write the runtime credentials into the secret volume via a stopped
   * throwaway container and a tar archive. Credentials never appear in
   * `docker inspect` (no env/cmd) or in a process list.
   */
  private async writeCredentialsFile(
    layout: CoreLayout,
    credentials: InferenceCoreCredentials,
    imageRef: string
  ): Promise<void> {
    const payload = JSON.stringify({
      version: 1,
      dataCredential: credentials.dataCredential,
      managementCredential: credentials.managementCredential,
      callbackCredential: credentials.callbackCredential,
      [LEGACY_CORE_INTERNAL_URL_KEY]: `http://${layout.opfieldAlias}:${INFERENCE_CORE_INTERNAL_PORT}`,
    });
    const tar = buildSingleFileTar('credentials.json', Buffer.from(payload, 'utf8'), 0o600, 10001, 10001);
    const helper = await this.docker.createContainer({
      Image: imageRef,
      Labels: { [LABEL_OWNED]: 'true', [LABEL_PROJECT]: layout.project, [LABEL_ROLE]: ROLE_HELPER },
      HostConfig: { Binds: [`${layout.secretVolume}:/secrets`] },
    });
    try {
      await this.docker.putContainerArchive(helper, '/secrets', tar);
    } finally {
      await this.docker.removeContainer(helper, { removeAnonymousVolumes: true }).catch(() => {});
    }
  }

  /**
   * Back up the state volume into the Opfield data dir as a tar archive. The
   * size check runs in a one-shot container first; the archive itself is
   * streamed out of a stopped helper that only mounts the volume.
   */
  private async backupStateVolume(layout: CoreLayout, imageRef: string): Promise<string | null> {
    const helper = await this.docker.createContainer({
      Image: imageRef,
      Labels: { [LABEL_OWNED]: 'true', [LABEL_PROJECT]: layout.project, [LABEL_ROLE]: ROLE_HELPER },
      HostConfig: { Binds: [`${layout.stateVolume}:/state:ro`] },
    });
    try {
      await mkdir(this.backupDir, { recursive: true, mode: 0o700 });
      const file = `${this.backupDir}/state-${Date.now()}.tar`;
      const temporaryFile = `${file}.tmp`;
      try {
        await this.docker.getContainerArchiveToFile(
          helper,
          '/state',
          temporaryFile,
          CORE_BACKUP_MAX_BYTES,
          CORE_BACKUP_TIMEOUT_MS
        );
        await rename(temporaryFile, file);
        return file;
      } catch (error) {
        await unlink(temporaryFile).catch(() => {});
        throw error;
      }
    } finally {
      await this.docker.removeContainer(helper, { removeAnonymousVolumes: true }).catch(() => {});
    }
  }

  /** Reject an already oversized state volume before the serving core is fenced. */
  private async assertStateVolumeFitsBackupLimit(layout: CoreLayout, imageRef: string): Promise<void> {
    const sizeProbe = await this.docker.runOneShot({
      Image: imageRef,
      User: '0',
      HostConfig: { Binds: [`${layout.stateVolume}:/state:ro`] },
      ...CORE_IMAGE_SHELL,
      Cmd: ['du -sb /state | cut -f1'],
    });
    const bytes = Number(sizeProbe.output.trim().split('\n').pop());
    if (sizeProbe.exitCode !== 0 || !Number.isFinite(bytes) || bytes < 0 || !sizeProbe.output.trim()) {
      throw new AppError(409, 'CORE_STATE_SIZE_UNKNOWN', 'Cannot verify core state size; update cancelled');
    }
    if (Number.isFinite(bytes) && bytes > CORE_BACKUP_MAX_BYTES) {
      throw new AppError(409, 'CORE_STATE_TOO_LARGE', 'The core state volume exceeds the backup limit');
    }
  }

  private async restoreStateVolume(layout: CoreLayout, imageRef: string, backupFile: string): Promise<void> {
    const cleared = await this.docker.runOneShot({
      Image: imageRef,
      User: '0',
      HostConfig: { Binds: [`${layout.stateVolume}:/state`] },
      ...CORE_IMAGE_SHELL,
      Cmd: ['find /state -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +'],
    });
    if (cleared.exitCode !== 0) {
      throw new AppError(500, 'CORE_STATE_CLEAR_FAILED', 'The previous core state volume could not be cleared');
    }
    const helper = await this.docker.createContainer({
      Image: imageRef,
      User: '0',
      Labels: { [LABEL_OWNED]: 'true', [LABEL_PROJECT]: layout.project, [LABEL_ROLE]: ROLE_HELPER },
      HostConfig: { Binds: [`${layout.stateVolume}:/state`] },
    });
    try {
      // The archive contains the `state/` prefix, so extracting at / restores
      // /state after the target was cleared. This is an exact restore, not an
      // overlay that could retain files created by the failed version.
      await this.docker.putContainerArchiveFromFile(helper, '/', backupFile);
    } finally {
      await this.docker.removeContainer(helper, { removeAnonymousVolumes: true }).catch(() => {});
    }
  }

  private async pruneOldBackups(): Promise<void> {
    const entries = await readdir(this.backupDir).catch(() => [] as string[]);
    const backups = entries.filter((name) => name.startsWith('state-') && name.endsWith('.tar')).sort();
    const excess = backups.length - CORE_BACKUP_KEEP;
    for (let i = 0; i < excess; i += 1) {
      await unlink(`${this.backupDir}/${backups[i]}`).catch(() => {});
    }
  }

  private async pruneOldCoreImages(currentImageRef: string, previousImageRef?: string): Promise<void> {
    const repository = imageRepositoryFromRef(currentImageRef);
    const currentDigest = currentImageRef.includes('@')
      ? currentImageRef.slice(currentImageRef.indexOf('@') + 1)
      : null;
    const attempted = new Set<string>();
    const remove = async (ref: string): Promise<void> => {
      if (attempted.has(ref)) return;
      attempted.add(ref);
      await this.docker.removeImageTag(ref).catch((error) => {
        logger.warn('Old inference core image cleanup failed', { image: ref, error: redactedCoreError(error) });
      });
    };

    if (previousImageRef !== currentImageRef && previousImageRef) await remove(previousImageRef);

    let images: Awaited<ReturnType<DockerService['listImages']>>;
    try {
      images = await this.docker.listImages();
    } catch (error) {
      logger.warn('Inference core image inventory failed during cleanup', { error: redactedCoreError(error) });
      return;
    }
    for (const image of images) {
      const refs = [...(image.RepoTags ?? []), ...(image.RepoDigests ?? [])];
      if (!refs.some((ref) => ref.startsWith(`${repository}:`) || ref.startsWith(`${repository}@`))) continue;
      if (image.Id === currentDigest || refs.includes(currentImageRef)) continue;
      await remove(image.Id);
    }
  }

  // --------------------------------------------------------------- helpers

  private openCredentials(row: InferenceCoreStateRow): InferenceCoreCredentials {
    if (!row.credentialsPayload || !row.credentialsDek) {
      throw new AppError(409, 'CORE_CREDENTIALS_MISSING', 'Core credentials are missing; reinstall the core');
    }
    return this.vault.open<InferenceCoreCredentials>({
      encryptedPayload: row.credentialsPayload,
      encryptedDek: row.credentialsDek,
      keyVersion: row.credentialKeyVersion ?? 1,
    });
  }

  private async loadStateRow(): Promise<InferenceCoreStateRow | null> {
    return this.store.loadState();
  }

  private async requireStateRow(): Promise<InferenceCoreStateRow> {
    const row = await this.loadStateRow();
    if (!row) throw new Error('inference core state row is missing');
    return row;
  }

  private async upsertStateRow(patch: Parameters<InferenceCoreStore['upsertState']>[0]): Promise<void> {
    await this.store.upsertState(patch);
  }

  private async transition(
    row: InferenceCoreStateRow,
    to: InferenceCoreState,
    lastError: string | null
  ): Promise<void> {
    assertInferenceCoreTransition(row.state, to);
    await this.upsertStateRow({ state: to, lastError });
  }

  private async transitionState(from: InferenceCoreState, to: InferenceCoreState): Promise<void> {
    const row = await this.requireStateRow();
    if (row.state !== from) {
      throw new Error(`inference core state drifted during operation: expected ${from}, found ${row.state}`);
    }
    await this.transition(row, to, null);
    await this.publishNow();
  }

  private compatibilityOf(row: InferenceCoreStateRow | null): 'compatible' | 'update_required' | 'unknown' {
    if (!row || row.coreProtocolMajor == null || row.coreStateSchemaVersion == null) return 'unknown';
    return row.coreProtocolMajor === INFERENCE_CORE_PROTOCOL_MAJOR &&
      row.coreStateSchemaVersion === INFERENCE_CORE_STATE_SCHEMA_VERSION
      ? 'compatible'
      : 'update_required';
  }

  private async loadLatestInfo(): Promise<InferenceCoreLatestInfo | null> {
    return this.store.loadLatestInfo();
  }

  private async storeLatestInfo(info: InferenceCoreLatestInfo | null): Promise<void> {
    await this.store.storeLatestInfo(info);
  }

  private async findContainerByName(name: string) {
    const containers = await this.docker.listLocalContainers();
    return containers.find((c) => c.Names.includes(`/${name}`)) ?? null;
  }

  private async assertNoForeignContainer(name: string): Promise<void> {
    const existing = await this.findContainerByName(name);
    if (!existing) return;
    if (existing.Labels?.[LABEL_OWNED] !== 'true') {
      throw new AppError(
        409,
        'CORE_CONTAINER_FOREIGN',
        'A foreign container occupies the inference core name; remove it manually and retry'
      );
    }
    await this.docker.stopContainer(existing.Id).catch(() => {});
    await this.docker.removeContainer(existing.Id);
  }

  private async inspectOwnedContainer(id: string) {
    try {
      return await this.docker.inspectContainer(id);
    } catch {
      return null;
    }
  }

  private async awaitDrain(client: InferenceCoreClient): Promise<void> {
    const deadline = Date.now() + this.timings.drainTimeoutMs;
    for (;;) {
      const status = await client.drainStatus();
      if (status?.drained === true) return;
      if (Date.now() > deadline) {
        throw new Error('Core did not confirm persistence of interrupted requests; update cancelled');
      }
      await sleep(this.timings.drainPollMs);
    }
  }

  private async probeHealthSafely(): Promise<void> {
    try {
      const row = await this.loadStateRow();
      if (!row?.containerName) return;
      const layout = await this.discoverLayout();
      await this.probeHealth(layout);
      if (Date.now() - this.diskBoundAt >= CORE_DISK_BOUND_INTERVAL_MS) {
        this.diskBoundAt = Date.now();
        await this.boundCoreDiskUse(layout);
      }
    } catch (error) {
      logger.debug('Core health probe failed', { error: redactedCoreError(error) });
    }
  }

  /**
   * Keeps what the running core writes bounded: usage.jsonl in its state volume, and the container log of a core
   * created before Opfield set its log rotation (Docker cannot add it without recreating the container; the next
   * update or repair does). Runs only while the core is ready, in one-shot containers of the installed image.
   */
  private async boundCoreDiskUse(layout: CoreLayout): Promise<void> {
    const row = await this.loadStateRow();
    if (row?.state !== 'ready' || !row.installedImageRef || !row.containerId) return;
    const imageRef = row.installedImageRef;
    const usage = await this.docker.runOneShot({
      Image: imageRef,
      User: '0',
      Labels: { [LABEL_OWNED]: 'true', [LABEL_PROJECT]: layout.project, [LABEL_ROLE]: ROLE_HELPER },
      HostConfig: { Binds: [`${layout.stateVolume}:/state`], NetworkMode: 'none' },
      ...CORE_IMAGE_SHELL,
      Cmd: [trimFileScript('/state/usage.jsonl', CORE_USAGE_LOG_MAX_BYTES, CORE_USAGE_LOG_KEEP_BYTES, 'replace')],
    });
    if (usage.exitCode === 0 && usage.output.includes('trimmed')) {
      logger.info('Trimmed the inference core usage ledger to its newest part', { output: usage.output.trim() });
    }
    const details = await this.docker.inspectContainerDetails(row.containerId);
    const logConfig = details?.HostConfig?.LogConfig;
    const logPath = details?.LogPath;
    if (!logPath || logConfig?.Type !== 'json-file' || logConfig.Config?.['max-size']) return;
    const directory = logPath.slice(0, logPath.lastIndexOf('/'));
    const file = logPath.slice(logPath.lastIndexOf('/') + 1);
    if (!directory.startsWith('/') || !/^[0-9a-f]{64}-json\.log$/.test(file)) return;
    const cut = await this.docker.runOneShot({
      Image: imageRef,
      User: '0',
      Labels: { [LABEL_OWNED]: 'true', [LABEL_PROJECT]: layout.project, [LABEL_ROLE]: ROLE_HELPER },
      HostConfig: { Binds: [`${directory}:/logs`], NetworkMode: 'none' },
      ...CORE_IMAGE_SHELL,
      Cmd: [trimFileScript(`/logs/${file}`, UNROTATED_CORE_LOG_MAX_BYTES, UNROTATED_CORE_LOG_KEEP_BYTES, 'in-place')],
    });
    if (cut.exitCode === 0 && cut.output.includes('trimmed')) {
      logger.info('Cut the inference core container log; the next core update gives it log rotation', {
        output: cut.output.trim(),
      });
    }
  }

  /** Identity-aware probe; moves only between steady states. */
  private async probeHealth(layout: CoreLayout): Promise<void> {
    void layout;
    const row = await this.loadStateRow();
    if (!row?.installedDigest) return;
    let credentials: InferenceCoreCredentials;
    try {
      credentials = this.openCredentials(row);
    } catch {
      return;
    }
    const client = new InferenceCoreClient(this.coreBaseUrl(), credentials.managementCredential);
    const probe = await client.ready();
    const identity = probe.identity;
    const healthy =
      probe.ready &&
      identity !== null &&
      identity.contractId === OPFIELD_CORE_CONTRACT_ID &&
      identity.coreProtocolMajor === INFERENCE_CORE_PROTOCOL_MAJOR;
    // A health probe from a superseded installation must not describe its replacement.
    if ((await this.loadStateRow())?.installedDigest !== row.installedDigest) return;
    this.observedRequestLimits =
      healthy && identity ? { digest: row.installedDigest, supported: identity.requestLimitsVersion === 1 } : null;
    await this.upsertStateRow({
      healthStatus: healthy ? 'healthy' : 'unhealthy',
      healthCheckedAt: new Date(),
      ...(healthy ? { lastReadyAt: new Date() } : {}),
    });
    if (healthy && row.state === 'degraded') {
      await this.transition(row, 'ready', null);
      await this.publishNow();
    } else if (!healthy && (row.state === 'ready' || row.state === 'update_available')) {
      await this.transition(row, 'degraded', 'The inference core is not answering health checks');
      await this.publishNow();
    }
  }

  private toOperationDto(row: {
    id: string;
    kind: InferenceCoreOperation['kind'];
    phase: InferenceCoreOperation['phase'];
    status: InferenceCoreOperation['status'];
    progress: InferenceCoreOperationProgress | null;
    fromVersion: string | null;
    toVersion: string | null;
    fromDigest: string | null;
    toDigest: string | null;
    error: string | null;
    startedAt: Date;
    heartbeatAt: Date;
    finishedAt: Date | null;
  }): InferenceCoreOperation {
    return {
      id: row.id,
      kind: row.kind,
      phase: row.phase,
      status: row.status,
      progress: row.progress ?? null,
      fromVersion: row.fromVersion ?? null,
      toVersion: row.toVersion ?? null,
      fromDigest: row.fromDigest ?? null,
      toDigest: row.toDigest ?? null,
      error: row.error ?? null,
      startedAt: row.startedAt.toISOString(),
      updatedAt: row.heartbeatAt.toISOString(),
      finishedAt: row.finishedAt?.toISOString() ?? null,
    };
  }

  private async publishNow(): Promise<void> {
    const status = await this.getStatus();
    this.eventBus.publish(INFERENCE_CORE_CHANGED_CHANNEL, status);
  }
}

/** Internal listener port for core → Opfield callbacks (T5 binds it). */
export const INFERENCE_CORE_INTERNAL_PORT = 9410;

/**
 * Minimal ustar builder for a single regular file. Used to seed the secret
 * volume without ever exposing credential material to `docker inspect`.
 */
export function buildSingleFileTar(name: string, content: Buffer, mode: number, uid: number, gid: number): Buffer {
  const header = Buffer.alloc(512, 0);
  const writeString = (value: string, offset: number, length: number) => {
    header.write(value, offset, Math.min(value.length, length), 'utf8');
  };
  const writeOctal = (value: number, offset: number, length: number) => {
    const text = value.toString(8).padStart(length - 1, '0');
    header.write(text, offset, length - 1, 'ascii');
  };
  writeString(name, 0, 100);
  writeOctal(mode, 100, 8);
  writeOctal(uid, 108, 8);
  writeOctal(gid, 116, 8);
  writeOctal(content.length, 124, 12);
  writeOctal(Math.floor(Date.now() / 1000), 136, 12);
  header.fill(0x20, 148, 156); // checksum field is spaces during computation
  header.write('0', 156, 1, 'ascii'); // regular file
  writeString('ustar', 257, 6);
  header.write('00', 263, 2, 'ascii');
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(checksum.toString(8).padStart(6, '0'), 148, 6, 'ascii');
  header.write('\0', 154, 1, 'ascii');
  header.write(' ', 155, 1, 'ascii');

  const padding = Buffer.alloc((512 - (content.length % 512)) % 512, 0);
  const trailer = Buffer.alloc(1024, 0);
  return Buffer.concat([header, content, padding, trailer]);
}
