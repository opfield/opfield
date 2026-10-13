import type { Env } from '@/config/env.js';
import { LEGACY_MANAGED_SERVICE_LABEL, MANAGED_SERVICE_LABEL } from '@/foundation/opfield-names.js';
import type { DockerContainerEvent, DockerContainerFullInspect, DockerService } from './docker.service.js';
import { DOCKER_COMPOSE_CLI_IMAGE_REF } from './update.service.js';

export type RelayRecoverySafetyReason = 'unexpected_image' | 'docker_unavailable' | 'ownership_unverified';

export class RelayRecoverySafetyError extends Error {
  constructor(
    readonly reason: RelayRecoverySafetyReason,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = 'RelayRecoverySafetyError';
  }
}

export type RelayRecoveryAction = 'start' | 'restart' | 'compose_up';
/**
 * `superseded`: the relay container changed between the observation recovery decided on and the
 * moment it would have acted (someone else started or stopped it), so nothing was done.
 */
export type RelayRecoveryOutcome = RelayRecoveryAction | 'superseded';
export type RelayStartupAction = 'already_running' | 'start' | 'compose_up' | 'recreate';

/** What Docker reports for the owned relay container; read-only. */
export interface RelayContainerObservation {
  id: string;
  running: boolean;
  /** Docker's restart policy is between a crash and the next start. */
  restarting?: boolean;
  /** Docker's State.StartedAt of the current run, or null when unknown. */
  startedAt: string | null;
  /** Docker's State.FinishedAt of the last run, or null when unknown. */
  finishedAt?: string | null;
  stopTimeoutSeconds?: number | null;
  /** Lifecycle events Docker recorded for the container in the window asked for, oldest first. */
  events?: DockerContainerEvent[];
}

interface RelayOwnership {
  container: DockerContainerFullInspect | null;
  composeProject: string;
  composeWorkingDir: string;
}

/** A Docker API call that does not answer must not hang Opfield start-up or a recovery cycle. */
export const RELAY_DOCKER_ACTION_TIMEOUT_MS = 60_000;
/** Compose may pull and recreate the relay; it gets longer. */
export const RELAY_COMPOSE_TIMEOUT_MS = 5 * 60_000;
const SAFE_PROJECT = /^[a-zA-Z0-9_-]+$/;
const SAFE_ABSOLUTE_PATH = /^\/[a-zA-Z0-9/_.-]+$/;

export class RelayDockerRecoveryService {
  constructor(
    private readonly docker: Pick<
      DockerService,
      | 'listContainersByLabel'
      | 'inspectContainer'
      | 'inspectSelf'
      | 'imageExists'
      | 'startContainer'
      | 'restartContainer'
      | 'runOneShot'
      | 'listContainerEvents'
    >,
    private readonly env: Pick<
      Env,
      'COMPOSE_PROJECT_DIR' | 'OPFIELD_RELAY_MANAGED' | 'OPFIELD_RELAY_IMAGE_REF' | 'OPFIELD_RELAY_SERVICE_NAME'
    >
  ) {}

  setExpectedImage(imageRef: string): void {
    this.env.OPFIELD_RELAY_IMAGE_REF = imageRef;
  }

  /**
   * Starts, restarts or recreates the owned relay. With `decidedOn`, the observation recovery based
   * its decision on, it first checks that the container is still in that state: one another actor
   * started, stopped or replaced meanwhile is left alone (`superseded`), since acting on it would
   * start the relay a second time.
   */
  async recover(decidedOn?: RelayContainerObservation | null): Promise<RelayRecoveryOutcome> {
    const expectedImage = this.expectedImage();
    let ownership: RelayOwnership;
    try {
      ownership = await this.runDockerAction(() => this.inspectOwnership());
    } catch (error) {
      if (error instanceof RelayRecoverySafetyError) throw error;
      throw new RelayRecoverySafetyError('docker_unavailable', 'Docker ownership inspection failed', {
        cause: error instanceof Error ? error : undefined,
      });
    }

    if (decidedOn !== undefined && changedSince(decidedOn, ownership.container)) return 'superseded';

    if (ownership.container) {
      this.assertExpectedImage(ownership.container, expectedImage);
      if (!ownership.container.State.Running) {
        await this.runDockerAction(() => this.docker.startContainer(ownership.container!.Id));
        return 'start';
      }
      await this.runDockerAction(() => this.docker.restartContainer(ownership.container!.Id, 10));
      return 'restart';
    }

    await this.composeUp(ownership, expectedImage, false);
    return 'compose_up';
  }

