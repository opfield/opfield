import { createReadStream, createWriteStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import http from 'node:http';
import { type Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { LEGACY_MANAGED_SERVICE_LABEL, MANAGED_SERVICE_LABEL } from '@/foundation/opfield-names.js';
import { type RegistryStorageBackend, registryStorageFromContainerEnv } from '@/foundation/registry-storage.js';
import { createChildLogger } from '@/lib/logger.js';

const logger = createChildLogger('DockerService');

const API_VERSION = '/v1.46';
/**
 * A request without its own timeout would inherit Node's global agent socket timeout (5 s), which
 * cuts off a call while Docker still works on it: a container create that unpacks a freshly pulled
 * image with the containerd image store, or a stop waiting for a graceful shutdown. Such requests
 * get this idle bound instead; lifecycle calls that wait on Docker set a timeout covering the wait.
 */
export const DOCKER_REQUEST_DEFAULT_TIMEOUT_MS = 5 * 60_000;
const CONTAINER_START_TIMEOUT_MS = 60_000;
const stopRequestTimeoutMs = (timeoutSeconds: number) => (Math.max(0, timeoutSeconds) + 30) * 1000;
/** Marks the one-off containers runOneShot starts (helpers of storage switches, restores, measurements). */
export const ONE_SHOT_LABEL = 'net.opfield.one-shot';
/** The process that started a one-off container: only that process reads its output and removes it. */
export const ONE_SHOT_OWNER_LABEL = 'net.opfield.one-shot.owner';
/** One-off helpers of registry storage switches started before they carried ONE_SHOT_LABEL. */
const LEGACY_REGISTRY_STORAGE_LABEL = 'net.opfield.registry-storage';
const ONE_SHOT_OWNER = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
/**
 * A one-off container of another (or an earlier) Opfield process that ended this long ago is a leftover: the process
 * that started it was stopped before it could read the output and remove it.
 */
export const ONE_SHOT_LEFTOVER_AGE_MS = 10 * 60_000;

export class DockerService {
  constructor(
    private readonly socketPath: string,
    private readonly nginxContainerName: string
  ) {}

  /**
   * Execute a command inside a Docker container via the Docker Engine API.
   *
   * 1. POST /containers/{id}/exec  -> create exec instance
   * 2. POST /exec/{id}/start       -> run and capture output
   * 3. GET  /exec/{id}/inspect      -> retrieve exit code
   */
  async execInContainer(containerName: string, command: string[]): Promise<{ exitCode: number; output: string }> {
    logger.debug('Creating exec instance', { containerName, command });

    // Step 1: Create exec instance
    const createRes = await this.request(
      'POST',
      `${API_VERSION}/containers/${encodeURIComponent(containerName)}/exec`,
      {
        Cmd: command,
        AttachStdout: true,
        AttachStderr: true,
      }
    );

    if (createRes.statusCode !== 201) {
      throw new Error(`Docker exec create failed (${createRes.statusCode}): ${createRes.body}`);
    }

    const { Id: execId } = JSON.parse(createRes.body) as { Id: string };

    // Step 2: Start exec and capture output
    const startRes = await this.request('POST', `${API_VERSION}/exec/${execId}/start`, {
      Detach: false,
    });

    if (startRes.statusCode !== 200) {
      throw new Error(`Docker exec start failed (${startRes.statusCode}): ${startRes.body}`);
    }

    // The output stream from Docker may contain multiplexed header frames
    // (8-byte header per frame when AttachStdout + AttachStderr).
    // We strip those headers to get clean text output.
    const output = this.stripDockerStreamHeaders(startRes.bodyRaw);

    // Step 3: Inspect exec to get exit code
    const inspectRes = await this.request('GET', `${API_VERSION}/exec/${execId}/json`);

    if (inspectRes.statusCode !== 200) {
      throw new Error(`Docker exec inspect failed (${inspectRes.statusCode}): ${inspectRes.body}`);
    }

    const { ExitCode } = JSON.parse(inspectRes.body) as { ExitCode: number };

    logger.debug('Exec completed', { containerName, command, exitCode: ExitCode });

    return { exitCode: ExitCode, output };
  }

  async managedRegistryHasRepositories(): Promise<boolean> {
    const registryId = await this.managedRegistryContainerId();
    // A registry on S3 keeps nothing on the volume. Garbage collection then runs only while Opfield tracks build
    // artifacts, which the storage switch copied into the bucket: on an empty bucket it would fail.
    if (await this.managedRegistryOnS3(registryId)) return false;
    const result = await this.execInContainer(registryId, [
      'sh',
      '-c',
      'if [ ! -d /var/lib/registry/docker/registry/v2/repositories ]; then exit 1; fi; find /var/lib/registry/docker/registry/v2/repositories -mindepth 1 -maxdepth 1 -print -quit | grep -q .',
    ]);
    return result.exitCode === 0;
  }

  /**
   * Bytes the managed registry keeps: on its data volume, measured inside the registry container, or in its S3 bucket
   * folder, summed from the object listing (the caller measures every few minutes, not on every read).
   */
  async managedRegistryStorageUsedBytes(): Promise<number> {
    const registryId = await this.managedRegistryContainerId();
    const details = await this.inspectContainerDetails(registryId);
    const storage = registryStorageFromContainerEnv(details?.Config.Env ?? []);
    if (storage.s3) {
      const [{ RegistryS3Client }, { registryBucketUsedBytes }] = await Promise.all([
        import('@/modules/docker/registry-storage/s3-client.js'),
        import('@/modules/docker/registry-storage/registry-storage-copy.js'),
      ]);
      return registryBucketUsedBytes(new RegistryS3Client(storage.s3), storage.s3.rootDirectory);
    }
    const result = await this.execInContainer(registryId, ['sh', '-c', 'du -sk /var/lib/registry | cut -f1']);
    const kibibytes = Number(result.output.trim());
    if (result.exitCode !== 0 || !Number.isSafeInteger(kibibytes) || kibibytes < 0) {
      throw new Error(`Registry storage usage is unavailable (${result.exitCode}): ${result.output.trim()}`);
    }
    return kibibytes * 1024;
  }

  /**
   * The filesystem the managed registry keeps its data on (its volume, on the Opfield host's disk), measured inside
   * the registry container with `df`; null when the registry keeps its data in S3.
   */
  async managedRegistryFilesystem(): Promise<{ totalBytes: number; usedBytes: number; availableBytes: number } | null> {
    const registryId = await this.managedRegistryContainerId();
    if (await this.managedRegistryOnS3(registryId)) return null;
    const result = await this.execInContainer(registryId, ['df', '-kP', '/var/lib/registry']);
    const parsed = parseDfKilobytes(result.output);
    if (result.exitCode !== 0 || !parsed) {
      throw new Error(`Registry filesystem usage is unavailable (${result.exitCode}): ${result.output.trim()}`);
    }
    return parsed;
  }

  /**
   * Removes upload sessions the registry left behind (a push that failed or was cancelled) that are older than
   * `olderThanMinutes`: in filesystem mode from the registry volume (the registry is stopped, or no push can be that
   * old); returns how many were removed. S3: the registry's own upload purging handles them.
   */
  async purgeManagedRegistryUploads(olderThanMinutes: number): Promise<number> {
    const registryId = await this.managedRegistryContainerId();
    if (await this.managedRegistryOnS3(registryId)) return 0;
    const minutes = Math.max(60, Math.floor(olderThanMinutes));
    const result = await this.execInContainer(registryId, [
      'sh',
      '-c',
      `root=/var/lib/registry/docker/registry/v2/repositories; [ -d "$root" ] || exit 0; ` +
        `find "$root" -type d -path '*/_uploads/*' -prune -mmin +${minutes} -print -exec rm -rf {} + | wc -l`,
    ]);
    if (result.exitCode !== 0) {
      throw new Error(`Registry upload cleanup failed (${result.exitCode}): ${result.output.trim()}`);
    }
    const removed = Number(result.output.trim().split(/\s+/).pop());
    return Number.isSafeInteger(removed) ? removed : 0;
  }

  async runManagedRegistryGarbageCollection(dryRun: boolean): Promise<void> {
    const registryId = await this.managedRegistryContainerId();
    const inspected = await this.request('GET', `${API_VERSION}/containers/${registryId}/json`);
    if (inspected.statusCode !== 200) throw new Error(`Registry inspect failed (${inspected.statusCode})`);
    const registry = JSON.parse(inspected.body) as {
      Config?: { Image?: string; Env?: string[]; Entrypoint?: string[] | string | null };
      HostConfig?: { Binds?: string[]; Mounts?: Array<Record<string, unknown>>; NetworkMode?: string };
    };
    // On S3 the collection reads and deletes in the bucket: it needs the registry's network.
    const onS3 = (registry.Config?.Env ?? []).includes('REGISTRY_STORAGE=s3');
    const image = registry.Config?.Image;
    if (!image) throw new Error('Managed registry image is unavailable');
    const temporaryName = `opfield-registry-gc-${process.pid}-${Date.now()}`;
    let temporaryId: string | null = null;
    let registryStopped = false;
    let operationError: unknown;
    let restartError: Error | null = null;
    try {
      const stopped = await this.request('POST', `${API_VERSION}/containers/${registryId}/stop?t=30`);
      if (stopped.statusCode !== 204 && stopped.statusCode !== 304) {
        throw new Error(`Registry stop failed (${stopped.statusCode}): ${stopped.body}`);
      }
      registryStopped = true;
      const args = [
        'garbage-collect',
        ...(dryRun ? ['--dry-run'] : []),
        '--delete-untagged',
        '/etc/distribution/config.yml',
      ];
      const created = await this.request(
        'POST',
        `${API_VERSION}/containers/create?name=${encodeURIComponent(temporaryName)}`,
        {
          Image: image,
          Env: registry.Config?.Env ?? [],
          Entrypoint: registry.Config?.Entrypoint ?? undefined,
          Cmd: args,
          HostConfig: {
            Binds: registry.HostConfig?.Binds ?? [],
            Mounts: registry.HostConfig?.Mounts ?? [],
            NetworkMode: onS3 ? (registry.HostConfig?.NetworkMode ?? 'none') : 'none',
          },
        }
      );
      if (created.statusCode !== 201) {
        throw new Error(`Registry GC container create failed (${created.statusCode}): ${created.body}`);
      }
      temporaryId = (JSON.parse(created.body) as { Id: string }).Id;
      const started = await this.request('POST', `${API_VERSION}/containers/${temporaryId}/start`);
      if (started.statusCode !== 204) throw new Error(`Registry GC container start failed (${started.statusCode})`);
      const waited = await this.request(
        'POST',
        `${API_VERSION}/containers/${temporaryId}/wait?condition=not-running`,
        undefined,
        30 * 60_000
      );
      if (waited.statusCode !== 200) throw new Error(`Registry GC wait failed (${waited.statusCode})`);
      const statusCode = Number((JSON.parse(waited.body) as { StatusCode?: number }).StatusCode ?? 1);
      if (statusCode !== 0) {
        const logs = await this.request(
          'GET',
          `${API_VERSION}/containers/${temporaryId}/logs?stdout=1&stderr=1&tail=100`
        );
        throw new Error(
          `Registry garbage collection failed (${statusCode}): ${this.stripDockerStreamHeaders(logs.bodyRaw)}`
        );
      }
    } catch (error) {
      operationError = error;
    } finally {
      if (temporaryId) {
        await this.request('DELETE', `${API_VERSION}/containers/${temporaryId}?force=1`).catch(() => undefined);
      }
      if (registryStopped) {
        const started = await this.request('POST', `${API_VERSION}/containers/${registryId}/start`).catch(() => null);
        if (!started || (started.statusCode !== 204 && started.statusCode !== 304)) {
          restartError = new Error('Managed registry could not be restarted after garbage collection');
        }
      }
    }
    if (restartError) throw restartError;
    if (operationError) throw operationError;
  }

  async stopManagedRegistry(): Promise<void> {
    const registryId = await this.managedRegistryContainerId();
    const stopped = await this.request('POST', `${API_VERSION}/containers/${registryId}/stop?t=30`);
    if (stopped.statusCode !== 204 && stopped.statusCode !== 304) {
      throw new Error(`Registry stop failed (${stopped.statusCode}): ${stopped.body}`);
    }
  }

  async startManagedRegistry(): Promise<void> {
    const registryId = await this.managedRegistryContainerId();
    const started = await this.request('POST', `${API_VERSION}/containers/${registryId}/start`);
    if (started.statusCode !== 204 && started.statusCode !== 304) {
      throw new Error(`Registry start failed (${started.statusCode}): ${started.body}`);
    }
  }

  async restartManagedRegistry(): Promise<void> {
    await this.stopManagedRegistry();
    await this.startManagedRegistry();
  }

  async recoverManagedRegistryMaintenance(): Promise<void> {
    // legacy-name: gateway-registry-gc- containers left by an update from a release before 2.12.1 — remove once
    // every installation runs 2.12.1+
    const filters = encodeURIComponent(JSON.stringify({ name: ['opfield-registry-gc-', 'gateway-registry-gc-'] }));
    const listed = await this.request('GET', `${API_VERSION}/containers/json?all=1&filters=${filters}`);
    if (listed.statusCode !== 200) throw new Error(`Docker GC container lookup failed (${listed.statusCode})`);
    const containers = JSON.parse(listed.body) as Array<{ Id?: string }>;
    for (const container of containers) {
      if (!container.Id) continue;
      await this.request('DELETE', `${API_VERSION}/containers/${container.Id}?force=1`).catch(() => undefined);
    }
    await this.startManagedRegistry();
  }

  /** Full inspect of the managed registry container: environment, mounts, network and health. */
  async inspectManagedRegistry(): Promise<DockerContainerDetails> {
    const details = await this.inspectContainerDetails(await this.managedRegistryContainerId());
    if (!details) throw new Error('Managed registry container was not found');
    return details;
  }

  /** Where the managed registry keeps its data, read from its environment. */
  async managedRegistryStorageBackend(): Promise<RegistryStorageBackend> {
    const details = await this.inspectContainerDetails(await this.managedRegistryContainerId());
    return registryStorageFromContainerEnv(details?.Config.Env ?? []).backend;
  }

  private async managedRegistryOnS3(registryId: string): Promise<boolean> {
    const details = await this.inspectContainerDetails(registryId);
    return (details?.Config.Env ?? []).includes('REGISTRY_STORAGE=s3');
  }

  private async managedRegistryContainerId(): Promise<string> {
    // legacy-name: a registry created before 2.12.1 keeps its label until the host move recreates it.
    for (const label of [MANAGED_SERVICE_LABEL, LEGACY_MANAGED_SERVICE_LABEL]) {
      const filters = encodeURIComponent(JSON.stringify({ label: [`${label}=registry`] }));
      const listed = await this.request('GET', `${API_VERSION}/containers/json?all=1&filters=${filters}`);
      if (listed.statusCode !== 200) throw new Error(`Docker container lookup failed (${listed.statusCode})`);
      const containers = JSON.parse(listed.body) as Array<{ Id?: string }>;
      const registryId = containers[0]?.Id;
      if (registryId) return registryId;
    }
    throw new Error('Managed registry container was not found');
  }

  /**
   * Low-level helper that sends an HTTP request over the Docker unix socket.
   */
  private request(
    method: string,
    path: string,
    body?: unknown,
    timeoutMs?: number,
    headers: Record<string, string> = {}
  ): Promise<{ statusCode: number; body: string; bodyRaw: Buffer }> {
    const requestTimeoutMs = timeoutMs ?? DOCKER_REQUEST_DEFAULT_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      const payload =
        body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body), 'utf-8');

      const req = http.request(
        {
          socketPath: this.socketPath,
          method,
          path,
          timeout: requestTimeoutMs,
          headers: {
            ...headers,
            ...(payload !== undefined
              ? {
                  ...(!headers['Content-Type'] ? { 'Content-Type': 'application/json' } : {}),
                  'Content-Length': payload.byteLength,
                }
              : {}),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            const rawBuffer = Buffer.concat(chunks);
            resolve({
              statusCode: res.statusCode ?? 0,
              body: rawBuffer.toString('utf-8'),
              bodyRaw: rawBuffer,
            });
          });
          res.on('error', reject);
        }
      );

      req.on('timeout', () => {
        req.destroy(new Error(`Docker API request timed out after ${requestTimeoutMs}ms`));
      });
      req.on('error', reject);

      if (payload !== undefined) req.write(payload);

      req.end();
    });
  }

  /**
   * Streaming variant of {@link request}: response chunks are forwarded to
   * `onChunk` as they arrive instead of being buffered whole. Used for the
   * NDJSON progress stream of image pulls, where buffering would hide all
   * progress until the pull finished.
   */
  private requestStream(
    method: string,
    path: string,
    body: unknown,
    timeoutMs: number | undefined,
    onChunk: (chunk: string) => void
  ): Promise<{ statusCode: number }> {
    const requestTimeoutMs = timeoutMs ?? DOCKER_REQUEST_DEFAULT_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      const payload =
        body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body), 'utf-8');

      const req = http.request(
        {
          socketPath: this.socketPath,
          method,
          path,
          timeout: requestTimeoutMs,
          headers:
            payload !== undefined ? { 'Content-Type': 'application/json', 'Content-Length': payload.byteLength } : {},
        },
        (res) => {
          res.on('data', (chunk: Buffer) => onChunk(chunk.toString('utf-8')));
          res.on('end', () => resolve({ statusCode: res.statusCode ?? 0 }));
          res.on('error', reject);
        }
      );

      req.on('timeout', () => {
        req.destroy(new Error(`Docker API request timed out after ${requestTimeoutMs}ms`));
      });
      req.on('error', reject);

      if (payload !== undefined) req.write(payload);

      req.end();
    });
  }

  /**
   * Docker multiplexed stream format:
   *   [stream_type(1 byte)][0][0][0][size(4 bytes big-endian)][payload(size bytes)]
   *
   * stream_type: 0 = stdin, 1 = stdout, 2 = stderr
   *
   * If the buffer does not look like a multiplexed stream we return it as-is.
   */
  private stripDockerStreamHeaders(raw: Buffer): string {
    // Quick check: a multiplexed frame starts with 0x00, 0x01, or 0x02
    // followed by three zero bytes. If the buffer is too small or doesn't
    // match, just return the raw text.
    if (raw.length < 8) {
      return raw.toString('utf-8');
    }

    const firstByte = raw[0];
    if (firstByte !== 0 && firstByte !== 1 && firstByte !== 2) {
      return raw.toString('utf-8');
    }
    if (raw[1] !== 0 || raw[2] !== 0 || raw[3] !== 0) {
      return raw.toString('utf-8');
    }

    // Parse multiplexed frames
    const parts: string[] = [];
    let offset = 0;
    while (offset + 8 <= raw.length) {
      const frameSize = raw.readUInt32BE(offset + 4);
      const frameEnd = offset + 8 + frameSize;
      if (frameEnd > raw.length) {
        // Incomplete frame — append remainder as-is
        parts.push(raw.subarray(offset + 8).toString('utf-8'));
        break;
      }
      parts.push(raw.subarray(offset + 8, frameEnd).toString('utf-8'));
      offset = frameEnd;
    }
    return parts.join('');
  }

  /**
   * Fetch one-shot container stats from the Docker Engine API.
   */
  async getContainerStats(containerName: string): Promise<DockerContainerStats> {
    const res = await this.request(
      'GET',
      `${API_VERSION}/containers/${encodeURIComponent(containerName)}/stats?stream=false`
    );
    if (res.statusCode !== 200) {
      throw new Error(`Docker stats failed (${res.statusCode}): ${res.body}`);
    }
    return JSON.parse(res.body) as DockerContainerStats;
  }

  /**
   * Inspect a container to get state, uptime, etc.
   */
  async inspectContainer(containerName: string): Promise<DockerContainerInspect> {
    const res = await this.request('GET', `${API_VERSION}/containers/${encodeURIComponent(containerName)}/json`);
    if (res.statusCode !== 200) {
      throw new Error(`Docker inspect failed (${res.statusCode}): ${res.body}`);
    }
    return JSON.parse(res.body) as DockerContainerInspect;
  }

  /**
   * Test the Nginx configuration inside the nginx container.
   */
  async testNginxConfig(): Promise<{ valid: boolean; error?: string }> {
    logger.info('Testing Nginx configuration');
    const result = await this.execInContainer(this.nginxContainerName, ['nginx', '-t']);
    const valid = result.exitCode === 0;
    if (!valid) {
      logger.warn('Nginx config test failed', { output: result.output });
    }
    return {
      valid,
      error: valid ? undefined : result.output,
    };
  }

  /**
   * Reload the Nginx process inside the nginx container.
   */
  async reloadNginx(): Promise<void> {
    logger.info('Reloading Nginx');
    const result = await this.execInContainer(this.nginxContainerName, ['nginx', '-s', 'reload']);
    if (result.exitCode !== 0) {
      throw new Error(`Nginx reload failed: ${result.output}`);
    }
    logger.info('Nginx reloaded successfully');
  }

  /**
   * Pull a Docker image from a registry.
   * The Docker API streams progress — we read until the stream ends.
   */
  async pullImage(image: string, tag: string): Promise<void> {
    logger.info('Pulling Docker image', { image, tag });
    const res = await this.request(
      'POST',
      `${API_VERSION}/images/create?fromImage=${encodeURIComponent(image)}&tag=${encodeURIComponent(tag)}`,
      undefined,
      300_000 // 5 min timeout for image pulls
    );
    if (res.statusCode !== 200) {
      throw new Error(`Docker image pull failed (${res.statusCode}): ${res.body}`);
    }
    // Check last line of streaming output for errors
    const lines = res.body.trim().split('\n');
    const last = lines[lines.length - 1];
    try {
      const parsed = JSON.parse(last) as { error?: string };
      if (parsed.error) {
        throw new Error(`Docker image pull error: ${parsed.error}`);
      }
    } catch (e) {
      if (e instanceof Error && e.message.startsWith('Docker image pull error')) throw e;
      // Not JSON — ignore parse error
    }
    logger.info('Image pulled successfully', { image, tag });
  }

  /**
   * Pull a Docker image by immutable reference, e.g. registry/app@sha256:...
   */
  async pullImageRef(imageRef: string): Promise<void> {
    logger.info('Pulling Docker image by reference', { imageRef });
    const res = await this.request(
      'POST',
      `${API_VERSION}/images/create?fromImage=${encodeURIComponent(imageRef)}`,
      undefined,
      300_000
    );
    if (res.statusCode !== 200) {
      throw new Error(`Docker image pull failed (${res.statusCode}): ${res.body}`);
    }
    const lines = res.body.trim().split('\n');
    const last = lines[lines.length - 1];
    try {
      const parsed = JSON.parse(last) as { error?: string };
      if (parsed.error) {
        throw new Error(`Docker image pull error: ${parsed.error}`);
      }
    } catch (e) {
      if (e instanceof Error && e.message.startsWith('Docker image pull error')) throw e;
    }
    logger.info('Image reference pulled successfully', { imageRef });
  }

  /**
   * Pull an image by immutable reference while streaming the daemon's NDJSON
   * progress. Reports only what Docker actually supplies: byte totals appear
   * solely when every seen layer has a known size, layer counts count distinct
   * layer ids, and a layer counts as completed on "Pull complete"/"Already
   * exists". Long pulls get a matching request timeout.
   */
  async pullImageRefStreaming(imageRef: string, onProgress?: (progress: DockerPullProgress) => void): Promise<void> {
    logger.info('Pulling Docker image by reference (streaming)', { imageRef });
    const layers = new Map<string, { current: number; total: number; done: boolean; cached: boolean }>();
    let ndjsonError: string | null = null;
    let buffer = '';

    const emit = () => {
      if (!onProgress) return;
      const all = [...layers.values()];
      const layersTotal = all.length;
      const layersCompleted = all.filter((layer) => layer.done).length;
      const downloadable = all.filter((layer) => !layer.cached);
      const downloadedBytes = downloadable.reduce((sum, layer) => sum + layer.current, 0);
      const everySizeKnown = downloadable.length > 0 && downloadable.every((layer) => layer.total > 0);
      const progress: DockerPullProgress = { layersCompleted, layersTotal };
      if (everySizeKnown) {
        progress.downloadedBytes = downloadedBytes;
        progress.totalBytes = downloadable.reduce((sum, layer) => sum + layer.total, 0);
      }
      onProgress(progress);
    };

    const handleLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let event: {
        id?: string;
        status?: string;
        progressDetail?: { current?: number; total?: number };
        error?: string;
        message?: string;
      };
      try {
        event = JSON.parse(trimmed);
      } catch {
        return;
      }
      if (typeof event.error === 'string' && event.error) {
        ndjsonError = event.error;
        return;
      }
      // Docker returns one JSON object with `message` (rather than an NDJSON
      // `error`) for request-level failures such as a missing platform in a
      // manifest list. Preserve that actionable daemon explanation.
      if (typeof event.message === 'string' && event.message && !event.id && !event.status) {
        ndjsonError = event.message;
        return;
      }
      if (!event.id || !event.status) return;
      const layer = layers.get(event.id) ?? { current: 0, total: 0, done: false, cached: false };
      if (
        event.status === 'Already exists' ||
        event.status === 'Pull complete' ||
        event.status === 'Download complete'
      ) {
        layer.done = true;
        if (event.status === 'Already exists') layer.cached = true;
        if (event.progressDetail?.total !== undefined) layer.total = event.progressDetail.total;
        // A completed layer is fully downloaded even when the completion
        // event itself carries no progress detail.
        if (layer.total > 0) layer.current = layer.total;
        else if (event.progressDetail?.current !== undefined) layer.current = event.progressDetail.current;
      } else {
        if (event.progressDetail?.current !== undefined) layer.current = event.progressDetail.current;
        if (event.progressDetail?.total !== undefined) layer.total = event.progressDetail.total;
      }
      layers.set(event.id, layer);
      emit();
    };

    const res = await this.requestStream(
      'POST',
      `${API_VERSION}/images/create?fromImage=${encodeURIComponent(imageRef)}`,
      undefined,
      30 * 60_000,
      (chunk) => {
        buffer += chunk;
        let index = buffer.indexOf('\n');
        while (index >= 0) {
          handleLine(buffer.slice(0, index));
          buffer = buffer.slice(index + 1);
          index = buffer.indexOf('\n');
        }
      }
    );
    if (buffer.trim()) handleLine(buffer);
    if (ndjsonError) throw new Error(`Docker image pull error: ${ndjsonError}`);
    if (res.statusCode !== 200) {
      throw new Error(`Docker image pull failed (${res.statusCode})`);
    }
    logger.info('Image reference pulled successfully', { imageRef });
  }

  /**
   * Create a named volume with ownership labels. Docker treats a create for an
   * existing name as idempotent and returns the volume, so this is safe to
   * retry after an interrupted operation.
   */
  async createVolume(name: string, labels: Record<string, string> = {}): Promise<void> {
    const res = await this.request('POST', `${API_VERSION}/volumes/create`, { Name: name, Labels: labels });
    if (res.statusCode !== 201 && res.statusCode !== 200) {
      throw new Error(`Docker volume create failed (${res.statusCode}): ${res.body}`);
    }
  }

  async inspectVolume(name: string): Promise<DockerVolumeInspect | null> {
    const res = await this.request('GET', `${API_VERSION}/volumes/${encodeURIComponent(name)}`);
    if (res.statusCode === 404) return null;
    if (res.statusCode !== 200) {
      throw new Error(`Docker volume inspect failed (${res.statusCode}): ${res.body}`);
    }
    return JSON.parse(res.body) as DockerVolumeInspect;
  }

  /** Remove a volume; missing volumes are treated as already removed. */
  async removeVolume(name: string): Promise<void> {
    const res = await this.request('DELETE', `${API_VERSION}/volumes/${encodeURIComponent(name)}?force=true`);
    if (res.statusCode === 204 || res.statusCode === 404) return;
    throw new Error(`Docker volume remove failed (${res.statusCode}): ${res.body}`);
  }

  async imageExists(imageRef: string): Promise<boolean> {
    const res = await this.request('GET', `${API_VERSION}/images/${encodeURIComponent(imageRef)}/json`);
    if (res.statusCode === 200) return true;
    if (res.statusCode === 404) return false;
    throw new Error(`Docker image inspect failed (${res.statusCode}): ${res.body}`);
  }

  async listImages(): Promise<DockerImageSummary[]> {
    const res = await this.request('GET', `${API_VERSION}/images/json?all=true`);
    if (res.statusCode !== 200) {
      throw new Error(`Docker image list failed (${res.statusCode}): ${res.body}`);
    }
    return JSON.parse(res.body) as DockerImageSummary[];
  }

  async tagImage(sourceRef: string, targetRepo: string, targetTag: string): Promise<void> {
    const res = await this.request(
      'POST',
      `${API_VERSION}/images/${encodeURIComponent(sourceRef)}/tag?repo=${encodeURIComponent(targetRepo)}&tag=${encodeURIComponent(targetTag)}`
    );
    if (res.statusCode !== 201) {
      throw new Error(`Docker image tag failed (${res.statusCode}): ${res.body}`);
    }
  }

  async removeImageTag(imageRef: string): Promise<void> {
    const res = await this.request(
      'DELETE',
      `${API_VERSION}/images/${encodeURIComponent(imageRef)}?force=false&noprune=true`
    );
    if (res.statusCode === 200 || res.statusCode === 202 || res.statusCode === 404) return;
    throw new Error(`Docker image tag remove failed (${res.statusCode}): ${res.body}`);
  }

  /** The Docker daemon's own information (default logging driver and so on). */
  async getDaemonInfo(): Promise<{ LoggingDriver?: string; DockerRootDir?: string }> {
    const res = await this.request('GET', `${API_VERSION}/info`);
    if (res.statusCode !== 200) {
      throw new Error(`Docker info failed (${res.statusCode}): ${res.body}`);
    }
    return JSON.parse(res.body) as { LoggingDriver?: string; DockerRootDir?: string };
  }

  /**
   * Inspect the container this app is running in.
   * Uses HOSTNAME env var which Docker sets to the short container ID.
   */
  async inspectSelf(): Promise<DockerContainerFullInspect> {
    const hostname = process.env.HOSTNAME;
    if (!hostname) {
      throw new Error('HOSTNAME env var not available — cannot self-inspect');
    }
    const res = await this.request('GET', `${API_VERSION}/containers/${encodeURIComponent(hostname)}/json`);
    if (res.statusCode !== 200) {
      throw new Error(`Docker self-inspect failed (${res.statusCode}): ${res.body}`);
    }
    return JSON.parse(res.body) as DockerContainerFullInspect;
  }

  /**
   * Create a container. Returns the container ID.
   */
  async createContainer(config: DockerCreateContainerConfig, name?: string): Promise<string> {
    const query = name ? `?name=${encodeURIComponent(name)}` : '';
    const res = await this.request('POST', `${API_VERSION}/containers/create${query}`, config);
    if (res.statusCode !== 201) {
      throw new Error(`Docker container create failed (${res.statusCode}): ${res.body}`);
    }
    const { Id } = JSON.parse(res.body) as { Id: string };
    return Id;
  }

  /**
   * Start a container by ID.
   */
  async startContainer(id: string): Promise<void> {
    const res = await this.request(
      'POST',
      `${API_VERSION}/containers/${encodeURIComponent(id)}/start`,
      undefined,
      CONTAINER_START_TIMEOUT_MS
    );
    // 204 = started, 304 = already running
    if (res.statusCode !== 204 && res.statusCode !== 304) {
      throw new Error(`Docker container start failed (${res.statusCode}): ${res.body}`);
    }
  }

  async restartContainer(id: string, timeoutSeconds = 10): Promise<void> {
    const res = await this.request(
      'POST',
      `${API_VERSION}/containers/${encodeURIComponent(id)}/restart?t=${encodeURIComponent(String(timeoutSeconds))}`,
      undefined,
      stopRequestTimeoutMs(timeoutSeconds) + CONTAINER_START_TIMEOUT_MS
    );
    if (res.statusCode !== 204) {
      throw new Error(`Docker container restart failed (${res.statusCode}): ${res.body}`);
    }
  }

  async connectContainerToNetwork(id: string, network: string, aliases: string[] = []): Promise<void> {
    const res = await this.request('POST', `${API_VERSION}/networks/${encodeURIComponent(network)}/connect`, {
      Container: id,
      EndpointConfig: aliases.length > 0 ? { Aliases: aliases } : {},
    });
    if (res.statusCode === 200) return;
    if (res.statusCode === 403 && /already exists|already connected/i.test(res.body)) return;
    throw new Error(`Docker network connect failed (${res.statusCode}): ${res.body}`);
  }

  /**
   * Wait for a container to exit. Returns the exit code.
   */
  async waitContainer(id: string, timeoutMs = 300_000): Promise<number> {
    const res = await this.request(
      'POST',
      `${API_VERSION}/containers/${encodeURIComponent(id)}/wait`,
      undefined,
      timeoutMs
    );
    if (res.statusCode !== 200) {
      throw new Error(`Docker container wait failed (${res.statusCode}): ${res.body}`);
    }
    const { StatusCode } = JSON.parse(res.body) as { StatusCode: number };
    return StatusCode;
  }

  /**
   * Remove a container by ID.
   */
  async removeContainer(
    id: string,
    options: { removeAnonymousVolumes?: boolean; force?: boolean } = {}
  ): Promise<void> {
    const params = new URLSearchParams({ force: options.force === false ? 'false' : 'true' });
    if (options.removeAnonymousVolumes) params.set('v', 'true');
    const res = await this.request('DELETE', `${API_VERSION}/containers/${encodeURIComponent(id)}?${params}`);
    if (res.statusCode !== 204 && res.statusCode !== 404) {
      throw new Error(`Docker container remove failed (${res.statusCode}): ${res.body}`);
    }
  }

  async renameContainer(id: string, name: string): Promise<void> {
    const response = await this.request(
      'POST',
      `${API_VERSION}/containers/${encodeURIComponent(id)}/rename?name=${encodeURIComponent(name)}`
    );
    if (response.statusCode !== 204) throw new Error(`Docker container rename failed (${response.statusCode})`);
  }

  async stopContainer(id: string, timeoutSeconds = 5): Promise<void> {
    const res = await this.request(
      'POST',
      `${API_VERSION}/containers/${encodeURIComponent(id)}/stop?t=${encodeURIComponent(String(timeoutSeconds))}`,
      undefined,
      stopRequestTimeoutMs(timeoutSeconds)
    );
    if (res.statusCode !== 204 && res.statusCode !== 304 && res.statusCode !== 404) {
      throw new Error(`Docker container stop failed (${res.statusCode}): ${res.body}`);
    }
  }

  async killContainer(id: string): Promise<void> {
    const res = await this.request('POST', `${API_VERSION}/containers/${encodeURIComponent(id)}/kill`);
    if (res.statusCode !== 204 && res.statusCode !== 404) {
      throw new Error(`Docker container kill failed (${res.statusCode}): ${res.body}`);
    }
  }

  async getContainerLogs(
    id: string,
    options: {
      stdout?: boolean;
      stderr?: boolean;
      tail?: number;
      /** Only lines logged at or after this instant (epoch milliseconds). */
      sinceMs?: number;
      /** Only lines logged before this instant (epoch milliseconds). */
      untilMs?: number;
      /** Prefix each line with Docker's RFC 3339 timestamp. */
      timestamps?: boolean;
      timeoutMs?: number;
    } = {}
  ): Promise<string> {
    const params = new URLSearchParams({
      stdout: String(options.stdout ?? true),
      stderr: String(options.stderr ?? true),
    });
    if (options.tail !== undefined) params.set('tail', String(Math.max(0, Math.floor(options.tail))));
    if (options.sinceMs !== undefined) params.set('since', (Math.max(0, options.sinceMs) / 1000).toFixed(3));
    if (options.untilMs !== undefined) params.set('until', (Math.max(0, options.untilMs) / 1000).toFixed(3));
    if (options.timestamps) params.set('timestamps', 'true');
    const res = await this.request(
      'GET',
      `${API_VERSION}/containers/${encodeURIComponent(id)}/logs?${params}`,
      undefined,
      options.timeoutMs
    );
    if (res.statusCode !== 200 && res.statusCode !== 404) {
      throw new Error(`Docker container logs failed (${res.statusCode}): ${res.body}`);
    }
    return this.stripDockerStreamHeaders(res.bodyRaw);
  }

  /**
   * Lifecycle events Docker recorded for one container between two instants (milliseconds since
   * the epoch). Docker keeps only a bounded in-memory history, so a long-past window can come back
   * incomplete: callers must treat a missing event as unknown, never as proof that nothing happened.
   */
  async listContainerEvents(
    id: string,
    sinceMs: number,
    untilMs: number,
    actions: readonly string[] = ['kill', 'die', 'stop', 'start', 'restart']
  ): Promise<DockerContainerEvent[]> {
    const filters = encodeURIComponent(JSON.stringify({ type: ['container'], container: [id], event: actions }));
    const since = (Math.max(0, sinceMs) / 1000).toFixed(3);
    // A bounded window: with `until` Docker answers from its history and closes the stream.
    const until = (Math.max(untilMs, sinceMs + 1) / 1000).toFixed(3);
    const res = await this.request(
      'GET',
      `${API_VERSION}/events?since=${since}&until=${until}&filters=${filters}`,
      undefined,
      10_000
    );
    if (res.statusCode !== 200) {
      throw new Error(`Docker events failed (${res.statusCode}): ${res.body}`);
    }
    const events: DockerContainerEvent[] = [];
    for (const line of res.body.split('\n')) {
      if (!line.trim()) continue;
      const raw = JSON.parse(line) as {
        Action?: string;
        status?: string;
        time?: number;
        timeNano?: number;
        Actor?: { Attributes?: Record<string, string> };
      };
      const action = raw.Action ?? raw.status;
      const timeMs = raw.timeNano ? Math.floor(raw.timeNano / 1e6) : (raw.time ?? 0) * 1000;
      if (!action || !timeMs) continue;
      events.push({ action, timeMs, attributes: raw.Actor?.Attributes ?? {} });
    }
    return events.sort((a, b) => a.timeMs - b.timeMs);
  }

  async listContainersByLabel(label: string): Promise<DockerContainerListItem[]> {
    const filters = encodeURIComponent(JSON.stringify({ label: [label] }));
    const res = await this.request('GET', `${API_VERSION}/containers/json?all=true&filters=${filters}`);
    if (res.statusCode !== 200) {
      throw new Error(`Docker container list failed (${res.statusCode}): ${res.body}`);
    }
    return JSON.parse(res.body) as DockerContainerListItem[];
  }

  /** Local Docker inventory used by host-safety checks. */
  async listLocalContainers(): Promise<DockerContainerListItem[]> {
    const res = await this.request('GET', `${API_VERSION}/containers/json?all=true`);
    if (res.statusCode !== 200) {
      throw new Error(`Docker container list failed (${res.statusCode}): ${res.body}`);
    }
    return JSON.parse(res.body) as DockerContainerListItem[];
  }

  async putContainerArchive(id: string, containerPath: string, tarArchive: Buffer): Promise<void> {
    const params = new URLSearchParams({ path: containerPath });
    const res = await this.request(
      'PUT',
      `${API_VERSION}/containers/${encodeURIComponent(id)}/archive?${params}`,
      tarArchive,
      300_000,
      { 'Content-Type': 'application/x-tar' }
    );
    if (res.statusCode !== 200) {
      throw new Error(`Docker put archive failed (${res.statusCode}): ${res.body}`);
    }
  }

  /**
   * Read a path out of a (possibly stopped) container as a tar archive. Used
   * for state-volume backups: the helper container only mounts the volume and
   * is never started, so nothing executes inside it.
   */
  async getContainerArchive(id: string, containerPath: string): Promise<Buffer> {
    const params = new URLSearchParams({ path: containerPath });
    const res = await this.request(
      'GET',
      `${API_VERSION}/containers/${encodeURIComponent(id)}/archive?${params}`,
      undefined,
      300_000
    );
    if (res.statusCode !== 200) {
      throw new Error(`Docker get archive failed (${res.statusCode}): ${res.body}`);
    }
    return res.bodyRaw;
  }

  /**
   * Stream a container archive directly to a host file. The byte ceiling is
   * enforced while reading the Docker response so a misleading/missing
   * Content-Length can never turn a backup into unbounded process memory or
   * disk usage.
   */
  async getContainerArchiveToFile(
    id: string,
    containerPath: string,
    destinationPath: string,
    maxBytes: number,
    timeoutMs = 300_000
  ): Promise<number> {
    const params = new URLSearchParams({ path: containerPath });
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(new Error('Docker archive deadline exceeded')), timeoutMs);
    deadline.unref();
    try {
      return await new Promise((resolve, reject) => {
        let streaming = false;
        const req = http.request(
          {
            socketPath: this.socketPath,
            method: 'GET',
            path: `${API_VERSION}/containers/${encodeURIComponent(id)}/archive?${params}`,
            timeout: 300_000,
            signal: controller.signal,
          },
          (res) => {
            if (res.statusCode !== 200) {
              res.destroy();
              reject(new Error(`Docker get archive failed (${res.statusCode ?? 0})`));
              return;
            }

            let received = 0;
            const limiter = new Transform({
              transform(chunk: Buffer, _encoding, callback) {
                received += chunk.byteLength;
                if (received > maxBytes) {
                  callback(new Error(`Docker archive exceeds the ${maxBytes}-byte limit`));
                  return;
                }
                callback(null, chunk);
              },
            });
            const output = createWriteStream(destinationPath, { flags: 'wx', mode: 0o600 });
            streaming = true;
            void pipeline(res, limiter, output, { signal: controller.signal }).then(() => resolve(received), reject);
          }
        );
        req.on('timeout', () => req.destroy(new Error('Docker API request timed out after 300000ms')));
        req.on('error', (error) => {
          // Once streaming, wait for pipeline to close the file before callers
          // remove the partial backup and restart the old core.
          if (!streaming) reject(error);
        });
        req.end();
      });
    } finally {
      clearTimeout(deadline);
    }
  }

  /** Stream a host tar file into a container without materializing it as a Buffer. */
  async putContainerArchiveFromFile(id: string, containerPath: string, archivePath: string): Promise<void> {
    const archiveStat = await stat(archivePath);
    const params = new URLSearchParams({ path: containerPath });
    await new Promise<void>((resolve, reject) => {
      const req = http.request(
        {
          socketPath: this.socketPath,
          method: 'PUT',
          path: `${API_VERSION}/containers/${encodeURIComponent(id)}/archive?${params}`,
          timeout: 300_000,
          headers: {
            'Content-Type': 'application/x-tar',
            'Content-Length': archiveStat.size,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          let bytes = 0;
          res.on('data', (chunk: Buffer) => {
            if (bytes < 64 * 1024) chunks.push(chunk.subarray(0, Math.max(0, 64 * 1024 - bytes)));
            bytes += chunk.byteLength;
          });
          res.on('end', () => {
            if (res.statusCode === 200) resolve();
            else {
              const detail = Buffer.concat(chunks).toString('utf8');
              reject(new Error(`Docker put archive failed (${res.statusCode ?? 0}): ${detail}`));
            }
          });
          res.on('error', reject);
        }
      );
      req.on('timeout', () => req.destroy(new Error('Docker API request timed out after 300000ms')));
      req.on('error', reject);
      const input = createReadStream(archivePath);
      input.on('error', (error) => req.destroy(error));
      input.pipe(req);
    });
  }

  /**
   * A path of a (possibly stopped) container as a tar stream, read as the caller consumes it. The
   * request has no overall deadline: a configuration export reads whole volumes through it.
   */
  openContainerArchive(id: string, containerPath: string): Promise<Readable> {
    const params = new URLSearchParams({ path: containerPath });
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          socketPath: this.socketPath,
          method: 'GET',
          path: `${API_VERSION}/containers/${encodeURIComponent(id)}/archive?${params}`,
          timeout: DOCKER_REQUEST_DEFAULT_TIMEOUT_MS,
        },
        (res) => {
          if (res.statusCode !== 200) {
            const chunks: Buffer[] = [];
            res.on('data', (chunk: Buffer) => chunks.push(chunk));
            res.on('end', () =>
              reject(
                new Error(
                  `Docker get archive of ${containerPath} failed (${res.statusCode ?? 0}): ${Buffer.concat(chunks).toString('utf8').slice(0, 2000)}`
                )
              )
            );
            res.on('error', reject);
            return;
          }
          resolve(res);
        }
      );
      req.on('timeout', () => req.destroy(new Error('Docker archive request stalled')));
      req.on('error', reject);
      req.end();
    });
  }

  /** Extracts a tar stream into a path of a (possibly stopped) container. */
  async putContainerArchiveStream(id: string, containerPath: string, body: Readable): Promise<void> {
    const params = new URLSearchParams({ path: containerPath });
    await new Promise<void>((resolve, reject) => {
      const req = http.request(
        {
          socketPath: this.socketPath,
          method: 'PUT',
          path: `${API_VERSION}/containers/${encodeURIComponent(id)}/archive?${params}`,
          timeout: DOCKER_REQUEST_DEFAULT_TIMEOUT_MS,
          headers: { 'Content-Type': 'application/x-tar', 'Transfer-Encoding': 'chunked' },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => {
            if (chunks.length < 64) chunks.push(chunk);
          });
          res.on('end', () => {
            if (res.statusCode === 200) resolve();
            else
              reject(
                new Error(
                  `Docker put archive into ${containerPath} failed (${res.statusCode ?? 0}): ${Buffer.concat(chunks).toString('utf8').slice(0, 2000)}`
                )
              );
          });
          res.on('error', reject);
        }
      );
      req.on('timeout', () => req.destroy(new Error('Docker archive request stalled')));
      req.on('error', reject);
      pipeline(body, req).catch((error) => {
        req.destroy(error as Error);
        reject(error);
      });
    });
  }

  async pauseContainer(id: string): Promise<void> {
    const res = await this.request('POST', `${API_VERSION}/containers/${encodeURIComponent(id)}/pause`);
    if (res.statusCode !== 204) throw new Error(`Docker container pause failed (${res.statusCode}): ${res.body}`);
  }

  async unpauseContainer(id: string): Promise<void> {
    const res = await this.request('POST', `${API_VERSION}/containers/${encodeURIComponent(id)}/unpause`);
    if (res.statusCode !== 204 && !(res.statusCode === 409 && /not paused/i.test(res.body))) {
      throw new Error(`Docker container unpause failed (${res.statusCode}): ${res.body}`);
    }
  }

  /** Full inspect of any container: image, labels, mounts and state. */
  async inspectContainerDetails(id: string): Promise<DockerContainerDetails | null> {
    const res = await this.request('GET', `${API_VERSION}/containers/${encodeURIComponent(id)}/json`);
    if (res.statusCode === 404) return null;
    if (res.statusCode !== 200) throw new Error(`Docker inspect failed (${res.statusCode}): ${res.body}`);
    return JSON.parse(res.body) as DockerContainerDetails;
  }

  /**
   * Create, start, wait for completion, and clean up a one-shot container. It is labelled as a one-off of this process
   * (ONE_SHOT_LABEL, ONE_SHOT_OWNER_LABEL), so cleanups of finished containers leave it alone until its output was read,
   * and one a stopped Opfield left behind is removed later (removeLeftoverOneShots). Output that cannot be read is an
   * error, never mistaken for the container's output.
   */
  async runOneShot(
    config: DockerCreateContainerConfig,
    timeoutMs?: number
  ): Promise<{ exitCode: number; output: string }> {
    const id = await this.createContainer({
      ...config,
      Labels: {
        [ONE_SHOT_LABEL]: 'true',
        ...(config.Labels ?? {}),
        [ONE_SHOT_OWNER_LABEL]: ONE_SHOT_OWNER,
      },
    });
    try {
      await this.startContainer(id);
      const exitCode = await this.waitContainer(id, timeoutMs);
      const logRes = await this.request(
        'GET',
        `${API_VERSION}/containers/${encodeURIComponent(id)}/logs?stdout=true&stderr=true`
      );
      if (logRes.statusCode !== 200) {
        throw new Error(
          `The helper container ended with exit code ${exitCode}, but its output could not be read (${logRes.statusCode}): ${dockerErrorMessage(logRes.body)}`
        );
      }
      const output = this.stripDockerStreamHeaders(logRes.bodyRaw);
      return { exitCode, output };
    } finally {
      await this.removeContainer(id, { removeAnonymousVolumes: true }).catch(() => {});
    }
  }

  /**
   * Removes the one-off containers (runOneShot) an earlier or other Opfield process left behind: stopped before it
   * could remove them (a restart while a registry storage switch ran a step). Only those that ended at least
   * ONE_SHOT_LEFTOVER_AGE_MS ago (or never started) and never one of this process; never forced, so a running one
   * stays. Returns how many went.
   */
  async removeLeftoverOneShots(now = Date.now()): Promise<number> {
    let removed = 0;
    const seen = new Set<string>();
    for (const label of [ONE_SHOT_LABEL, LEGACY_REGISTRY_STORAGE_LABEL]) {
      const filters = encodeURIComponent(JSON.stringify({ label: [label] }));
      const res = await this.request('GET', `${API_VERSION}/containers/json?all=true&filters=${filters}`);
      if (res.statusCode !== 200) throw new Error(`Docker container list failed (${res.statusCode}): ${res.body}`);
      for (const item of JSON.parse(res.body) as DockerContainerListItem[]) {
        if (seen.has(item.Id)) continue;
        seen.add(item.Id);
        if (item.Labels?.[ONE_SHOT_OWNER_LABEL] === ONE_SHOT_OWNER) continue;
        if (!['exited', 'dead', 'created'].includes(item.State)) continue;
        const details = await this.inspectContainerDetails(item.Id).catch(() => null);
        if (!details || !isLeftoverOneShot(details, now)) continue;
        try {
          await this.removeContainer(item.Id, { removeAnonymousVolumes: true, force: false });
          removed += 1;
        } catch (error) {
          logger.debug('A leftover helper container was kept', {
            id: item.Id.slice(0, 12),
            error: (error as Error).message,
          });
        }
      }
    }
    if (removed > 0) logger.info('Removed helper containers an earlier Opfield process left behind', { removed });
    return removed;
  }

  /**
   * Create and start a detached container (fire-and-forget).
   */
  async runDetached(config: DockerCreateContainerConfig): Promise<string> {
    const id = await this.createContainer(config);
    await this.startContainer(id);
    logger.info('Started detached container', { id: id.slice(0, 12) });
    return id;
  }
}

