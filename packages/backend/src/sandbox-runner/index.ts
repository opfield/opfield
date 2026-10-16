import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createChildLogger } from '@/lib/logger.js';
import type {
  SandboxRunnerDownloadArtifactParams,
  SandboxRunnerDownloadArtifactResult,
  SandboxRunnerExecuteScriptParams,
  SandboxRunnerExecutionResult,
  SandboxRunnerFetchParams,
  SandboxRunnerFetchResult,
  SandboxRunnerFindJobContainerParams,
  SandboxRunnerFindJobContainerResult,
  SandboxRunnerHealth,
  SandboxRunnerKillResult,
  SandboxRunnerListArtifactFilesEntry,
  SandboxRunnerListArtifactFilesParams,
  SandboxRunnerListArtifactFilesResult,
  SandboxRunnerProcessParams,
  SandboxRunnerProcessResult,
  SandboxRunnerReadArtifactParams,
  SandboxRunnerReadArtifactResult,
  SandboxRunnerReadOutputParams,
  SandboxRunnerReadOutputResult,
  SandboxRunnerRequest,
  SandboxRunnerResponse,
  SandboxRunnerRevokeUserParams,
  SandboxRunnerRunProcessParams,
  SandboxRunnerSendArtifactParams,
  SandboxRunnerSendArtifactResult,
  SandboxRunnerUploadArtifactChunkParams,
  SandboxRunnerUploadArtifactChunkResult,
  SandboxRunnerUploadArtifactParams,
  SandboxRunnerUploadArtifactResult,
  SandboxRunnerWaitProcessParams,
  SandboxRunnerWaitProcessResult,
  SandboxRunnerWorkspaceUsageResult,
  SandboxRunnerWriteStdinParams,
  SandboxRunnerWriteStdinResult,
} from '@/modules/ai/ai.sandbox-runner.protocol.js';
import { type DockerCreateContainerConfig, DockerService } from '@/services/docker.service.js';
import {
  hostArtifactHandleChildPath,
  hostArtifactHandlePath,
  openHostArtifact,
  openHostArtifactChildDirectory,
  openHostArtifactDirectory,
  resolveHostArtifactDirectory,
  resolveHostArtifactPath as resolveSafeHostArtifactPath,
} from './artifact-path.js';
import { readResponseBodyCapped } from './network.js';
import {
  evaluateWorkspaceAdmission,
  measureWorkspaceUsageBytes,
  remainingWorkspaceReservationBytes,
} from './workspace-policy.js';

const logger = createChildLogger('SandboxRunner');

/** Labels of sandbox containers: `net.opfield.sandbox` and `net.opfield.sandbox.<name>`. */
const SANDBOX_LABEL = 'net.opfield.sandbox';
// legacy-name: gateway.sandbox* labels of sandbox containers created before 2.12.1 (they expire with their job) —
// remove once no installation runs one
const LEGACY_SANDBOX_LABEL = 'gateway.sandbox';

function sandboxLabelKey(name: string | null, prefix = SANDBOX_LABEL): string {
  return name ? `${prefix}.${name}` : prefix;
}

/** A sandbox label's value: the Opfield key, else the earlier one. */
function sandboxLabel(labels: Record<string, string> | undefined, name: string): string | undefined {
  return labels?.[sandboxLabelKey(name)] ?? labels?.[sandboxLabelKey(name, LEGACY_SANDBOX_LABEL)];
}

/** Sandbox containers whose label `name` (null: the marker) equals value, under either label family. */
async function listSandboxContainers(name: string | null, value: string) {
  const lists = await Promise.all(
    [SANDBOX_LABEL, LEGACY_SANDBOX_LABEL].map((prefix) =>
      docker.listContainersByLabel(`${sandboxLabelKey(name, prefix)}=${value}`)
    )
  );
  const seen = new Set<string>();
  return lists.flat().filter((container) => !seen.has(container.Id) && seen.add(container.Id));
}
const SOCKET_PATH = process.env.SANDBOX_RUNNER_SOCKET || '/tmp/opfield-sandbox-runner.sock';
const DOCKER_SOCKET = process.env.SANDBOX_DOCKER_SOCKET || '/var/run/docker.sock';
const OUTPUT_LIMIT_BYTES = 256 * 1024;
const STDIN_LIMIT_BYTES = 64 * 1024;
const FETCH_LIMIT_BYTES = 10 * 1024 * 1024;
const DOWNLOAD_LIMIT_BYTES = 200 * 1024 * 1024;
const UPLOAD_ARTIFACT_LIMIT_BYTES = 200 * 1024 * 1024;
const UPLOAD_ARTIFACT_CHUNK_LIMIT_BYTES = 256 * 1024;
const READ_ARTIFACT_LIMIT_BYTES = 1024 * 1024;
const SEND_ARTIFACT_LIMIT_BYTES = 10 * 1024 * 1024;
const LIST_ARTIFACT_FILES_DEFAULT_LIMIT = 200;
const LIST_ARTIFACT_FILES_MAX_LIMIT = 1000;
const LIST_ARTIFACT_FILES_MAX_DEPTH = 8;
const CPU_PERIOD = 100_000;
const SANDBOX_CPU_SHARES = 128;
const SANDBOX_BLKIO_WEIGHT = 10;
const LEGACY_WORKSPACE_RESERVATION_BYTES: Record<string, number> = {
  low: 1024 * 1024 * 1024,
  medium: 2 * 1024 * 1024 * 1024,
  high: 5 * 1024 * 1024 * 1024,
};
const RECONCILE_INTERVAL_MS = 30_000;
const ARTIFACT_ROOT = '/workspace';
const WORKSPACE_HOST_ROOT =
  process.env.SANDBOX_RUNNER_WORKSPACE_DIR ||
  (process.env.NODE_ENV === 'production'
    ? '/var/lib/gateway/sandbox-workspaces'
    : path.join(os.tmpdir(), 'gateway-sandbox-workspaces'));

