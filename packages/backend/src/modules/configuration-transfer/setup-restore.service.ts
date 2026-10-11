import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { DOCKER_COMPOSE_CLI_IMAGE_REF } from '@/config/docker-compose-cli-image.js';
import { createChildLogger } from '@/lib/logger.js';
import { AppError } from '@/middleware/error-handler.js';
import { normalizeHostPortTarget, normalizePublicUrl } from '@/modules/settings/general-settings.service.js';
import type { DockerService } from '@/services/docker.service.js';
import { type ExportSummary, type RestoreStatus, restoreErrorMessage, verifyExport } from './configuration-restore.js';
import { validatePassphrase } from './transfer-archive.js';
import { composeVolumeName, currentSchemaMigration, RESTORE_STAGING_DIR } from './transfer-layout.js';

const logger = createChildLogger('SetupRestore');
export const SETUP_RESTORE_CHUNK_MAX_BYTES = 32 * 1024 * 1024;
const UPLOAD_FILE = 'upload.opfield-export';
const STATUS_FILE = 'status.json';
const PASSPHRASE_FILE = 'passphrase';
const IN_PROGRESS: ReadonlyArray<RestoreStatus['state']> = ['verifying', 'restoring', 'starting'];
const RUNNER_START_GRACE_MS = 60_000;

export type SetupRestoreState = 'empty' | 'uploaded' | 'verifying' | 'verified' | 'invalid' | 'restoring';

export interface SetupRestoreView {
  state: SetupRestoreState;
  uploadedBytes: number;
  verifiedBytes: number;
  summary: ExportSummary | null;
  error: { code: string; message: string } | null;
  /** Progress reported by the restore container. */
  restore: RestoreStatus | null;
  currentVersion: string;
}

export interface SetupRestoreStartInput {
  passphrase: string;
  publicUrl: string;
  grpcPublicTarget: string;
  grpcLocalIp: string;
}

/**
 * "Restore from an export" in the first-run setup wizard. The browser uploads the file in chunks
 * into gateway_data, Opfield decrypts and checks it with the passphrase, and the restore then runs
 * in a one-off container of this image (dist/cli/configuration-restore.js), which stops this app,
 * replaces the database and volumes and starts the stack again with the restored master key.
 */
export class SetupRestoreService {
  private verification: {
    running: boolean;
    bytes: number;
    summary: ExportSummary | null;
    error: { code: string; message: string } | null;
    fileSize: number;
  } | null = null;
  private restoring = false;
  private restoreStartedAt = 0;

  constructor(
    private readonly docker: DockerService,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly dataDir = '/var/lib/gateway'
  ) {}

  private get stagingDir(): string {
    return join(this.dataDir, RESTORE_STAGING_DIR);
  }

  private get uploadPath(): string {
    return join(this.stagingDir, UPLOAD_FILE);
  }

  private current() {
    return { gatewayVersion: this.env.APP_VERSION || 'dev', schemaMigration: currentSchemaMigration() };
  }

  private async uploadedBytes(): Promise<number> {
    return (await stat(this.uploadPath).catch(() => null))?.size ?? 0;
  }

  /** Appends one chunk; offset 0 starts a new upload. */
  async receiveChunk(offset: number, body: ReadableStream<Uint8Array> | null): Promise<number> {
    if (this.restoring || this.verification?.running) {
      throw new AppError(409, 'SETUP_RESTORE_BUSY', 'The export is being checked or restored');
    }
    if (!body) throw new AppError(400, 'SETUP_RESTORE_EMPTY', 'The chunk is empty');
    if (!Number.isSafeInteger(offset) || offset < 0) throw new AppError(400, 'SETUP_RESTORE_OFFSET', 'Invalid offset');
    await mkdir(this.stagingDir, { recursive: true, mode: 0o700 });
    const current = await this.uploadedBytes();
    if (offset !== 0 && offset !== current) {
      throw new AppError(409, 'SETUP_RESTORE_OFFSET', `The upload continues at byte ${current}`);
    }
    this.verification = null;
    let received = 0;
    const source = Readable.fromWeb(body as WebReadableStream<Uint8Array>);
    source.on('data', (chunk: Buffer) => {
      received += chunk.length;
      if (received > SETUP_RESTORE_CHUNK_MAX_BYTES) source.destroy(new Error('The chunk is too large'));
    });
    await pipeline(source, createWriteStream(this.uploadPath, { flags: offset === 0 ? 'w' : 'a', mode: 0o600 }));
    return this.uploadedBytes();
  }

