import { DOCKER_COMPOSE_CLI_IMAGE_REF } from '@/config/docker-compose-cli-image.js';
import {
  REGISTRY_FILESYSTEM_ROOT,
  type RegistryS3Settings,
  type RegistryStorageBackend,
} from '@/foundation/registry-storage.js';
import { composeDirectoryOf } from '@/lib/compose-directory.js';
import { AppError } from '@/middleware/error-handler.js';
import type { DockerContainerDetails, DockerService } from '@/services/docker.service.js';

/**
 * The Docker side of the registry storage switch: one-off containers of the running Opfield image copy data and
 * rewrite .env and docker-compose.yml, and the pinned Compose helper recreates the registry service from them, the
 * way updates and relay recovery do.
 */

const SAFE_PROJECT = /^[a-zA-Z0-9_-]+$/;
const SAFE_ABSOLUTE_PATH = /^\/[a-zA-Z0-9/_.-]+$/;
const SAFE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
const CLI = ['node', 'dist/cli/registry-storage.js'];
const HOST_STEP_TIMEOUT_MS = 5 * 60_000;
/** A copy of many gigabytes may take long; it is bounded all the same. */
const COPY_TIMEOUT_MS = 6 * 60 * 60_000;
const READY_TIMEOUT_MS = 3 * 60_000;

type HostDocker = Pick<
  DockerService,
  'inspectSelf' | 'inspectManagedRegistry' | 'runOneShot' | 'imageExists' | 'pullImageRef'
>;

export interface RegistryStorageHostContext {
  appImage: string;
  composeDir: string;
  composeProject: string;
  /** The registry's network, where the bucket endpoint resolves as the registry sees it. */
  network: string;
  /** Docker volume (or host path) mounted at the registry's data directory. */
  dataSource: string;
}

function lastJsonLine(output: string): Record<string, unknown> | null {
  const lines = output.trim().split('\n').reverse();
  for (const line of lines) {
    const start = line.indexOf('{');
    if (start < 0) continue;
    try {
      return JSON.parse(line.slice(start)) as Record<string, unknown>;
    } catch {
      // A log line, not the result.
    }
  }
  return null;
}

export class RegistryStorageHost {
  constructor(
    private readonly docker: HostDocker,
    private readonly composeProjectDir: string | undefined
  ) {}

  async registry(): Promise<DockerContainerDetails> {
    return this.docker.inspectManagedRegistry();
  }

  /** What the switch needs to know about the installation; refused when the registry is not installer-managed. */
  async context(): Promise<RegistryStorageHostContext> {
    const unmanaged = (reason: string) =>
      new AppError(
        409,
        'REGISTRY_STORAGE_UNMANAGED',
        `The registry storage can be changed only on an installer-managed Opfield host: ${reason}`
      );
    const [self, registry] = await Promise.all([
      this.docker.inspectSelf().catch(() => null),
      this.docker.inspectManagedRegistry().catch(() => null),
    ]);
    if (!self) throw unmanaged('Opfield does not run in a Docker container');
    if (!registry) throw unmanaged('the registry container was not found');
    const labels = self.Config.Labels ?? {};
    const composeDir = composeDirectoryOf({ COMPOSE_PROJECT_DIR: this.composeProjectDir }, labels);
    const composeProject = labels['com.docker.compose.project'];
    if (!composeDir || !SAFE_ABSOLUTE_PATH.test(composeDir)) throw unmanaged('the Compose directory is unknown');
    if (!composeProject || !SAFE_PROJECT.test(composeProject)) throw unmanaged('the Compose project is unknown');
    if (registry.Config.Labels?.['com.docker.compose.project'] !== composeProject) {
      throw unmanaged('the registry belongs to another Compose project');
    }
    const network = registry.HostConfig?.NetworkMode;
    if (!network || !SAFE_NAME.test(network)) throw unmanaged('the registry network is unknown');
    const data = registry.Mounts?.find((mount) => mount.Destination === REGISTRY_FILESYSTEM_ROOT);
    const dataSource = data?.Type === 'volume' ? data.Name : data?.Source;
    if (!dataSource || !(SAFE_NAME.test(dataSource) || SAFE_ABSOLUTE_PATH.test(dataSource))) {
      throw unmanaged('the registry data volume was not found');
    }
    return { appImage: self.Config.Image, composeDir, composeProject, network, dataSource };
  }