const docker = new DockerService(DOCKER_SOCKET, '');
const runningTimeouts = new Map<string, NodeJS.Timeout>();
const imageEnsurePromises = new Map<string, Promise<string>>();
const workspaceDirs = new Map<string, string>();
const workspaceReservations = new Map<string, number>();
let workspaceAdmissionLock = Promise.resolve();

interface RuntimeImageSpec {
  upstreamImage: string;
  upstreamTag: string;
  internalRepo: string;
  internalTag: string;
}

function runtimeImageSpec(runtime: string): RuntimeImageSpec {
  if (runtime === 'node') {
    return {
      upstreamImage: 'node',
      upstreamTag: '22-alpine',
      internalRepo: 'gateway-sandbox-node',
      internalTag: '22-alpine',
    };
  }
  if (runtime === 'python') {
    return {
      upstreamImage: 'python',
      upstreamTag: '3.12-alpine',
      internalRepo: 'gateway-sandbox-python',
      internalTag: '3.12-alpine',
    };
  }
  return {
    upstreamImage: 'alpine',
    upstreamTag: '3.20',
    internalRepo: 'gateway-sandbox-alpine',
    internalTag: '3.20',
  };
}

function imageRef(repo: string, tag: string): string {
  return `${repo}:${tag}`;
}

async function ensureRuntimeImage(runtime: string): Promise<string> {
  const spec = runtimeImageSpec(runtime);
  const internalRef = imageRef(spec.internalRepo, spec.internalTag);
  const existingPromise = imageEnsurePromises.get(internalRef);
  if (existingPromise) return existingPromise;

  const promise = (async () => {
    if (await docker.imageExists(internalRef)) return internalRef;

    const upstreamRef = imageRef(spec.upstreamImage, spec.upstreamTag);
    const upstreamAlreadyExisted = await docker.imageExists(upstreamRef);
    logger.info('Preparing sandbox runtime image', { runtime, upstreamRef, internalRef });
    if (!upstreamAlreadyExisted) {
      await docker.pullImage(spec.upstreamImage, spec.upstreamTag);
    }
    await docker.tagImage(upstreamRef, spec.internalRepo, spec.internalTag);
    if (!upstreamAlreadyExisted) {
      await docker.removeImageTag(upstreamRef).catch((error) => {
        logger.warn('Failed to remove temporary sandbox upstream image tag', { upstreamRef, error });
      });
    }
    return internalRef;
  })().finally(() => {
    imageEnsurePromises.delete(internalRef);
  });
  imageEnsurePromises.set(internalRef, promise);
  return promise;
}

function runtimeShell(runtime: string, script: string): string[] {
  if (runtime === 'node') return ['node', '-e', script];
  if (runtime === 'python') return ['python', '-c', script];
  return ['sh', '-lc', script];
}

function truncateOutput(output: string): string {
  const buffer = Buffer.from(output);
  if (buffer.byteLength <= OUTPUT_LIMIT_BYTES) return output;
  return `${buffer.subarray(0, OUTPUT_LIMIT_BYTES).toString('utf-8')}\n[output truncated at ${OUTPUT_LIMIT_BYTES} bytes]`;
}

function sanitizeArtifactFilename(value: string): string {
  const cleaned = value.replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '');
  return cleaned || 'artifact.bin';
}

function fallbackFilenameFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const basename = path.posix.basename(parsed.pathname);
    return sanitizeArtifactFilename(decodeURIComponent(basename || 'artifact.bin'));
  } catch {
    return 'artifact.bin';
  }
}

function resolveArtifactPath(rawPath: unknown, fallbackFilename?: string) {
  const input =
    typeof rawPath === 'string' && rawPath.trim() ? rawPath.trim() : `artifacts/${fallbackFilename ?? 'artifact.bin'}`;
  if (input.includes('\0')) throw new Error('artifact path must not contain null bytes');
  if (path.posix.isAbsolute(input)) throw new Error('artifact path must be relative to /workspace');
  const normalized = path.posix.normalize(input).replace(/^(\.\/)+/, '');
  if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    throw new Error('artifact path must stay inside /workspace');
  }
  return {
    relativePath: normalized,
    absolutePath: path.posix.join(ARTIFACT_ROOT, normalized),
    parentPath: path.posix.join(ARTIFACT_ROOT, path.posix.dirname(normalized)),
    basename: path.posix.basename(normalized),
  };
}

function resolveArtifactDirectoryPath(rawPath: unknown) {
  const input = typeof rawPath === 'string' && rawPath.trim() ? rawPath.trim() : '.';
  if (input.includes('\0')) throw new Error('artifact path must not contain null bytes');
  if (path.posix.isAbsolute(input)) throw new Error('artifact path must be relative to /workspace');
  const normalized = path.posix.normalize(input).replace(/^(\.\/)+/, '');
  if (normalized === '.' || normalized === '') {
    return { relativePath: '' };
  }
  if (normalized === '..' || normalized.startsWith('../')) {
    throw new Error('artifact path must stay inside /workspace');
  }
  return { relativePath: normalized };
}

function isTextContentType(contentType: string | null): boolean {
  if (!contentType) return false;
  return /^(text\/|application\/(json|xml|javascript|x-javascript)|[^;]+\+json\b|[^;]+\+xml\b)/i.test(contentType);
}

function formatFetchedContent(
  url: string,
  status: number,
  contentType: string | null,
  buffer: Buffer
): SandboxRunnerFetchResult {
  if (isTextContentType(contentType)) {
    return {
      url,
      status,
      contentType,
      sizeBytes: buffer.byteLength,
      encoding: 'utf8',
      content: buffer.toString('utf-8'),
    };
  }
  return {
    url,
    status,
    contentType,
    sizeBytes: buffer.byteLength,
    encoding: 'base64',
    contentBase64: buffer.toString('base64'),
  };
}