export interface DockerContainerStats {
  cpu_stats: {
    cpu_usage: { total_usage: number };
    system_cpu_usage: number;
    online_cpus: number;
  };
  precpu_stats: {
    cpu_usage: { total_usage: number };
    system_cpu_usage: number;
  };
  memory_stats: {
    usage: number;
    limit: number;
    stats?: { cache?: number };
  };
  blkio_stats: {
    io_service_bytes_recursive: Array<{ op: string; value: number }> | null;
  };
  networks?: Record<string, { rx_bytes: number; tx_bytes: number }>;
}

export interface DockerContainerInspect {
  State: {
    Status: string;
    Running: boolean;
    StartedAt: string;
    /** Docker's restart policy is bringing the container back (between a crash and the next start). */
    Restarting?: boolean;
    FinishedAt?: string;
  };
  Config: {
    Image: string;
    /** Seconds a stop waits after the stop signal before it kills; Docker's default is 10. */
    StopTimeout?: number;
  };
}

/** One container lifecycle event from Docker's event history. */
export interface DockerContainerEvent {
  /** Docker's action name: `kill`, `die`, `stop`, `start`, `restart`, … */
  action: string;
  /** When Docker recorded it, in milliseconds since the epoch. */
  timeMs: number;
  attributes: Record<string, string>;
}