  /**
   * Reads the owned relay container without acting on it, so recovery can tell a relay someone
   * else just started (an operator, Docker's restart policy) from one that is really gone.
   */
  async inspectRelay(eventsSinceMs?: number): Promise<RelayContainerObservation | null> {
    const { container } = await this.runDockerAction(() => this.inspectOwnership());
    if (!container) return null;
    let events: DockerContainerEvent[] | undefined;
    if (eventsSinceMs !== undefined) {
      // Only a hint: without it recovery still sees the container's own state.
      events = await this.runDockerAction(() =>
        this.docker.listContainerEvents(container.Id, eventsSinceMs, Date.now())
      ).catch(() => undefined);
    }
    return {
      id: container.Id,
      running: container.State?.Running === true,
      restarting: container.State?.Restarting === true,
      startedAt: container.State?.StartedAt || null,
      finishedAt: container.State?.FinishedAt || null,
      stopTimeoutSeconds: typeof container.Config?.StopTimeout === 'number' ? container.Config.StopTimeout : null,
      ...(events ? { events } : {}),
    };
  }

  async ensureStarted(): Promise<RelayStartupAction> {
    const expectedImage = this.expectedImage();
    const ownership = await this.runDockerAction(() => this.inspectOwnership());
    if (ownership.container) {
      this.assertExpectedImage(ownership.container, expectedImage);
      if (ownership.container.State.Running) return 'already_running';
      await this.runDockerAction(() => this.docker.startContainer(ownership.container!.Id));
      return 'start';
    }
    await this.composeUp(ownership, expectedImage, false);
    return 'compose_up';
  }

  async recreateExpected(): Promise<RelayStartupAction> {
    const expectedImage = this.expectedImage();
    const ownership = await this.runDockerAction(() => this.inspectOwnership());
    await this.composeUp(ownership, expectedImage, true);
    return 'recreate';
  }

  private expectedImage(): string {
    if (!this.env.OPFIELD_RELAY_MANAGED) {
      throw new RelayRecoverySafetyError('ownership_unverified', 'Relay is not installer-managed');
    }
    const expectedImage = this.env.OPFIELD_RELAY_IMAGE_REF;
    if (!expectedImage || !/@sha256:[a-f0-9]{64}$/.test(expectedImage)) {
      throw new RelayRecoverySafetyError('unexpected_image', 'Expected relay image digest is unavailable');
    }
    return expectedImage;
  }

  private async inspectOwnership(): Promise<RelayOwnership> {
    const app = await this.docker.inspectSelf();
    const appOwnership = this.validateLabels(app, 'app');
    const configuredWorkingDir = this.env.COMPOSE_PROJECT_DIR;
    if (configuredWorkingDir && !SAFE_ABSOLUTE_PATH.test(configuredWorkingDir)) {
      throw new RelayRecoverySafetyError('ownership_unverified', 'Configured Compose project directory is invalid');
    }
    const composeWorkingDir = configuredWorkingDir ?? appOwnership.composeWorkingDir;
    const matches = new Map<string, { Id: string }>();
    // legacy-name: a relay created before 2.12.1 keeps its label until it is recreated.
    for (const label of [MANAGED_SERVICE_LABEL, LEGACY_MANAGED_SERVICE_LABEL]) {
      for (const item of await this.docker.listContainersByLabel(`${label}=${this.env.OPFIELD_RELAY_SERVICE_NAME}`)) {
        matches.set(item.Id, item);
      }
    }
    const owned: Array<{ container: DockerContainerFullInspect; ownership: Omit<RelayOwnership, 'container'> }> = [];
    for (const match of matches.values()) {
      const container = (await this.docker.inspectContainer(match.Id)) as DockerContainerFullInspect;
      const ownership = this.validateLabels(container, this.env.OPFIELD_RELAY_SERVICE_NAME);
      if (
        ownership.composeProject === appOwnership.composeProject &&
        (configuredWorkingDir || ownership.composeWorkingDir === appOwnership.composeWorkingDir)
      ) {
        owned.push({ container, ownership });
      }
    }
    if (owned.length > 1) {
      // An interrupted Compose recreate leaves a renamed, stopped copy of the relay behind. Such a
      // leftover must not block recovery: act on the one running relay, and with none running let
      // Compose reconcile the service back to a single container. Two running relays stay ambiguous.
      const running = owned.filter(({ container }) => container.State?.Running === true);
      if (running.length > 1) {
        throw new RelayRecoverySafetyError(
          'ownership_unverified',
          'Multiple running relay containers belong to this deployment'
        );
      }
      const [active] = running;
      return {
        container: active?.container ?? null,
        composeProject: (active ?? owned[0]!).ownership.composeProject,
        composeWorkingDir,
      };
    }
    if (owned.length === 1) {
      return {
        container: owned[0]!.container,
        composeProject: owned[0]!.ownership.composeProject,
        composeWorkingDir,
      };
    }
    return { container: null, composeProject: appOwnership.composeProject, composeWorkingDir };
  }