function sandboxLabels(
  policy: SandboxRunnerExecuteScriptParams['policy'],
  expiresAt: Date,
  workspaceDir: string
): Record<string, string> {
  return {
    [sandboxLabelKey(null)]: 'true',
    [sandboxLabelKey('user_id')]: policy.userId,
    [sandboxLabelKey('conversation_id')]: policy.conversationId ?? '',
    [sandboxLabelKey('job_id')]: policy.jobId,
    [sandboxLabelKey('kind')]: policy.kind,
    [sandboxLabelKey('tier')]: policy.tier,
    [sandboxLabelKey('required_scopes')]: policy.requiredScopes.join(','),
    [sandboxLabelKey('expires_at')]: expiresAt.toISOString(),
    [sandboxLabelKey('workspace_dir')]: workspaceDir,
    [sandboxLabelKey('workspace_reservation_bytes')]: String(policy.workspaceBytes),
  };
}

interface SandboxContainerConfig {
  config: DockerCreateContainerConfig;
  workspaceDir: string;
}

async function createWorkspaceDir(): Promise<string> {
  await fs.mkdir(WORKSPACE_HOST_ROOT, { recursive: true, mode: 0o700 });
  await fs.chmod(WORKSPACE_HOST_ROOT, 0o700).catch(() => {});
  const workspaceDir = await fs.mkdtemp(path.join(WORKSPACE_HOST_ROOT, `${randomUUID()}-`));
  try {
    await fs.chown(workspaceDir, 65534, 65534);
    await fs.chmod(workspaceDir, 0o700);
  } catch {
    // Docker Desktop and non-root dev setups may not allow chown. The parent
    // directory remains private to the Opfield process; this keeps the bind
    // writable from the sandbox user in development.
    await fs.chmod(workspaceDir, 0o777).catch(() => {});
  }
  return workspaceDir;
}

async function cleanupWorkspaceDir(workspaceDir: string | undefined): Promise<boolean> {
  if (!workspaceDir) return true;
  const root = await fs.realpath(WORKSPACE_HOST_ROOT).catch(() => WORKSPACE_HOST_ROOT);
  const target = await fs.realpath(workspaceDir).catch(() => workspaceDir);
  if (target === root || !target.startsWith(`${root}${path.sep}`)) {
    logger.warn('Sandbox workspace is outside the managed root; retaining its stopped container for inspection', {
      workspaceDir: target,
    });
    return false;
  }
  try {
    await fs.rm(target, { recursive: true, force: true });
    return true;
  } catch (error) {
    logger.warn('Failed to remove sandbox workspace; retaining its stopped container for retry', {
      workspaceDir: target,
      error,
    });
    return false;
  }
}

async function allowSandboxDirectoryAccess(directoryPath: string): Promise<void> {
  try {
    await fs.chown(directoryPath, 65534, 65534);
    await fs.chmod(directoryPath, 0o700);
  } catch {
    await fs.chmod(directoryPath, 0o777).catch(() => {});
  }
}

async function allowSandboxDirectoryHandleAccess(directory: fs.FileHandle): Promise<void> {
  try {
    await directory.chown(65534, 65534);
    await directory.chmod(0o700);
  } catch {
    await directory.chmod(0o777).catch(() => {});
  }
}

async function allowSandboxFileHandleAccess(file: fs.FileHandle): Promise<void> {
  try {
    await file.chown(65534, 65534);
    await file.chmod(0o600);
  } catch {
    await file.chmod(0o644).catch(() => {});
  }
}

async function removeContainerAndWorkspace(containerId: string): Promise<boolean> {
  let workspaceDir = workspaceDirs.get(containerId);
  if (!workspaceDir) {
    const inspect = (await docker.inspectContainer(containerId).catch(() => null)) as any;
    const label = sandboxLabel(inspect?.Config?.Labels, 'workspace_dir');
    workspaceDir = typeof label === 'string' ? label : undefined;
  }
  if (!(await cleanupWorkspaceDir(workspaceDir))) return false;
  await docker.removeContainer(containerId).catch(() => {});
  workspaceDirs.delete(containerId);
  workspaceReservations.delete(containerId);
  return true;
}

async function workspaceDirForProcess(processId: string): Promise<string> {
  const mapped = workspaceDirs.get(processId);
  if (mapped) return mapped;
  const inspect = (await docker.inspectContainer(processId)) as any;
  const workspaceDir = sandboxLabel(inspect?.Config?.Labels, 'workspace_dir');
  if (typeof workspaceDir !== 'string' || !workspaceDir) {
    throw new Error('sandbox workspace is not available for this process; restart the sandbox process');
  }
  workspaceDirs.set(processId, workspaceDir);
  return workspaceDir;
}

async function workspaceReservationForProcess(processId: string): Promise<number> {
  const mapped = workspaceReservations.get(processId);
  if (mapped !== undefined) return mapped;
  const inspect = (await docker.inspectContainer(processId)) as any;
  const reservation = workspaceReservationFromLabels(inspect?.Config?.Labels);
  if (!Number.isSafeInteger(reservation) || reservation <= 0) {
    throw new Error('sandbox workspace reservation is not available for this process; restart the sandbox process');
  }
  workspaceReservations.set(processId, reservation);
  return reservation;
}

function workspaceReservationFromLabels(labels: Record<string, string> | undefined): number {
  const raw = sandboxLabel(labels, 'workspace_reservation_bytes');
  const reservation = typeof raw === 'string' ? Number(raw) : 0;
  if (Number.isSafeInteger(reservation) && reservation > 0) return reservation;
  return LEGACY_WORKSPACE_RESERVATION_BYTES[sandboxLabel(labels, 'tier') ?? ''] ?? 0;
}

async function workspaceUsageForProcess(processId: string): Promise<number> {
  const workspaceDir = await workspaceDirForProcess(processId);
  return measureWorkspaceUsageBytes(workspaceDir);
}

async function assertWorkspaceArtifactQuota(processId: string, additionalBytes = 0): Promise<void> {
  const [workspaceUsageBytes, reservationBytes] = await Promise.all([
    workspaceUsageForProcess(processId),
    workspaceReservationForProcess(processId),
  ]);
  if (workspaceUsageBytes > reservationBytes || workspaceUsageBytes + additionalBytes > reservationBytes) {
    throw new Error(
      `sandbox workspace soft quota exceeded: ${workspaceUsageBytes} bytes used, ${reservationBytes} bytes reserved`
    );
  }
}

