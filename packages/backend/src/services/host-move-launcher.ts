import path from 'node:path';
import { eq } from 'drizzle-orm';
import type { Env } from '@/config/env.js';
import type { DrizzleClient } from '@/db/client.js';
import { settings } from '@/db/schema/settings.js';
import { DEFAULT_SANDBOX_WORKSPACE_DIR } from '@/foundation/foundation-migrator.js';
import { HOST_MOVE_CONTAINER_NAME, hostMoveNewDir } from '@/foundation/host-move.js';
import {
  databaseIdentity,
  LEGACY_INSTALL_DIR_NAME,
  OPFIELD_COMPOSE_PROJECT,
  OPFIELD_DATABASE,
} from '@/foundation/opfield-names.js';
import { composeDirectoryOf } from '@/lib/compose-directory.js';
import { createChildLogger } from '@/lib/logger.js';
import type { DockerCreateContainerConfig, DockerService } from './docker.service.js';

const logger = createChildLogger('HostMoveLauncher');

/** Settings row that counts the moves this installation started; it survives a move and a rollback alike. */
const HOST_MOVE_SETTING_KEY = 'system:host_move';
/** Label of the move container, next to the update sidecar's role label. */
export const HOST_MOVE_ROLE_LABEL = 'net.opfield.role';
export const HOST_MOVE_ROLE = 'opfield-host-move';
/** Automatic moves an installation tries; after that it waits for an operator (docs: Updating > Host move). */
export const MAX_AUTOMATIC_HOST_MOVES = 3;
/** Between automatic tries after a move went back. */
const HOST_MOVE_RETRY_AFTER_MS = 6 * 60 * 60_000;
/** The app must have run this long: install.sh and the update sidecar finish their health checks first. */
const MIN_UPTIME_MS = 2 * 60_000;
const CHECK_INTERVAL_MS = 60_000;

export interface HostMoveRecord {
  attempts: number;
  lastStartedAt: string | null;
}

export interface HostMoveLaunchInput {
  production: boolean;
  composeDir: string | null;
  composeProject: string | null;
  databaseUrl: string;
  uptimeMs: number;
  /** An Opfield update attempt is on record (its sidecar may still roll it back), or an update or relay update runs. */
  updateBusy: boolean;
  /** An update sidecar container is still running. */
  sidecarRunning: boolean;
  /** State of the `opfield-host-move` container, when there is one. */
  moveContainer: 'running' | 'exited' | null;
  record: HostMoveRecord;
  now: number;
}

export type HostMoveLaunchDecision =
  | { launch: false; reason: string; removeFinished?: boolean; moved?: true }
  | { launch: true; retry: boolean; removeContainer: boolean };

/** Whether the installation still uses (part of) the layout of the releases before 2.12.1. */
export function hasLegacyLayout(input: { composeDir: string; composeProject: string; databaseUrl: string }): boolean {
  return (
    path.basename(input.composeDir) === LEGACY_INSTALL_DIR_NAME ||
    input.composeProject !== OPFIELD_COMPOSE_PROJECT ||
    databaseIdentity(input.databaseUrl)?.database !== OPFIELD_DATABASE
  );
}

export function hostMoveLaunchDecision(input: HostMoveLaunchInput): HostMoveLaunchDecision {
  if (!input.production) return { launch: false, reason: 'not a production installation' };
  if (!input.composeDir || !input.composeProject) return { launch: false, reason: 'not a Compose installation' };
  if (
    !hasLegacyLayout({
      composeDir: input.composeDir,
      composeProject: input.composeProject,
      databaseUrl: input.databaseUrl,
    })
  ) {
    // The move that got it there left its container behind when it ended.
    return {
      launch: false,
      reason: 'the installation has the Opfield layout',
      // Nothing waits: there is no move to make.
      moved: true,
      ...(input.moveContainer === 'exited' ? { removeFinished: true } : {}),
    };
  }
  if (input.moveContainer === 'running') return { launch: false, reason: 'a host move is running' };
  if (input.updateBusy || input.sidecarRunning) return { launch: false, reason: 'an update has not settled yet' };
  if (input.uptimeMs < MIN_UPTIME_MS) return { launch: false, reason: 'the app started moments ago' };
  if (input.record.attempts >= MAX_AUTOMATIC_HOST_MOVES) {
    return { launch: false, reason: `the move went back ${input.record.attempts} times; it waits for an operator` };
  }
  const last = input.record.lastStartedAt ? Date.parse(input.record.lastStartedAt) : Number.NaN;
  if (input.record.attempts > 0 && Number.isFinite(last) && input.now - last < HOST_MOVE_RETRY_AFTER_MS) {
    return { launch: false, reason: 'the last move went back recently' };
  }
  return { launch: true, retry: input.record.attempts > 0, removeContainer: input.moveContainer === 'exited' };
}