  async discard(): Promise<void> {
    if (this.restoring) throw new AppError(409, 'SETUP_RESTORE_BUSY', 'The export is being restored');
    this.verification = null;
    await rm(this.stagingDir, { recursive: true, force: true });
  }

  /** Decrypts and checks the uploaded file in the background. */
  async startVerify(passphrase: string): Promise<SetupRestoreView> {
    if (this.restoring || this.verification?.running) {
      throw new AppError(409, 'SETUP_RESTORE_BUSY', 'The export is being checked or restored');
    }
    const fileSize = await this.uploadedBytes();
    if (fileSize === 0) throw new AppError(400, 'SETUP_RESTORE_NO_FILE', 'Upload the export file first');
    const verification = { running: true, bytes: 0, summary: null, error: null, fileSize } as NonNullable<
      typeof this.verification
    >;
    this.verification = verification;
    void verifyExport(this.uploadPath, passphrase, this.current(), (bytes) => {
      verification.bytes = bytes;
    })
      .then(({ summary }) => {
        verification.summary = summary;
      })
      .catch((error: unknown) => {
        verification.error = restoreErrorMessage(error);
      })
      .finally(() => {
        verification.running = false;
      });
    return this.view();
  }

  private async restoreStatus(): Promise<RestoreStatus | null> {
    try {
      return JSON.parse(await readFile(join(this.stagingDir, STATUS_FILE), 'utf8')) as RestoreStatus;
    } catch {
      return null;
    }
  }

  async view(): Promise<SetupRestoreView> {
    const [uploadedBytes, reported] = await Promise.all([this.uploadedBytes(), this.restoreStatus()]);
    const restore = reported ? await this.withRunnerState(reported) : null;
    const verification = this.verification;
    let state: SetupRestoreState = uploadedBytes > 0 ? 'uploaded' : 'empty';
    if (verification && verification.fileSize === uploadedBytes) {
      if (verification.running) state = 'verifying';
      else if (verification.summary) state = 'verified';
      else if (verification.error) state = 'invalid';
    }
    if (restore && IN_PROGRESS.includes(restore.state)) state = 'restoring';
    return {
      state,
      uploadedBytes,
      verifiedBytes: verification?.bytes ?? 0,
      summary: verification?.summary ?? null,
      error: verification?.error ?? null,
      restore,
      currentVersion: this.current().gatewayVersion,
    };
  }

  /**
   * A restore the container no longer runs (it was removed or crashed) reports itself as failed, so
   * the wizard can show it and start again instead of waiting forever.
   */
  private async withRunnerState(status: RestoreStatus): Promise<RestoreStatus> {
    if (!IN_PROGRESS.includes(status.state)) return status;
    const name = await this.runnerName().catch(() => null);
    const runner = name ? await this.docker.inspectContainerDetails(name).catch(() => null) : null;
    if (runner?.State.Running) return status;
    // Until the container started, the app itself reports the restore as starting.
    if (this.restoring && Date.now() - this.restoreStartedAt < RUNNER_START_GRACE_MS) return status;
    this.restoring = false;
    return {
      ...status,
      state: 'failed',
      error: status.error ?? 'The restore stopped before it finished. Check the export again and restore once more.',
    };
  }

  private async runnerName(): Promise<string | null> {
    const project = (await this.docker.inspectSelf()).Config.Labels?.['com.docker.compose.project'];
    return project ? `${project}-configuration-restore` : null;
  }