async function getWorkspaceUsage(params: SandboxRunnerProcessParams): Promise<SandboxRunnerWorkspaceUsageResult> {
  const [workspaceUsageBytes, workspaceReservationBytes] = await Promise.all([
    workspaceUsageForProcess(params.processId),
    workspaceReservationForProcess(params.processId),
  ]);
  return {
    processId: params.processId,
    workspaceUsageBytes,
    workspaceReservationBytes,
    overReservation: workspaceUsageBytes > workspaceReservationBytes,
  };
}

async function findJobContainer(
  params: SandboxRunnerFindJobContainerParams
): Promise<SandboxRunnerFindJobContainerResult> {
  const containers = await listSandboxContainers('job_id', params.jobId);
  const container = containers[0];
  return {
    jobId: params.jobId,
    containerId: container?.Id ?? null,
    expiresAt: sandboxLabel(container?.Labels, 'expires_at') ?? null,
  };
}

async function activeWorkspaceReservationBytes(): Promise<number> {
  const containers = await listSandboxContainers(null, 'true');
  let remainingBytes = 0;
  for (const container of containers) {
    const labels = container.Labels;
    const reservationBytes = workspaceReservationFromLabels(labels);
    const workspaceDir = sandboxLabel(labels, 'workspace_dir');
    const usageBytes =
      typeof workspaceDir === 'string'
        ? await measureWorkspaceUsageBytes(workspaceDir).catch((error) => {
            logger.warn('Failed to measure active sandbox workspace usage for admission', {
              containerId: container.Id,
              error,
            });
            return 0;
          })
        : 0;
    remainingBytes += remainingWorkspaceReservationBytes(reservationBytes, usageBytes);
    if (!Number.isSafeInteger(remainingBytes)) return Number.MAX_SAFE_INTEGER;
  }
  return remainingBytes;
}

async function assertWorkspaceAdmission(requestedReservationBytes: number): Promise<void> {
  try {
    await fs.mkdir(WORKSPACE_HOST_ROOT, { recursive: true, mode: 0o700 });
    const filesystem = await fs.statfs(WORKSPACE_HOST_ROOT);
    const blockSize = Number(filesystem.bsize);
    const totalBytes = Number(filesystem.blocks) * blockSize;
    const usedBytes = (Number(filesystem.blocks) - Number(filesystem.bfree)) * blockSize;
    const activeReservationBytes = await activeWorkspaceReservationBytes();
    const admission = evaluateWorkspaceAdmission({
      totalBytes,
      usedBytes,
      activeReservationBytes,
      requestedReservationBytes,
    });
    if (!admission.allowed) {
      throw new Error(
        `sandbox workspace admission denied: projected ${admission.projectedBytes} bytes reaches the 80% host-disk limit (${admission.limitBytes} bytes)`
      );
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('sandbox workspace admission denied:')) throw error;
    throw new Error('sandbox workspace admission denied: host-disk usage is unavailable');
  }
}

async function withWorkspaceAdmissionLock<T>(work: () => Promise<T>): Promise<T> {
  const previous = workspaceAdmissionLock;
  let release!: () => void;
  workspaceAdmissionLock = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await work();
  } finally {
    release();
  }
}

const resolveHostArtifactPath = (workspaceDir: string, relativePath: string) =>
  resolveSafeHostArtifactPath(
    workspaceDir,
    relativePath,
    allowSandboxDirectoryAccess,
    allowSandboxDirectoryHandleAccess
  );

async function containerConfig(
  policy: SandboxRunnerExecuteScriptParams['policy'],
  command: string[],
  options: { openStdin?: boolean } = {}
): Promise<SandboxContainerConfig> {
  const expiresAt = new Date(Date.now() + policy.ttlSeconds * 1000);
  const workspaceDir = await createWorkspaceDir();
  try {
    const image = await ensureRuntimeImage(policy.runtime);
    return {
      workspaceDir,
      config: {
        Image: image,
        Cmd: command,
        Labels: sandboxLabels(policy, expiresAt, workspaceDir),
        User: '65534:65534',
        WorkingDir: '/workspace',
        AttachStdout: true,
        AttachStderr: true,
        AttachStdin: !!options.openStdin,
        OpenStdin: !!options.openStdin,
        StdinOnce: false,
        Tty: false,
        HostConfig: {
          AutoRemove: false,
          ReadonlyRootfs: true,
          Binds: [`${workspaceDir}:/workspace:rw`],
          NetworkMode: 'none',
          CapDrop: ['ALL'],
          SecurityOpt: ['no-new-privileges'],
          PidsLimit: policy.pidsLimit,
          Memory: policy.memoryBytes,
          MemorySwap: policy.memoryBytes,
          CpuPeriod: CPU_PERIOD,
          CpuQuota: policy.cpuQuota,
          CpuShares: SANDBOX_CPU_SHARES,
          BlkioWeight: SANDBOX_BLKIO_WEIGHT,
          LogConfig: {
            Type: 'json-file',
            Config: {
              'max-size': '256k',
              'max-file': '1',
            },
          },
        },
      },
    };
  } catch (error) {
    await cleanupWorkspaceDir(workspaceDir);
    throw error;
  }
}

function scheduleKill(containerId: string, ttlSeconds: number): void {
  const timeout = setTimeout(() => {
    runningTimeouts.delete(containerId);
    killContainerIfRunning(containerId)
      .catch((error) => {
        logger.warn('Failed to kill expired sandbox container', { containerId, error });
      })
      .finally(() => {
        removeContainerAndWorkspace(containerId).catch(() => {});
      });
  }, ttlSeconds * 1000);
  timeout.unref();
  runningTimeouts.set(containerId, timeout);
}

function clearKill(containerId: string): void {
  const timeout = runningTimeouts.get(containerId);
  if (timeout) clearTimeout(timeout);
  runningTimeouts.delete(containerId);
}

