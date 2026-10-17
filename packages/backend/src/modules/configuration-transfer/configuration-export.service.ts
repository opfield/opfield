import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { Readable } from 'node:stream';
import {
  LEGACY_APP_DATA_DIR,
  LEGACY_VOLUME_APP_DATA,
  LEGACY_VOLUME_REGISTRY_AUTH,
  LEGACY_VOLUME_REGISTRY_DATA,
  LEGACY_VOLUME_RELAY_IDENTITY,
} from '@/lib/legacy-compat.js';
import { createChildLogger } from '@/lib/logger.js';
import { issueOneTimeLink, type OneTimeLinkKind, takeOneTimeLink } from '@/lib/one-time-link.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import type { LicenseService } from '@/modules/license/license.service.js';
import type { LoggingSettingsService } from '@/modules/logging/logging-settings.service.js';
import type { GeneralSettingsService } from '@/modules/settings/general-settings.service.js';
import type { DockerService } from '@/services/docker.service.js';
import { ExportArchiveError, ExportArchiveWriter, MANIFEST_PART, validatePassphrase } from './transfer-archive.js';
import {
  type ComposeInstallation,
  databaseSize,
  findInstallation,
  openClickHouseSnapshot,
  openCommercialArchive,
  openDatabaseDump,
  openVolumeArchive,
  removeExportLeftovers,
  removeLeftoverHelpers,
  type TransferStream,
  volumeSize,
} from './transfer-docker.js';
import {
  COMMERCIAL_PART,
  CONFIGURATION_EXPORT_FORMAT,
  type ConfigurationExportManifest,
  composeVolumeName,
  currentSchemaMigration,
  DATABASE_DUMP_FILE,
  DATABASE_PART,
  ENVIRONMENT_PART,
  exportFileName,
  exportVolumeName,
  HOST_SPECIFIC_VALUES,
  portableEnvironment,
  registryStorageEnvironment,
  TRANSFER_VOLUMES,
  type TransferVolumeKey,
  type TransferVolumeManifest,
  volumePartName,
} from './transfer-layout.js';

const logger = createChildLogger('ConfigurationExport');
const TICKET_TTL_MS = 15 * 60 * 1000;
const FINISHED_KEEP_MS = 60 * 60 * 1000;

export const CONFIGURATION_EXPORT_LINK_PATH = '/api/configuration-export-link';
const DOWNLOAD_LINK: OneTimeLinkKind = {
  path: CONFIGURATION_EXPORT_LINK_PATH,
  tokenPrefix: 'opfce_',
  cachePrefix: 'configuration-export:download-link:',
  ttlSeconds: TICKET_TTL_MS / 1000,
  label: 'configuration export links',
};

export interface ConfigurationExportOptions {
  includeRegistry: boolean;
  includeLogs: boolean;
}

export interface ConfigurationExportSection {
  bytes: number | null;
  available: boolean;
  /** Why an optional section cannot be included. */
  reason?: string;
}

export interface ConfigurationExportEstimate {
  available: boolean;
  unavailableReason: string | null;
  opfieldVersion: string;
  sections: {
    database: ConfigurationExportSection;
    files: ConfigurationExportSection;
    registry: ConfigurationExportSection;
    logs: ConfigurationExportSection;
  };
  hostSpecific: readonly string[];
}

export type ConfigurationExportState = 'ready' | 'running' | 'completed' | 'failed';

export interface ConfigurationExportProgress {
  id: string;
  state: ConfigurationExportState;
  options: ConfigurationExportOptions;
  filename: string;
  bytesWritten: number;
  estimatedBytes: number | null;
  currentPart: string | null;
  createdAt: string;
  finishedAt: string | null;
  error: string | null;
}

interface ExportTicket extends ConfigurationExportProgress {
  userId: string;
  /** Held in memory only, until the download starts and derives the key. */
  passphrase: string | null;
  ipAddress?: string;
}

interface DownloadGrant {
  exportId: string;
  userId: string;
}

function unavailable(message: string): AppError {
  return new AppError(409, 'CONFIGURATION_EXPORT_UNAVAILABLE', message);
}