export interface HostMoveLauncherDeps {
  db: DrizzleClient;
  docker: DockerService;
  env: Env;
  /** An update is on record or running; the move waits for it. */
  updateBusy(): Promise<boolean>;
  /** Whether an update sidecar container still runs. */
  sidecarRunning(): Promise<boolean>;
  /** Holds new orchestration work and waits for running work before the app stops; resolves when it may stop. */
  quiesce(): Promise<void>;
  /** Releases the hold when the launch did not happen. */
  release(): void;
}

/**
 * Starts the host move (foundation/host-move.ts) once an update to this release has settled: no update attempt on
 * record, no sidecar left, the app up for a while. The move stops this app, so it runs in its own container.
 */
/** The container that runs the host move, from the app's own image. */
export function hostMoveContainerConfig(input: {
  image: string;
  composeDir: string;
  composeProject: string;
  network: string;
  retry: boolean;
  parent: string;
  sandbox: string;
}): DockerCreateContainerConfig {
  return {
    Image: input.image,
    Cmd: [
      'node',
      'dist/cli/host-move.js',
      '--dir',
      input.composeDir,
      '--project',
      input.composeProject,
      '--network',
      input.network,
      ...(input.retry ? ['--retry'] : []),
    ],
    Labels: { [HOST_MOVE_ROLE_LABEL]: HOST_MOVE_ROLE },
    // The app image's healthcheck probes the app's HTTP port, which the move does not serve: it would read unhealthy.
    Healthcheck: { Test: ['NONE'] },
    HostConfig: {
      Binds: [
        '/var/run/docker.sock:/var/run/docker.sock',
        `${input.parent}:${input.parent}`,
        `${input.sandbox}:${input.sandbox}`,
      ],
      NetworkMode: 'none',
      // A crash or reboot restarts it; it resumes the recorded step and turns this off when it ends.
      RestartPolicy: { Name: 'unless-stopped' },
    },
  };
}