function isContainerAlreadyStoppedError(error: unknown): boolean {
  return error instanceof Error && /Docker container kill failed \(409\):.*not running/i.test(error.message);
}

async function killContainerIfRunning(containerId: string): Promise<void> {
  await docker.killContainer(containerId).catch((error) => {
    if (isContainerAlreadyStoppedError(error)) return;
    throw error;
  });
}

async function executeScript(params: SandboxRunnerExecuteScriptParams): Promise<SandboxRunnerExecutionResult> {
  const { config, workspaceDir } = await containerConfig(
    params.policy,
    runtimeShell(params.policy.runtime, params.script)
  );
  let containerId = '';
  try {
    containerId = await withWorkspaceAdmissionLock(async () => {
      await assertWorkspaceAdmission(params.policy.workspaceBytes);
      const id = await docker.createContainer(config);
      workspaceDirs.set(id, workspaceDir);
      workspaceReservations.set(id, params.policy.workspaceBytes);
      return id;
    });
  } catch (error) {
    await cleanupWorkspaceDir(workspaceDir);
    throw error;
  }
  scheduleKill(containerId, params.policy.ttlSeconds);

  let timedOut = false;
  try {
    await docker.startContainer(containerId);
    const exitCode = await docker
      .waitContainer(containerId, params.policy.ttlSeconds * 1000 + 10_000)
      .catch(async (error) => {
        timedOut = true;
        await killContainerIfRunning(containerId).catch(() => {});
        throw error;
      });
    const output = truncateOutput(await docker.getContainerLogs(containerId));
    const workspaceUsageBytes = await workspaceUsageForProcess(containerId);
    return {
      jobId: params.policy.jobId,
      containerId,
      exitCode,
      output,
      outputBytes: Buffer.byteLength(output),
      timedOut,
      workspaceUsageBytes,
    };
  } finally {
    clearKill(containerId);
    await removeContainerAndWorkspace(containerId);
  }
}

async function runProcess(params: SandboxRunnerRunProcessParams): Promise<SandboxRunnerProcessResult> {
  const { config, workspaceDir } = await containerConfig(params.policy, params.command, { openStdin: true });
  let containerId = '';
  try {
    containerId = await withWorkspaceAdmissionLock(async () => {
      await assertWorkspaceAdmission(params.policy.workspaceBytes);
      const id = await docker.createContainer(config);
      workspaceDirs.set(id, workspaceDir);
      workspaceReservations.set(id, params.policy.workspaceBytes);
      return id;
    });
  } catch (error) {
    await cleanupWorkspaceDir(workspaceDir);
    throw error;
  }
  try {
    await docker.startContainer(containerId);
    scheduleKill(containerId, params.policy.ttlSeconds);
    return {
      processId: containerId,
      jobId: params.policy.jobId,
      containerId,
      expiresAt: new Date(Date.now() + params.policy.ttlSeconds * 1000).toISOString(),
    };
  } catch (error) {
    await removeContainerAndWorkspace(containerId);
    throw error;
  }
}

async function fetchUrl(params: SandboxRunnerFetchParams): Promise<SandboxRunnerFetchResult> {
  const url = String(params.url ?? '').trim();
  if (!url) throw new Error('url is required');
  const { status, contentType, buffer } = await readResponseBodyCapped(url, FETCH_LIMIT_BYTES);
  return formatFetchedContent(url, status, contentType, buffer);
}

async function downloadArtifact(
  params: SandboxRunnerDownloadArtifactParams
): Promise<SandboxRunnerDownloadArtifactResult> {
  const url = String(params.url ?? '').trim();
  if (!url) throw new Error('url is required');
  const fallbackFilename = fallbackFilenameFromUrl(url);
  const artifactPath = resolveArtifactPath(params.path, fallbackFilename);
  const { status, contentType, buffer } = await readResponseBodyCapped(url, DOWNLOAD_LIMIT_BYTES);
  await assertWorkspaceArtifactQuota(params.processId, buffer.byteLength);
  const workspaceDir = await workspaceDirForProcess(params.processId);
  const hostArtifact = await resolveHostArtifactPath(workspaceDir, artifactPath.relativePath);
  const file = await openHostArtifact(hostArtifact, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC, 0o600);
  try {
    await file.writeFile(buffer);
    await allowSandboxFileHandleAccess(file);
  } finally {
    await file.close();
  }
  return {
    processId: params.processId,
    url,
    status,
    path: artifactPath.relativePath,
    sizeBytes: buffer.byteLength,
    contentType,
  };
}

async function uploadArtifact(params: SandboxRunnerUploadArtifactParams): Promise<SandboxRunnerUploadArtifactResult> {
  const artifactPath = resolveArtifactPath(params.path);
  const bytes = Buffer.from(String(params.contentBase64 ?? ''), 'base64');
  if (bytes.byteLength > UPLOAD_ARTIFACT_LIMIT_BYTES) {
    throw new Error(`artifact upload is limited to ${UPLOAD_ARTIFACT_LIMIT_BYTES} bytes`);
  }
  await assertWorkspaceArtifactQuota(params.processId, bytes.byteLength);
  const workspaceDir = await workspaceDirForProcess(params.processId);
  const hostArtifact = await resolveHostArtifactPath(workspaceDir, artifactPath.relativePath);
  const file = await openHostArtifact(hostArtifact, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC, 0o600);
  try {
    await file.writeFile(bytes);
    await allowSandboxFileHandleAccess(file);
  } finally {
    await file.close();
  }
  return {
    processId: params.processId,
    path: artifactPath.relativePath,
    sizeBytes: bytes.byteLength,
  };
}