export interface DockerContainerFullInspect extends DockerContainerInspect {
  Id: string;
  Name: string;
  Config: {
    Image: string;
    Labels: Record<string, string>;
    Env: string[];
    StopTimeout?: number;
  };
  HostConfig?: {
    NetworkMode?: string;
    LogConfig?: { Type?: string; Config?: Record<string, string> | null };
  };
  NetworkSettings?: {
    Networks?: Record<string, { Aliases?: string[]; IPAddress?: string }>;
  };
}

export interface DockerContainerDetails {
  Id: string;
  Name: string;
  /** Image ID (sha256:...). */
  Image: string;
  /** When Docker created it (RFC 3339). */
  Created?: string;
  Config: { Image: string; Labels?: Record<string, string>; Env?: string[] };
  State: {
    Status: string;
    Running: boolean;
    Paused?: boolean;
    Health?: { Status?: string };
    /** When it last stopped (RFC 3339; year 1 when it never ran). */
    FinishedAt?: string;
  };
  Mounts?: Array<{ Type: string; Name?: string; Source?: string; Destination: string; RW?: boolean }>;
  HostConfig?: { NetworkMode?: string; LogConfig?: { Type?: string; Config?: Record<string, string> } };
  /** Host path of the json-file log; empty for other log drivers. */
  LogPath?: string;
}