  private async runCli(
    context: RegistryStorageHostContext,
    args: string[],
    options: { env?: string[]; binds: string[]; network?: string; timeoutMs: number }
  ): Promise<Record<string, unknown>> {
    const result = await this.docker.runOneShot(
      {
        Image: context.appImage,
        Cmd: [...CLI, ...args],
        Env: options.env ?? [],
        Labels: { 'net.opfield.registry-storage': args[0]! },
        HostConfig: { Binds: options.binds, ...(options.network ? { NetworkMode: options.network } : {}) },
      },
      options.timeoutMs
    );
    const parsed = lastJsonLine(result.output);
    if (result.exitCode !== 0 || !parsed || parsed.ok !== true) {
      const reason = typeof parsed?.error === 'string' ? parsed.error : `exit code ${result.exitCode}`;
      throw new Error(`Registry storage step ${args[0]} failed: ${reason}`);
    }
    return parsed;
  }

  async copyToBucket(context: RegistryStorageHostContext, target: RegistryS3Settings) {
    const result = await this.runCli(context, ['copy-to-bucket', '--volume', REGISTRY_FILESYSTEM_ROOT], {
      env: [`OPFIELD_REGISTRY_STORAGE_S3=${JSON.stringify(target)}`],
      binds: [`${context.dataSource}:${REGISTRY_FILESYSTEM_ROOT}:ro`],
      network: context.network,
      timeoutMs: COPY_TIMEOUT_MS,
    });
    return { files: Number(result.files ?? 0), bytes: Number(result.bytes ?? 0) };
  }

  async copyToVolume(context: RegistryStorageHostContext, source: RegistryS3Settings) {
    const result = await this.runCli(context, ['copy-to-volume', '--volume', REGISTRY_FILESYSTEM_ROOT], {
      env: [`OPFIELD_REGISTRY_STORAGE_S3=${JSON.stringify(source)}`],
      binds: [`${context.dataSource}:${REGISTRY_FILESYSTEM_ROOT}`],
      network: context.network,
      timeoutMs: COPY_TIMEOUT_MS,
    });
    return { files: Number(result.files ?? 0), bytes: Number(result.bytes ?? 0) };
  }

  /** Frees the volume once the registry runs on the bucket, which holds every image now. */
  async clearVolume(context: RegistryStorageHostContext): Promise<void> {
    await this.runCli(context, ['clear-volume', '--volume', REGISTRY_FILESYSTEM_ROOT], {
      binds: [`${context.dataSource}:${REGISTRY_FILESYSTEM_ROOT}`],
      network: 'none',
      timeoutMs: HOST_STEP_TIMEOUT_MS,
    });
  }

  /** Writes the target storage into .env and docker-compose.yml, keeping the previous files in backup folder `backup`. */
  async applyHostFiles(
    context: RegistryStorageHostContext,
    target: RegistryS3Settings | null,
    backup: string
  ): Promise<void> {
    await this.runCli(context, ['apply', '--host-dir', '/host', '--backup', backup], {
      env: [
        `OPFIELD_REGISTRY_STORAGE_TARGET=${JSON.stringify({ backend: target ? 's3' : 'filesystem' })}`,
        ...(target ? [`OPFIELD_REGISTRY_STORAGE_S3=${JSON.stringify(target)}`] : []),
      ],
      binds: [`${context.composeDir}:/host`],
      network: 'none',
      timeoutMs: HOST_STEP_TIMEOUT_MS,
    });
  }

  /** The storage .env selects and the one the registry block of docker-compose.yml runs on. */
  async hostStorage(
    context: RegistryStorageHostContext
  ): Promise<{ env: RegistryStorageBackend; compose: RegistryStorageBackend }> {
    const result = await this.runCli(context, ['status', '--host-dir', '/host'], {
      binds: [`${context.composeDir}:/host:ro`],
      network: 'none',
      timeoutMs: HOST_STEP_TIMEOUT_MS,
    });
    const backend = (value: unknown): RegistryStorageBackend => (value === 's3' ? 's3' : 'filesystem');
    return { env: backend(result.env), compose: backend(result.compose) };
  }