async function uploadArtifactChunk(
  params: SandboxRunnerUploadArtifactChunkParams
): Promise<SandboxRunnerUploadArtifactChunkResult> {
  const artifactPath = resolveArtifactPath(params.path);
  const offset = Number.isSafeInteger(params.offset) && params.offset >= 0 ? params.offset : -1;
  if (offset < 0) throw new Error('artifact upload offset must be a non-negative integer');
  const bytes = Buffer.from(String(params.contentBase64 ?? ''), 'base64');
  if (bytes.byteLength === 0 || bytes.byteLength > UPLOAD_ARTIFACT_CHUNK_LIMIT_BYTES) {
    throw new Error(`artifact upload chunk is limited to ${UPLOAD_ARTIFACT_CHUNK_LIMIT_BYTES} bytes`);
  }
  await assertWorkspaceArtifactQuota(params.processId, bytes.byteLength);
  const workspaceDir = await workspaceDirForProcess(params.processId);
  const hostArtifact = await resolveHostArtifactPath(workspaceDir, artifactPath.relativePath);
  const existing = await openHostArtifact(hostArtifact, constants.O_RDONLY)
    .then(async (file) => {
      try {
        return await file.stat();
      } finally {
        await file.close();
      }
    })
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
  const existingBytes = existing?.isFile() ? existing.size : 0;
  if (existing && !existing.isFile())
    throw new Error(`artifact upload failed: ${artifactPath.relativePath} is not a file`);
  if (existingBytes !== offset)
    throw new Error(`artifact upload offset does not match stored size for ${artifactPath.relativePath}`);
  const file = await openHostArtifact(
    hostArtifact,
    constants.O_WRONLY | constants.O_CREAT | (offset === 0 ? constants.O_TRUNC : constants.O_APPEND),
    0o600
  );
  try {
    await file.writeFile(bytes);
    await allowSandboxFileHandleAccess(file);
  } finally {
    await file.close();
  }
  return { processId: params.processId, path: artifactPath.relativePath, sizeBytes: offset + bytes.byteLength };
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

async function listArtifactFiles(
  params: SandboxRunnerListArtifactFilesParams
): Promise<SandboxRunnerListArtifactFilesResult> {
  await assertWorkspaceArtifactQuota(params.processId);
  const artifactPath = resolveArtifactDirectoryPath(params.path);
  const workspaceDir = await workspaceDirForProcess(params.processId);
  const rootDirectory = await resolveHostArtifactDirectory(workspaceDir, artifactPath.relativePath);
  const maxDepth = boundedInteger(params.maxDepth, 3, 1, LIST_ARTIFACT_FILES_MAX_DEPTH);
  const limit = boundedInteger(params.limit, LIST_ARTIFACT_FILES_DEFAULT_LIMIT, 1, LIST_ARTIFACT_FILES_MAX_LIMIT);
  const includeFiles = params.includeFiles !== false;
  const includeDirectories = params.includeDirectories !== false;
  const entries: SandboxRunnerListArtifactFilesEntry[] = [];
  let truncated = false;

  const addEntry = (entry: SandboxRunnerListArtifactFilesEntry): void => {
    if (entries.length >= limit) {
      truncated = true;
      return;
    }
    entries.push(entry);
  };

  const walk = async (hostDirectory: fs.FileHandle, relativeDirectory: string, depth: number): Promise<void> => {
    try {
      if (entries.length >= limit) {
        truncated = true;
        return;
      }
      const dirents = await fs.readdir(hostArtifactHandlePath(hostDirectory), { withFileTypes: true });
      dirents.sort((a, b) => a.name.localeCompare(b.name));

      for (const dirent of dirents) {
        if (entries.length >= limit) {
          truncated = true;
          return;
        }
        const localPath = relativeDirectory ? path.posix.join(relativeDirectory, dirent.name) : dirent.name;
        const entryPath = artifactPath.relativePath ? path.posix.join(artifactPath.relativePath, localPath) : localPath;
        const hostPath = hostArtifactHandleChildPath(hostDirectory, dirent.name);
        const stat = await fs.lstat(hostPath).catch(() => null);
        if (!stat) continue;

        if (stat.isSymbolicLink()) {
          addEntry({ path: entryPath, type: 'symlink' });
          continue;
        }

        if (stat.isDirectory()) {
          if (includeDirectories) addEntry({ path: entryPath, type: 'directory' });
          if (depth < maxDepth) {
            const childDirectory = await openHostArtifactChildDirectory(hostDirectory, dirent.name).catch(() => null);
            if (childDirectory) await walk(childDirectory, localPath, depth + 1);
          }
          continue;
        }

        if (stat.isFile()) {
          if (includeFiles) addEntry({ path: entryPath, type: 'file', sizeBytes: stat.size });
          continue;
        }

        addEntry({ path: entryPath, type: 'other' });
      }
    } finally {
      await hostDirectory.close().catch(() => {});
    }
  };

  await walk(await openHostArtifactDirectory(rootDirectory), '', 1);

  return {
    processId: params.processId,
    path: artifactPath.relativePath || '.',
    maxDepth,
    entries,
    truncated,
  };
}

async function readArtifactBytes(
  processId: string,
  rawPath: unknown,
  offsetInput: unknown,
  lengthInput: unknown,
  maxBytes: number
): Promise<{ path: string; totalBytes: number; offset: number; bytes: Buffer; eof: boolean }> {
  const artifactPath = resolveArtifactPath(rawPath);
  const offset =
    typeof offsetInput === 'number' && Number.isFinite(offsetInput) ? Math.max(0, Math.floor(offsetInput)) : 0;
  const requestedLength =
    typeof lengthInput === 'number' && Number.isFinite(lengthInput)
      ? Math.max(1, Math.floor(lengthInput))
      : Math.min(64 * 1024, maxBytes);
  const length = Math.min(requestedLength, maxBytes);
  const workspaceDir = await workspaceDirForProcess(processId);
  const hostArtifact = await resolveHostArtifactPath(workspaceDir, artifactPath.relativePath);
  const file = await openHostArtifact(hostArtifact, constants.O_RDONLY).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') throw new Error(`artifact read failed: ${artifactPath.relativePath} not found`);
    throw error;
  });
  try {
    const stat = await file.stat();
    if (!stat.isFile()) {
      throw new Error(`artifact read failed: ${artifactPath.relativePath} is not a file`);
    }
    const totalBytes = stat.size;
    const bytesToRead = Math.max(0, Math.min(length, Math.max(0, totalBytes - offset)));
    const buffer = Buffer.alloc(bytesToRead);
    const { bytesRead } = await file.read(buffer, 0, bytesToRead, offset);
    const bytes = buffer.subarray(0, bytesRead);
    return {
      path: artifactPath.relativePath,
      totalBytes,
      offset,
      bytes,
      eof: offset + bytes.byteLength >= totalBytes,
    };
  } finally {
    await file.close();
  }
}