function publicProgress(ticket: ExportTicket): ConfigurationExportProgress {
  const { userId: _user, passphrase: _passphrase, ipAddress: _ip, ...progress } = ticket;
  return { ...progress, options: { ...progress.options } };
}

/**
 * Exports this installation into one encrypted file for a restore on another host: a consistent
 * pg_dump of the database, the portable environment (with PKI_MASTER_KEY, which decrypts every CA
 * key, the relay policy signing keys and all stored secrets), Opfield's file volumes, and when asked
 * the internal registry and the managed ClickHouse logs. Nothing stops while it runs.
 */
export class ConfigurationExportService {
  private readonly tickets = new Map<string, ExportTicket>();

  constructor(
    private readonly docker: DockerService,
    private readonly generalSettings: GeneralSettingsService,
    private readonly loggingSettings: LoggingSettingsService,
    private readonly license: LicenseService,
    private readonly audit: AuditService,
    private readonly env: NodeJS.ProcessEnv = process.env
  ) {}

  private opfieldVersion(): string {
    return this.env.APP_VERSION || 'dev';
  }

  /** The Compose installation this app belongs to, or why an export cannot run here. */
  private async installation(): Promise<ComposeInstallation> {
    let self: Awaited<ReturnType<DockerService['inspectSelf']>>;
    try {
      self = await this.docker.inspectSelf();
    } catch {
      throw unavailable(
        'Configuration export needs Opfield installed with Docker Compose and the Docker socket mounted'
      );
    }
    const project = self.Config.Labels?.['com.docker.compose.project'];
    if (!project) throw unavailable('This Opfield container does not belong to a Docker Compose project');
    const details = await this.docker.inspectContainerDetails(self.Id);
    if (!details) throw unavailable('Opfield cannot inspect its own container');
    return findInstallation(this.docker, project, details.Image);
  }

  private async volumeName(installation: ComposeInstallation, key: TransferVolumeKey): Promise<string> {
    if (key === 'clickhouse_data')
      return installation.clickhouse?.volume ?? composeVolumeName(installation.project, key);
    const spec = TRANSFER_VOLUMES.find((volume) => volume.key === key);
    // The app's own mounts name its volumes exactly; Compose's naming covers the rest.
    if (spec?.appMounts && installation.app) {
      const details = await this.docker.inspectContainerDetails(installation.app);
      const mount = details?.Mounts?.find(
        (entry) => spec.appMounts?.includes(entry.Destination ?? '') && entry.Type === 'volume'
      );
      if (mount?.Name) return mount.Name;
    }
    if (key === LEGACY_VOLUME_REGISTRY_DATA && installation.registry) {
      const details = await this.docker.inspectContainerDetails(installation.registry);
      const mount = details?.Mounts?.find(
        (entry) => entry.Destination === '/var/lib/registry' && entry.Type === 'volume'
      );
      if (mount?.Name) return mount.Name;
    }
    return composeVolumeName(installation.project, key);
  }

  private async logsSection(installation: ComposeInstallation | null): Promise<ConfigurationExportSection> {
    const logging = await this.loggingSettings.getRuntimeConfig().catch(() => null);
    if (!logging || logging.mode === 'disabled') {
      return { bytes: null, available: false, reason: 'Structured logging is off' };
    }
    if (logging.mode === 'external') {
      return { bytes: null, available: false, reason: 'Logs are in an external ClickHouse and stay there' };
    }
    if (!installation?.clickhouse) {
      return { bytes: null, available: false, reason: 'The Opfield-managed ClickHouse container was not found' };
    }
    const bytes = await volumeSize(this.docker, installation, installation.clickhouse.volume).catch(() => null);
    return { bytes, available: true };
  }