export interface DockerVolumeInspect {
  Name: string;
  Driver?: string;
  Mountpoint?: string;
  Labels?: Record<string, string>;
}

export interface DockerPullProgress {
  downloadedBytes?: number;
  totalBytes?: number;
  layersCompleted?: number;
  layersTotal?: number;
}

export interface DockerCreateContainerConfig {
  Image: string;
  Cmd?: string[];
  Entrypoint?: string[];
  Env?: string[];
  Labels?: Record<string, string>;
  /** `{ Test: ['NONE'] }` turns off a healthcheck the image declares. */
  Healthcheck?: { Test: string[] };
  User?: string;
  WorkingDir?: string;
  AttachStdout?: boolean;
  AttachStderr?: boolean;
  AttachStdin?: boolean;
  OpenStdin?: boolean;
  StdinOnce?: boolean;
  Tty?: boolean;
  NetworkingConfig?: {
    EndpointsConfig: Record<string, { Aliases?: string[] }>;
  };
  HostConfig?: {
    Binds?: string[];
    AutoRemove?: boolean;
    ReadonlyRootfs?: boolean;
    NetworkMode?: string;
    CapDrop?: string[];
    SecurityOpt?: string[];
    PidsLimit?: number;
    Memory?: number;
    MemorySwap?: number;
    CpuPeriod?: number;
    CpuQuota?: number;
    CpuShares?: number;
    BlkioWeight?: number;
    Tmpfs?: Record<string, string>;
    LogConfig?: {
      Type: string;
      Config?: Record<string, string>;
    };
    RestartPolicy?: {
      Name: 'no' | 'always' | 'unless-stopped' | 'on-failure';
      MaximumRetryCount?: number;
    };
  };
}