async function readArtifact(params: SandboxRunnerReadArtifactParams): Promise<SandboxRunnerReadArtifactResult> {
  await assertWorkspaceArtifactQuota(params.processId);
  const encoding = params.encoding === 'base64' ? 'base64' : 'utf8';
  const result = await readArtifactBytes(
    params.processId,
    params.path,
    params.offset,
    params.length,
    READ_ARTIFACT_LIMIT_BYTES
  );
  return {
    processId: params.processId,
    path: result.path,
    offset: result.offset,
    totalBytes: result.totalBytes,
    bytesRead: result.bytes.byteLength,
    eof: result.eof,
    encoding,
    ...(encoding === 'base64'
      ? { contentBase64: result.bytes.toString('base64') }
      : { content: result.bytes.toString('utf-8') }),
  };
}

async function sendArtifact(params: SandboxRunnerSendArtifactParams): Promise<SandboxRunnerSendArtifactResult> {
  await assertWorkspaceArtifactQuota(params.processId);
  const result = await readArtifactBytes(
    params.processId,
    params.path,
    0,
    SEND_ARTIFACT_LIMIT_BYTES + 1,
    SEND_ARTIFACT_LIMIT_BYTES + 1
  );
  if (result.totalBytes > SEND_ARTIFACT_LIMIT_BYTES || result.bytes.byteLength > SEND_ARTIFACT_LIMIT_BYTES) {
    throw new Error(`artifact is limited to ${SEND_ARTIFACT_LIMIT_BYTES} bytes for chat delivery`);
  }
  const filename = sanitizeArtifactFilename(params.filename ?? path.posix.basename(result.path));
  const mediaType = params.mediaType ?? 'application/octet-stream';
  const tempFilePath = path.join(os.tmpdir(), `opfield-sandbox-artifact-${randomUUID()}`);
  await fs.writeFile(tempFilePath, result.bytes, { mode: 0o600 });
  return {
    processId: params.processId,
    path: result.path,
    filename,
    mediaType,
    sizeBytes: result.bytes.byteLength,
    tempFilePath,
  };
}

async function readProcessOutput(params: SandboxRunnerReadOutputParams): Promise<SandboxRunnerReadOutputResult> {
  const output = truncateOutput(await docker.getContainerLogs(params.processId, { tail: params.tail ?? 200 }));
  return {
    processId: params.processId,
    output,
    outputBytes: Buffer.byteLength(output),
  };
}

async function waitProcess(params: SandboxRunnerWaitProcessParams): Promise<SandboxRunnerWaitProcessResult> {
  const exitCode = await docker.waitContainer(params.processId, params.timeoutMs ?? 25 * 60 * 1000);
  const output = truncateOutput(await docker.getContainerLogs(params.processId).catch(() => ''));
  const workspaceUsageBytes = await workspaceUsageForProcess(params.processId).catch(() => 0);
  return {
    processId: params.processId,
    exitCode,
    outputBytes: Buffer.byteLength(output),
    workspaceUsageBytes,
  };
}

async function writeProcessStdin(params: SandboxRunnerWriteStdinParams): Promise<SandboxRunnerWriteStdinResult> {
  const payload = Buffer.from(params.data);
  if (payload.byteLength > STDIN_LIMIT_BYTES) {
    throw new Error(`stdin payload is limited to ${STDIN_LIMIT_BYTES} bytes`);
  }

  const encoded = payload.toString('base64');
  await docker.execInContainer(params.processId, ['sh', '-lc', `printf '%s' '${encoded}' | base64 -d > /proc/1/fd/0`]);

  return {
    processId: params.processId,
    bytesWritten: payload.byteLength,
    closed: false,
    closeUnsupported: params.close === true ? true : undefined,
  };
}

async function killProcess(params: SandboxRunnerProcessParams): Promise<SandboxRunnerKillResult> {
  await killContainerIfRunning(params.processId);
  clearKill(params.processId);
  if (!(await removeContainerAndWorkspace(params.processId))) {
    throw new Error('Sandbox workspace cleanup is pending');
  }
  return { processId: params.processId, killed: true };
}

async function revokeUserSandboxAccess(params: SandboxRunnerRevokeUserParams): Promise<{ revoked: number }> {
  const containers = await listSandboxContainers(null, 'true');
  let revoked = 0;
  for (const container of containers) {
    if (sandboxLabel(container.Labels, 'user_id') !== params.userId) continue;
    const required = (sandboxLabel(container.Labels, 'required_scopes') ?? '').split(',').filter(Boolean);
    const stillAllowed = required.every((scope) => params.currentScopes.includes(scope));
    if (stillAllowed) continue;
    await killContainerIfRunning(container.Id).catch(() => {});
    await removeContainerAndWorkspace(container.Id);
    clearKill(container.Id);
    revoked += 1;
  }
  return { revoked };
}