  async estimate(): Promise<ConfigurationExportEstimate> {
    const empty: ConfigurationExportSection = { bytes: null, available: false };
    let installation: ComposeInstallation;
    try {
      installation = await this.installation();
    } catch (error) {
      return {
        available: false,
        unavailableReason: error instanceof Error ? error.message : String(error),
        opfieldVersion: this.opfieldVersion(),
        sections: { database: empty, files: empty, registry: empty, logs: empty },
        hostSpecific: HOST_SPECIFIC_VALUES,
      };
    }
    const fileVolumes: TransferVolumeKey[] = [
      LEGACY_VOLUME_APP_DATA,
      LEGACY_VOLUME_RELAY_IDENTITY,
      LEGACY_VOLUME_REGISTRY_AUTH,
    ];
    const [database, files, registryVolume, logs] = await Promise.all([
      databaseSize(this.docker, installation).catch(() => null),
      Promise.all(
        fileVolumes.map(async (key) =>
          volumeSize(this.docker, installation, await this.volumeName(installation, key)).catch(() => null)
        )
      ),
      this.volumeName(installation, LEGACY_VOLUME_REGISTRY_DATA),
      this.logsSection(installation),
    ]);
    const registryBytes = await volumeSize(this.docker, installation, registryVolume).catch(() => null);
    return {
      available: true,
      unavailableReason: null,
      opfieldVersion: this.opfieldVersion(),
      sections: {
        database: { bytes: database, available: true },
        files: { bytes: files.reduce<number>((sum, bytes) => sum + (bytes ?? 0), 0), available: true },
        registry:
          registryBytes === null
            ? { bytes: null, available: false, reason: 'The internal registry volume was not found' }
            : { bytes: registryBytes, available: true },
        logs,
      },
      hostSpecific: HOST_SPECIFIC_VALUES,
    };
  }

  private prune(now = Date.now()): void {
    for (const [id, ticket] of this.tickets) {
      const age = now - Date.parse(ticket.finishedAt ?? ticket.createdAt);
      if ((ticket.state === 'ready' && age > TICKET_TTL_MS) || (ticket.finishedAt && age > FINISHED_KEEP_MS)) {
        this.tickets.delete(id);
      }
    }
  }

  /**
   * Removes what a crashed or cut-off export left on the Opfield host (Housekeeping, Opfield Host Files). Does nothing
   * while an export runs or waits for its download.
   */
  async cleanLeftovers(): Promise<number> {
    this.prune();
    if ([...this.tickets.values()].some((ticket) => ticket.state === 'running' || ticket.state === 'ready')) return 0;
    const installation = await this.installation();
    return removeExportLeftovers(this.docker, installation);
  }

  /** Prepares an export and returns the one-time link that streams it. */
  async prepare(
    userId: string,
    input: ConfigurationExportOptions & { passphrase: string },
    context: { ipAddress?: string } = {}
  ): Promise<{ export: ConfigurationExportProgress; downloadUrl: string; expiresAt: string }> {
    try {
      validatePassphrase(input.passphrase);
    } catch (error) {
      throw new AppError(400, 'CONFIGURATION_EXPORT_PASSPHRASE', (error as Error).message);
    }
    this.prune();
    if ([...this.tickets.values()].some((ticket) => ticket.state === 'running')) {
      throw new AppError(409, 'CONFIGURATION_EXPORT_RUNNING', 'Another configuration export is running');
    }
    const estimate = await this.estimate();
    if (!estimate.available) throw unavailable(estimate.unavailableReason ?? 'Configuration export is unavailable');
    if (input.includeLogs && !estimate.sections.logs.available) {
      throw new AppError(400, 'CONFIGURATION_EXPORT_LOGS', estimate.sections.logs.reason ?? 'Logs cannot be included');
    }
    if (input.includeRegistry && !estimate.sections.registry.available) {
      throw new AppError(
        400,
        'CONFIGURATION_EXPORT_REGISTRY',
        estimate.sections.registry.reason ?? 'The registry cannot be included'
      );
    }
    const createdAt = new Date();
    const sections = estimate.sections;
    const estimatedBytes =
      (sections.database.bytes ?? 0) +
      (sections.files.bytes ?? 0) +
      (input.includeRegistry ? (sections.registry.bytes ?? 0) : 0) +
      (input.includeLogs ? (sections.logs.bytes ?? 0) : 0);
    const ticket: ExportTicket = {
      id: randomUUID(),
      state: 'ready',
      options: { includeRegistry: input.includeRegistry, includeLogs: input.includeLogs },
      filename: exportFileName(await this.generalSettings.getPublicUrl(), createdAt),
      bytesWritten: 0,
      estimatedBytes: estimatedBytes || null,
      currentPart: null,
      createdAt: createdAt.toISOString(),
      finishedAt: null,
      error: null,
      userId,
      passphrase: input.passphrase,
      ipAddress: context.ipAddress,
    };
    this.tickets.set(ticket.id, ticket);
    const link = await issueOneTimeLink<DownloadGrant>(DOWNLOAD_LINK, { exportId: ticket.id, userId });
    return { export: publicProgress(ticket), downloadUrl: link.url, expiresAt: link.expiresAt };
  }