  private assertExpectedImage(container: DockerContainerFullInspect, expectedImage: string): void {
    if (container.Config.Image !== expectedImage) {
      throw new RelayRecoverySafetyError('unexpected_image', 'Relay container image does not match expected digest');
    }
  }

  private async composeUp(ownership: RelayOwnership, expectedImage: string, forceRecreate: boolean): Promise<void> {
    const [hasRelayImage, hasComposeHelper] = await Promise.all([
      this.runDockerAction(() => this.docker.imageExists(expectedImage)),
      this.runDockerAction(() => this.docker.imageExists(DOCKER_COMPOSE_CLI_IMAGE_REF)),
    ]);
    if (!hasRelayImage) {
      throw new RelayRecoverySafetyError('unexpected_image', 'Expected relay image is not present locally');
    }
    if (!hasComposeHelper) {
      throw new RelayRecoverySafetyError('docker_unavailable', 'Pinned Compose helper image is not present locally');
    }
    const composeFile = `${ownership.composeWorkingDir}/docker-compose.yml`;
    const result = await this.runDockerAction(
      () =>
        this.docker.runOneShot({
          Image: DOCKER_COMPOSE_CLI_IMAGE_REF,
          Cmd: [
            'docker',
            'compose',
            '--project-name',
            ownership.composeProject,
            '--project-directory',
            ownership.composeWorkingDir,
            '-f',
            composeFile,
            'up',
            '-d',
            ...(forceRecreate ? ['--force-recreate'] : []),
            this.env.OPFIELD_RELAY_SERVICE_NAME,
          ],
          HostConfig: {
            // Compose persists its working directory in container ownership
            // labels. Mounting the project at a synthetic /project path makes
            // the recreated relay look foreign to the app on the next probe.
            Binds: [
              `${ownership.composeWorkingDir}:${ownership.composeWorkingDir}`,
              '/var/run/docker.sock:/var/run/docker.sock',
            ],
          },
        }),
      RELAY_COMPOSE_TIMEOUT_MS
    );
    if (result.exitCode !== 0) {
      throw new RelayRecoverySafetyError('ownership_unverified', 'Compose helper could not start the relay service');
    }
  }

  private validateLabels(container: DockerContainerFullInspect, service: string) {
    const labels = container.Config.Labels ?? {};
    const composeService = labels['com.docker.compose.service'];
    const composeProject = labels['com.docker.compose.project'];
    const composeWorkingDir = labels['com.docker.compose.project.working_dir'];
    const managedService = labels[MANAGED_SERVICE_LABEL] ?? labels[LEGACY_MANAGED_SERVICE_LABEL];
    if (
      composeService !== service ||
      managedService !== service ||
      !composeProject ||
      !SAFE_PROJECT.test(composeProject) ||
      !composeWorkingDir ||
      !SAFE_ABSOLUTE_PATH.test(composeWorkingDir)
    ) {
      throw new RelayRecoverySafetyError('ownership_unverified', 'Compose relay ownership labels are invalid');
    }
    return { composeProject, composeWorkingDir };
  }

  private async runDockerAction<T>(action: () => Promise<T>, timeoutMs = RELAY_DOCKER_ACTION_TIMEOUT_MS): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        action(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Docker did not answer within ${timeoutMs} ms`)), timeoutMs);
          timer.unref?.();
        }),
      ]);
    } catch (error) {
      if (error instanceof RelayRecoverySafetyError) throw error;
      throw new RelayRecoverySafetyError('docker_unavailable', 'Docker relay recovery action failed', {
        cause: error instanceof Error ? error : undefined,
      });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

/** Whether the relay container is no longer the run recovery observed when it decided to act. */
function changedSince(
  decidedOn: RelayContainerObservation | null,
  current: DockerContainerFullInspect | null
): boolean {
  if (!decidedOn || !current) return (decidedOn === null) !== (current === null);
  return (
    decidedOn.id !== current.Id ||
    decidedOn.running !== (current.State?.Running === true) ||
    (decidedOn.restarting ?? false) !== (current.State?.Restarting === true) ||
    (decidedOn.startedAt ?? null) !== (current.State?.StartedAt || null)
  );
}