async function reconcileSandboxContainers(): Promise<{ removed: number }> {
  const containers = await listSandboxContainers(null, 'true');
  const now = Date.now();
  let removed = 0;

  for (const container of containers) {
    const expiresAt = sandboxLabel(container.Labels, 'expires_at');
    const expired = !expiresAt || Date.parse(expiresAt) <= now;
    const terminal = container.State === 'exited' || container.State === 'dead';
    if (!expiresAt) {
      logger.warn('Removing sandbox container without expiry label', { containerId: container.Id });
    } else if (!expired && !terminal) {
      continue;
    }

    await killContainerIfRunning(container.Id).catch(() => {});
    if (await removeContainerAndWorkspace(container.Id)) {
      clearKill(container.Id);
      removed += 1;
    }
  }

  // Workspaces whose container is gone (removed outside the runner, or the runner died between creating the two)
  // were never removed: each holds up to its reservation. The list above holds every sandbox container, stopped ones
  // included, so a workspace no container names is free once it is old enough to not be one being created now.
  const named = new Set<string>();
  for (const container of containers) {
    const dir = sandboxLabel(container.Labels, 'workspace_dir');
    if (typeof dir === 'string' && dir) named.add(path.resolve(dir));
  }
  for (const dir of workspaceDirs.values()) named.add(path.resolve(dir));
  removed += await removeOrphanedWorkspaces(named, now);
  await removeStaleArtifactTempFiles(now);

  return { removed };
}

/** A workspace no sandbox container names is removed once it is this old. */
const ORPHANED_WORKSPACE_MIN_AGE_MS = 60 * 60 * 1000;

async function removeOrphanedWorkspaces(named: Set<string>, now: number): Promise<number> {
  const entries = await fs.readdir(WORKSPACE_HOST_ROOT).catch(() => [] as string[]);
  let removed = 0;
  for (const entry of entries) {
    // Workspace names are `<uuid>-<random>` (createWorkspaceDir).
    if (!/^[0-9a-f-]{36}-/.test(entry)) continue;
    const dir = path.resolve(WORKSPACE_HOST_ROOT, entry);
    if (named.has(dir)) continue;
    const info = await fs.stat(dir).catch(() => null);
    if (!info?.isDirectory() || now - info.mtimeMs < ORPHANED_WORKSPACE_MIN_AGE_MS) continue;
    if (await cleanupWorkspaceDir(dir)) {
      removed += 1;
      logger.info('Removed a sandbox workspace no container uses', { workspaceDir: dir });
    }
  }
  return removed;
}

/** Artifact copies handed to Opfield are deleted by Opfield after saving; a crash in between leaves them. */
async function removeStaleArtifactTempFiles(now: number): Promise<void> {
  const tmp = os.tmpdir();
  const entries = await fs.readdir(tmp).catch(() => [] as string[]);
  for (const entry of entries) {
    if (!entry.startsWith('opfield-sandbox-artifact-')) continue;
    const file = path.join(tmp, entry);
    const info = await fs.stat(file).catch(() => null);
    if (info?.isFile() && now - info.mtimeMs >= ORPHANED_WORKSPACE_MIN_AGE_MS) await fs.unlink(file).catch(() => {});
  }
}

async function handle(request: SandboxRunnerRequest): Promise<unknown> {
  switch (request.method) {
    case 'health':
      return { ok: true, version: 1 } satisfies SandboxRunnerHealth;
    case 'executeScript':
      return executeScript(request.params as SandboxRunnerExecuteScriptParams);
    case 'runProcess':
      return runProcess(request.params as SandboxRunnerRunProcessParams);
    case 'fetch':
      return fetchUrl(request.params as SandboxRunnerFetchParams);
    case 'downloadArtifact':
      return downloadArtifact(request.params as SandboxRunnerDownloadArtifactParams);
    case 'findJobContainer':
      return findJobContainer(request.params as SandboxRunnerFindJobContainerParams);
    case 'uploadArtifact':
      return uploadArtifact(request.params as SandboxRunnerUploadArtifactParams);
    case 'uploadArtifactChunk':
      return uploadArtifactChunk(request.params as SandboxRunnerUploadArtifactChunkParams);
    case 'listArtifactFiles':
      return listArtifactFiles(request.params as SandboxRunnerListArtifactFilesParams);
    case 'readArtifact':
      return readArtifact(request.params as SandboxRunnerReadArtifactParams);
    case 'getWorkspaceUsage':
      return getWorkspaceUsage(request.params as SandboxRunnerProcessParams);
    case 'sendArtifact':
      return sendArtifact(request.params as SandboxRunnerSendArtifactParams);
    case 'readProcessOutput':
      return readProcessOutput(request.params as SandboxRunnerReadOutputParams);
    case 'waitProcess':
      return waitProcess(request.params as SandboxRunnerWaitProcessParams);
    case 'writeProcessStdin': {
      const params = request.params as SandboxRunnerWriteStdinParams;
      return writeProcessStdin(params);
    }
    case 'killProcess':
      return killProcess(request.params as SandboxRunnerProcessParams);
    case 'revokeUserSandboxAccess':
      return revokeUserSandboxAccess(request.params as SandboxRunnerRevokeUserParams);
    case 'reconcile':
      return reconcileSandboxContainers();
    default:
      throw new Error(`Unsupported sandbox runner method: ${request.method}`);
  }
}

async function writeResponse(socket: net.Socket, response: SandboxRunnerResponse): Promise<void> {
  socket.write(`${JSON.stringify(response)}\n`);
}

async function main(): Promise<void> {
  await fs.unlink(SOCKET_PATH).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
  });

  const server = net.createServer((socket) => {
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf-8');
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        void (async () => {
          let id: string = randomUUID();
          try {
            const request = JSON.parse(line) as SandboxRunnerRequest;
            id = request.id;
            const result = await handle(request);
            await writeResponse(socket, { id, result });
          } catch (error) {
            await writeResponse(socket, { id, error: error instanceof Error ? error.message : String(error) });
          }
        })();
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(SOCKET_PATH, () => {
      server.off('error', reject);
      resolve();
    });
  });
  await fs.chmod(SOCKET_PATH, 0o600).catch(() => {});
  logger.info('Sandbox runner listening', { socketPath: SOCKET_PATH });

  const reconcileTimer = setInterval(() => {
    reconcileSandboxContainers().catch((error) => {
      logger.warn('Sandbox reconciliation failed', { error });
    });
  }, RECONCILE_INTERVAL_MS);
  reconcileTimer.unref();

  const shutdown = () => {
    logger.info('Sandbox runner shutting down');
    clearInterval(reconcileTimer);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5_000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((error) => {
  logger.error('Sandbox runner failed', { error });
  process.exit(1);
});