  progress(id: string, userId: string): ConfigurationExportProgress {
    const ticket = this.tickets.get(id);
    if (!ticket || ticket.userId !== userId) {
      throw new AppError(404, 'CONFIGURATION_EXPORT_NOT_FOUND', 'Configuration export not found');
    }
    return publicProgress(ticket);
  }

  /** Starts the export behind a download link; the stream is the encrypted file. */
  async openDownload(token: string): Promise<{ stream: Readable; filename: string }> {
    const grant = await takeOneTimeLink<DownloadGrant>(DOWNLOAD_LINK, token);
    const ticket = grant ? this.tickets.get(grant.exportId) : undefined;
    if (!grant || !ticket || ticket.userId !== grant.userId || ticket.state !== 'ready' || !ticket.passphrase) {
      throw new AppError(404, 'CONFIGURATION_EXPORT_LINK_INVALID', 'Export link is invalid, expired or already used');
    }
    const passphrase = ticket.passphrase;
    ticket.passphrase = null;
    ticket.state = 'running';
    let installation: ComposeInstallation;
    let writer: ExportArchiveWriter;
    try {
      installation = await this.installation();
      await removeLeftoverHelpers(this.docker, installation.project);
      writer = await ExportArchiveWriter.create(passphrase, {
        opfieldVersion: this.opfieldVersion(),
        schemaMigration: currentSchemaMigration(),
        createdAt: ticket.createdAt,
      });
    } catch (error) {
      ticket.state = 'failed';
      ticket.error = error instanceof Error ? error.message : String(error);
      ticket.finishedAt = new Date().toISOString();
      throw error;
    }
    void this.run(ticket, writer, installation);
    return { stream: writer.output, filename: ticket.filename };
  }