export interface DockerContainerListItem {
  Id: string;
  Names: string[];
  Image: string;
  State: string;
  Status: string;
  Labels?: Record<string, string>;
  NetworkSettings?: {
    Networks?: Record<string, { IPAddress?: string; GlobalIPv6Address?: string }>;
  };
}

export interface DockerImageSummary {
  Id: string;
  RepoTags?: string[] | null;
  RepoDigests?: string[] | null;
  Size?: number;
}

/** `df -kP` output: total, used and available bytes of the one filesystem it lists; null when unreadable. */
export function parseDfKilobytes(
  output: string
): { totalBytes: number; usedBytes: number; availableBytes: number } | null {
  const line = output
    .trim()
    .split('\n')
    .map((value) => value.trim())
    .filter(Boolean)
    .at(-1);
  const columns = line?.split(/\s+/) ?? [];
  const [total, used, available] = [columns[1], columns[2], columns[3]].map(Number);
  if (![total, used, available].every((value) => Number.isSafeInteger(value) && value! >= 0) || !total) return null;
  return { totalBytes: total! * 1024, usedBytes: used! * 1024, availableBytes: available! * 1024 };
}

/** The `message` of a Docker API error body, else the body itself. */
function dockerErrorMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as { message?: unknown };
    if (typeof parsed.message === 'string') return parsed.message;
  } catch {
    // Not JSON.
  }
  return body.trim();
}

/** Whether a stopped one-off container ended (or, never started, was created) ONE_SHOT_LEFTOVER_AGE_MS ago or more. */
export function isLeftoverOneShot(
  details: { Created?: string; State?: { Running?: boolean; Status?: string; FinishedAt?: string } },
  now: number
): boolean {
  if (details.State?.Running) return false;
  const finished = Date.parse(details.State?.FinishedAt ?? '');
  // Docker reports 0001-01-01 for a container that never ran.
  const ended = Number.isFinite(finished) && finished > 0 ? finished : Date.parse(details.Created ?? '');
  return Number.isFinite(ended) && now - ended >= ONE_SHOT_LEFTOVER_AGE_MS;
}