export class HostMoveLauncher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private watcher: ReturnType<typeof setInterval> | null = null;
  private checking = false;
  private launched = false;
  private lastReason = '';
  private readonly startedAt = Date.now();

  constructor(private readonly deps: HostMoveLauncherDeps) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.check(), CHECK_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Stops every timer (process shutdown). */
  dispose(): void {
    this.stop();
    if (this.watcher) clearInterval(this.watcher);
    this.watcher = null;
  }

  /** True while this process has handed over to a move it started. */
  isMoving(): boolean {
    return this.launched;
  }

  async check(): Promise<void> {
    if (this.checking || this.launched) return;
    this.checking = true;
    try {
      await this.checkOnce();
    } catch (error) {
      logger.warn('Could not check whether the installation should move to the Opfield layout', {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.checking = false;
    }
  }

  private async checkOnce(): Promise<void> {
    const { docker, env } = this.deps;
    if (env.NODE_ENV !== 'production') return;
    const self = await docker.inspectSelf();
    const labels = self.Config.Labels ?? {};
    const composeDir = composeDirectoryOf(env, labels);
    const composeProject = labels['com.docker.compose.project'] ?? null;
    const moveContainer = await docker.inspectContainerDetails(HOST_MOVE_CONTAINER_NAME);
    const decision = hostMoveLaunchDecision({
      production: true,
      composeDir,
      composeProject,
      databaseUrl: env.DATABASE_URL,
      uptimeMs: Date.now() - this.startedAt,
      updateBusy: await this.deps.updateBusy(),
      sidecarRunning: await this.deps.sidecarRunning(),
      moveContainer: moveContainer ? (moveContainer.State.Running ? 'running' : 'exited') : null,
      record: await this.readRecord(),
      now: Date.now(),
    });
    if (!decision.launch) {
      if (decision.removeFinished) {
        await docker.removeContainer(HOST_MOVE_CONTAINER_NAME);
        logger.info('Removed the container of the finished move to the Opfield layout');
      }
      if (decision.reason !== this.lastReason) {
        this.lastReason = decision.reason;
        if (decision.moved) logger.debug('No move to the Opfield layout is needed', { reason: decision.reason });
        else logger.info('The move to the Opfield layout waits', { reason: decision.reason });
      }
      return;
    }
    if (!composeDir || !composeProject || !/^\/[a-zA-Z0-9/_.-]+$/.test(composeDir)) return;
    const network = self.HostConfig?.NetworkMode;
    if (!network || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(network)) {
      logger.warn('The move to the Opfield layout needs the app on its Compose network', { network });
      return;
    }

    await this.deps.quiesce();
    try {
      if (decision.removeContainer) await docker.removeContainer(HOST_MOVE_CONTAINER_NAME);
      const record = await this.readRecord();
      await this.writeRecord({ attempts: record.attempts + 1, lastStartedAt: new Date().toISOString() });
      const parent = path.dirname(composeDir);
      const sandbox = DEFAULT_SANDBOX_WORKSPACE_DIR;
      await docker.createContainer(
        hostMoveContainerConfig({
          image: self.Config.Image,
          composeDir,
          composeProject,
          network,
          retry: decision.retry,
          parent,
          sandbox,
        }),
        HOST_MOVE_CONTAINER_NAME
      );
      await docker.startContainer(HOST_MOVE_CONTAINER_NAME);
      this.launched = true;
      this.stop();
      this.watchMove();
      logger.info('Started the move to the Opfield layout; Opfield restarts in a minute', {
        from: composeDir,
        to: hostMoveNewDir(composeDir),
        project: `${composeProject} -> ${OPFIELD_COMPOSE_PROJECT}`,
      });
    } catch (error) {
      this.deps.release();
      // A container of that name appeared meanwhile: install.sh started the same move.
      if (error instanceof Error && /\(409\)/.test(error.message)) {
        logger.info('Another process started the move to the Opfield layout');
        this.launched = true;
        this.stop();
        this.watchMove();
        return;
      }
      throw error;
    }
  }

  /**
   * The move stops this app once it has planned. When its container ends while this app still runs, it changed
   * nothing (it could not plan, or the installation needed no move): release the hold and keep checking.
   */
  private watchMove(): void {
    if (this.watcher) return;
    this.watcher = setInterval(() => {
      void this.deps.docker
        .inspectContainerDetails(HOST_MOVE_CONTAINER_NAME)
        .then((container) => {
          if (container?.State.Running) return;
          if (this.watcher) clearInterval(this.watcher);
          this.watcher = null;
          this.launched = false;
          this.deps.release();
          logger.warn('The move to the Opfield layout ended without restarting Opfield', {
            container: HOST_MOVE_CONTAINER_NAME,
          });
          this.start();
        })
        .catch(() => undefined);
    }, 10_000);
    this.watcher.unref?.();
  }

  private async readRecord(): Promise<HostMoveRecord> {
    const [row] = await this.deps.db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, HOST_MOVE_SETTING_KEY))
      .limit(1);
    const value = (row?.value ?? {}) as Partial<HostMoveRecord>;
    return {
      attempts: typeof value.attempts === 'number' ? value.attempts : 0,
      lastStartedAt: typeof value.lastStartedAt === 'string' ? value.lastStartedAt : null,
    };
  }

  private async writeRecord(record: HostMoveRecord): Promise<void> {
    await this.deps.db
      .insert(settings)
      .values({ key: HOST_MOVE_SETTING_KEY, value: record, updatedAt: new Date() })
      .onConflictDoUpdate({ target: settings.key, set: { value: record, updatedAt: new Date() } });
  }
}