  private async run(ticket: ExportTicket, writer: ExportArchiveWriter, installation: ComposeInstallation) {
    const open: TransferStream[] = [];
    const progressTimer = setInterval(() => {
      ticket.bytesWritten = writer.bytesWritten;
    }, 500);
    progressTimer.unref();
    const addStream = async (part: string, opener: () => Promise<TransferStream>) => {
      ticket.currentPart = part;
      const transfer = await opener();
      open.push(transfer);
      try {
        await writer.addPart(part, transfer.stream);
      } finally {
        await transfer.close();
      }
      return transfer.root;
    };
    try {
      const general = await this.generalSettings.getConfig();
      const volumes: TransferVolumeManifest[] = [];
      const included = TRANSFER_VOLUMES.filter(
        (volume) =>
          !volume.optional ||
          (volume.optional === 'registry' && ticket.options.includeRegistry) ||
          (volume.optional === 'logs' && ticket.options.includeLogs)
      );
      // Only an installed core goes into the export; the community directory holds none.
      // An installation made before 2.12.3 names the directory under LEGACY_APP_DATA_DIR, which the app image links.
      const commercialDir = ['/var/lib/opfield', LEGACY_APP_DATA_DIR].some((root) =>
        this.env.OPFIELD_COMMERCIAL_DIR?.startsWith(`${root}/commercial/versions/`)
      )
        ? this.env.OPFIELD_COMMERCIAL_DIR
        : null;
      const hasCommercial = Boolean(commercialDir && installation.app && existsSync('/var/lib/opfield/commercial'));
      for (const volume of included) {
        volumes.push({
          key: volume.key,
          part: volumePartName(volume.key),
          root: volume.key === 'clickhouse_data' ? '.opfield-export-snapshot' : exportVolumeName(volume.key),
        });
      }
      const manifest: ConfigurationExportManifest = {
        format: CONFIGURATION_EXPORT_FORMAT,
        createdAt: ticket.createdAt,
        opfieldVersion: this.opfieldVersion(),
        schemaMigration: currentSchemaMigration(),
        installationId: await this.license.getInstallationId(),
        source: {
          publicUrl: general.publicUrl,
          grpcPublicTarget: general.grpcPublicTarget,
          grpcLocalIp: general.grpcLocalIp,
          composeProject: installation.project,
        },
        includes: { registry: ticket.options.includeRegistry, logs: ticket.options.includeLogs },
        commercialDir: hasCommercial ? (commercialDir ?? null) : null,
        database: { part: DATABASE_PART, file: DATABASE_DUMP_FILE },
        volumes,
        commercial: hasCommercial ? { part: COMMERCIAL_PART, root: 'commercial' } : null,
        environmentPart: ENVIRONMENT_PART,
      };
      ticket.currentPart = MANIFEST_PART;
      await writer.addJsonPart(MANIFEST_PART, manifest);
      const registryEnv = installation.registry
        ? ((await this.docker.inspectContainerDetails(installation.registry))?.Config.Env ?? [])
        : [];
      await writer.addJsonPart(ENVIRONMENT_PART, {
        ...portableEnvironment(this.env),
        ...registryStorageEnvironment(registryEnv),
      });
      await addStream(DATABASE_PART, () => openDatabaseDump(this.docker, installation));
      for (const volume of volumes) {
        const name = await this.volumeName(installation, volume.key);
        await addStream(volume.part, () =>
          volume.key === 'clickhouse_data'
            ? openClickHouseSnapshot(this.docker, installation)
            : openVolumeArchive(this.docker, installation, name, volume.root)
        );
      }
      if (manifest.commercial && installation.app) {
        await addStream(COMMERCIAL_PART, () => openCommercialArchive(this.docker, installation, installation.app!));
      }
      ticket.currentPart = null;
      await writer.finish();
      ticket.state = 'completed';
      ticket.bytesWritten = writer.bytesWritten;
      ticket.finishedAt = new Date().toISOString();
      logger.info('Configuration export completed', { exportId: ticket.id, bytes: writer.bytesWritten });
      await this.writeAudit(ticket, writer, null);
    } catch (error) {
      const message =
        error instanceof ExportArchiveError || error instanceof Error ? error.message : 'Configuration export failed';
      writer.abort(error instanceof Error ? error : new Error(message));
      await Promise.all(open.map((transfer) => transfer.close()));
      ticket.state = 'failed';
      ticket.error = message;
      ticket.bytesWritten = writer.bytesWritten;
      ticket.finishedAt = new Date().toISOString();
      logger.error('Configuration export failed', { exportId: ticket.id, part: ticket.currentPart, error: message });
      await this.writeAudit(ticket, writer, message);
    } finally {
      clearInterval(progressTimer);
    }
  }

  private async writeAudit(ticket: ExportTicket, writer: ExportArchiveWriter, error: string | null) {
    await this.audit
      .log({
        userId: ticket.userId,
        action: error ? 'system.configuration_export_failed' : 'system.configuration_export',
        resourceType: 'system',
        resourceId: ticket.id,
        ipAddress: ticket.ipAddress,
        details: {
          includeRegistry: ticket.options.includeRegistry,
          includeLogs: ticket.options.includeLogs,
          bytes: writer.bytesWritten,
          parts: writer.parts.map((part) => ({ name: part.name, bytes: part.bytes })),
          ...(error ? { error, part: ticket.currentPart } : {}),
        },
      })
      .catch((auditError) => logger.warn('Could not audit the configuration export', { error: auditError }));
  }
}