  /** Launches the restore container; this app is stopped by it shortly after. */
  async startRestore(input: SetupRestoreStartInput): Promise<SetupRestoreView> {
    if (this.restoring) throw new AppError(409, 'SETUP_RESTORE_BUSY', 'The export is being restored');
    const view = await this.view();
    if (view.state !== 'verified') {
      throw new AppError(409, 'SETUP_RESTORE_NOT_VERIFIED', 'Check the export with its passphrase first');
    }
    try {
      validatePassphrase(input.passphrase);
      normalizePublicUrl(input.publicUrl);
      if (!normalizeHostPortTarget(input.grpcPublicTarget)) throw new Error('Enter the gRPC address nodes connect to');
    } catch (error) {
      throw new AppError(400, 'SETUP_RESTORE_INVALID', (error as Error).message);
    }
    const self = await this.docker.inspectSelf();
    const labels = self.Config.Labels ?? {};
    const project = labels['com.docker.compose.project'];
    const composeDir = this.env.COMPOSE_PROJECT_DIR || labels['com.docker.compose.project.working_dir'];
    if (!project || !/^[a-zA-Z0-9_.-]+$/.test(project) || !composeDir || !/^\/[a-zA-Z0-9/_.-]+$/.test(composeDir)) {
      throw new AppError(409, 'SETUP_RESTORE_UNAVAILABLE', 'Opfield cannot find its Docker Compose installation');
    }
    const details = await this.docker.inspectContainerDetails(self.Id);
    const dataVolume =
      details?.Mounts?.find((mount) => mount.Destination === this.dataDir && mount.Type === 'volume')?.Name ??
      composeVolumeName(project, 'gateway_data');
    if (!details) throw new AppError(409, 'SETUP_RESTORE_UNAVAILABLE', 'Opfield cannot inspect its own container');

    this.restoring = true;
    this.restoreStartedAt = Date.now();
    try {
      await writeFile(join(this.stagingDir, PASSPHRASE_FILE), input.passphrase, { mode: 0o600 });
      await writeFile(
        join(this.stagingDir, STATUS_FILE),
        JSON.stringify({ state: 'verifying', step: 'Starting the restore', updatedAt: new Date().toISOString() }),
        { mode: 0o600 }
      );
      if (!(await this.docker.imageExists(DOCKER_COMPOSE_CLI_IMAGE_REF))) {
        await this.docker.pullImageRef(DOCKER_COMPOSE_CLI_IMAGE_REF);
      }
      const name = `${project}-configuration-restore`;
      await this.docker.removeContainer(name).catch(() => {});
      const containerDataDir = '/var/lib/gateway';
      const staging = join(containerDataDir, RESTORE_STAGING_DIR);
      const runner = await this.docker.createContainer(
        {
          Image: details.Image,
          Cmd: [
            'node',
            'dist/cli/configuration-restore.js',
            'restore',
            join(staging, UPLOAD_FILE),
            '--passphrase-file',
            join(staging, PASSPHRASE_FILE),
            '--remove-passphrase-file',
            '--host-dir',
            '/host',
            '--host-path',
            composeDir,
            '--project',
            project,
            '--start',
            '--wizard',
            '--status-file',
            join(staging, STATUS_FILE),
            '--public-url',
            input.publicUrl,
            '--grpc-target',
            input.grpcPublicTarget,
            '--grpc-local-ip',
            input.grpcLocalIp,
          ],
          // Not the helper label: the restore removes leftover helpers and must not remove itself.
          Labels: { 'com.wiolett.gateway.configuration-restore': project },
          HostConfig: {
            Binds: [
              '/var/run/docker.sock:/var/run/docker.sock',
              `${composeDir}:/host`,
              `${dataVolume}:${containerDataDir}`,
            ],
            NetworkMode: 'none',
          },
        },
        name
      );
      await this.docker.startContainer(runner);
      logger.info('Started the configuration restore container', { project, name });
    } catch (error) {
      this.restoring = false;
      await rm(join(this.stagingDir, PASSPHRASE_FILE), { force: true }).catch(() => {});
      await rm(join(this.stagingDir, STATUS_FILE), { force: true }).catch(() => {});
      throw error;
    }
    return this.view();
  }
}