  /** Makes the registry block of docker-compose.yml follow the storage .env selects. */
  async syncCompose(context: RegistryStorageHostContext): Promise<void> {
    await this.runCli(context, ['sync-compose', '--host-dir', '/host'], {
      binds: [`${context.composeDir}:/host`],
      network: 'none',
      timeoutMs: HOST_STEP_TIMEOUT_MS,
    });
  }

  /** Removes what an interrupted copy onto the volume left beside the registry data. */
  async cleanImport(context: RegistryStorageHostContext): Promise<void> {
    await this.runCli(context, ['clean-import', '--volume', REGISTRY_FILESYSTEM_ROOT], {
      binds: [`${context.dataSource}:${REGISTRY_FILESYSTEM_ROOT}`],
      network: 'none',
      timeoutMs: HOST_STEP_TIMEOUT_MS,
    });
  }

  async restoreHostFiles(context: RegistryStorageHostContext, backup: string): Promise<void> {
    await this.runCli(context, ['restore', '--host-dir', '/host', '--backup', backup], {
      binds: [`${context.composeDir}:/host`],
      network: 'none',
      timeoutMs: HOST_STEP_TIMEOUT_MS,
    });
  }

  private async compose(context: RegistryStorageHostContext, args: string[]): Promise<void> {
    if (!(await this.docker.imageExists(DOCKER_COMPOSE_CLI_IMAGE_REF))) {
      await this.docker.pullImageRef(DOCKER_COMPOSE_CLI_IMAGE_REF);
    }
    const result = await this.docker.runOneShot(
      {
        Image: DOCKER_COMPOSE_CLI_IMAGE_REF,
        Cmd: [
          'docker',
          'compose',
          '--project-name',
          context.composeProject,
          '--project-directory',
          context.composeDir,
          '-f',
          `${context.composeDir}/docker-compose.yml`,
          ...args,
        ],
        // A one-off of this process (runOneShot labels it): cleanups of finished update sidecars, which look alike,
        // leave it alone.
        Labels: { 'net.opfield.registry-storage': `compose-${args[0]}` },
        // Compose keeps its working directory in the container labels: the project is mounted at its own path.
        HostConfig: {
          Binds: [`${context.composeDir}:${context.composeDir}`, '/var/run/docker.sock:/var/run/docker.sock'],
        },
      },
      HOST_STEP_TIMEOUT_MS
    );
    if (result.exitCode !== 0) {
      throw new Error(`docker compose ${args[0]} failed: ${result.output.trim().split('\n').slice(-3).join(' ')}`);
    }
  }

  /**
   * Starts the registry as docker-compose.yml defines it now: Compose recreates it only when the running one differs
   * (an older release's definition), then waits until it serves.
   */
  async applyRegistryDefinition(context: RegistryStorageHostContext, registryUrl: string): Promise<void> {
    await this.compose(context, ['config', '--quiet']);
    await this.compose(context, ['up', '-d', '--no-deps', 'registry']);
    await this.waitUntilReady(registryUrl);
  }

  /** Validates the rewritten files, recreates the registry from them and waits until it serves. */
  async recreateRegistry(context: RegistryStorageHostContext, registryUrl: string): Promise<void> {
    await this.compose(context, ['config', '--quiet']);
    await this.compose(context, ['up', '-d', '--no-deps', '--force-recreate', 'registry']);
    await this.waitUntilReady(registryUrl);
  }

  private async waitUntilReady(registryUrl: string): Promise<void> {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    let last = 'the registry did not start';
    while (Date.now() < deadline) {
      const registry = await this.docker.inspectManagedRegistry().catch(() => null);
      const health = registry?.State.Health?.Status;
      if (registry?.State.Running && (health === undefined || health === 'healthy')) {
        try {
          const response = await fetch(new URL('/v2/', registryUrl), { signal: AbortSignal.timeout(5_000) });
          await response.body?.cancel();
          if (response.ok || response.status === 401) return;
          last = `the registry answered ${response.status}`;
        } catch (error) {
          last = (error as Error).message;
        }
      } else if (registry) {
        last = `the registry is ${health ?? registry.State.Status}`;
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    throw new Error(`The registry did not become ready on the new storage: ${last}`);
  }
}
