import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createChildLogger } from '@/lib/logger.js';
import { isShuttingDown } from '@/services/shutdown-state.js';
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
} from './ai.sandbox-runner.protocol.js';

const logger = createChildLogger('AISandboxRunner');

export type SandboxRunnerStatus = 'stopped' | 'starting' | 'running' | 'unavailable';

export class AISandboxRunnerService {
  private child: ChildProcess | null = null;
  private statusValue: SandboxRunnerStatus = 'stopped';
  private startPromise: Promise<void> | null = null;
  private stopping = false;

  constructor(
    private readonly socketPath = process.env.SANDBOX_RUNNER_SOCKET || `/tmp/gateway-sandbox-${process.pid}.sock`
  ) {}

  get status() {
    return {
      status: this.statusValue,
      socketPath: this.socketPath,
      pid: this.child?.pid ?? null,
    };
  }

  async ensureStarted(): Promise<void> {
    if (this.stopping) throw new Error('Sandbox runner is shutting down');
    if (this.statusValue === 'running') return;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.start();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  async stop(timeoutMs = 5_000): Promise<void> {
    this.stopping = true;
    if (!this.child) return;
    const child = this.child;
    let exited = false;
    this.child = null;
    this.statusValue = 'stopped';
    child.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(
        () => {
          resolve();
        },
        Math.max(0, Math.min(5_000, timeoutMs))
      );
      child.once('exit', () => {
        exited = true;
        clearTimeout(timeout);
        resolve();
      });
    });
    if (!exited) child.kill('SIGKILL');
  }

  async health(): Promise<SandboxRunnerHealth> {
    await this.ensureStarted();
    return this.callRunner<SandboxRunnerHealth>('health', {});
  }

  async executeScript(params: SandboxRunnerExecuteScriptParams) {
    await this.ensureStarted();
    return this.callRunner<SandboxRunnerExecutionResult>('executeScript', params);
  }

  async runProcess(params: SandboxRunnerRunProcessParams) {
    await this.ensureStarted();
    return this.callRunner<SandboxRunnerProcessResult>('runProcess', params);
  }

  async fetch(params: SandboxRunnerFetchParams) {
    await this.ensureStarted();
    return this.callRunner<SandboxRunnerFetchResult>('fetch', params);
  }

  async findJobContainer(params: SandboxRunnerFindJobContainerParams) {
    await this.ensureStarted();
    return this.callRunner<SandboxRunnerFindJobContainerResult>('findJobContainer', params);
  }

  async downloadArtifact(params: SandboxRunnerDownloadArtifactParams) {
    await this.ensureStarted();
    return this.callRunner<SandboxRunnerDownloadArtifactResult>('downloadArtifact', params);
  }

  async uploadArtifact(params: SandboxRunnerUploadArtifactParams) {
    await this.ensureStarted();
    return this.callRunner<SandboxRunnerUploadArtifactResult>('uploadArtifact', params);
  }

  async uploadArtifactChunk(params: SandboxRunnerUploadArtifactChunkParams) {
    await this.ensureStarted();
    return this.callRunner<SandboxRunnerUploadArtifactChunkResult>('uploadArtifactChunk', params);
  }

  async listArtifactFiles(params: SandboxRunnerListArtifactFilesParams) {
    await this.ensureStarted();
    return this.callRunner<SandboxRunnerListArtifactFilesResult>('listArtifactFiles', params);
  }

  async readArtifact(params: SandboxRunnerReadArtifactParams) {
    await this.ensureStarted();
    return this.callRunner<SandboxRunnerReadArtifactResult>('readArtifact', params);
  }

  async getWorkspaceUsage(params: SandboxRunnerProcessParams) {
    await this.ensureStarted();
    return this.callRunner<SandboxRunnerWorkspaceUsageResult>('getWorkspaceUsage', params);
  }

  async sendArtifact(params: SandboxRunnerSendArtifactParams) {
    await this.ensureStarted();
    return this.callRunner<SandboxRunnerSendArtifactResult>('sendArtifact', params);
  }

  async readProcessOutput(params: SandboxRunnerReadOutputParams) {
    await this.ensureStarted();
    return this.callRunner<SandboxRunnerReadOutputResult>('readProcessOutput', params);
  }

  async waitProcess(params: SandboxRunnerWaitProcessParams) {
    await this.ensureStarted();
    const timeoutMs = (params.timeoutMs ?? 25 * 60 * 1000) + 30_000;
    return this.callRunner<SandboxRunnerWaitProcessResult>('waitProcess', params, timeoutMs);
  }

  async writeProcessStdin(params: SandboxRunnerWriteStdinParams) {
    await this.ensureStarted();
    return this.callRunner<SandboxRunnerWriteStdinResult>('writeProcessStdin', params);
  }

  async killProcess(params: SandboxRunnerProcessParams) {
    await this.ensureStarted();
    return this.callRunner<SandboxRunnerKillResult>('killProcess', params);
  }

  async revokeUserSandboxAccess(params: SandboxRunnerRevokeUserParams) {
    await this.ensureStarted();
    return this.callRunner<{ revoked: number }>('revokeUserSandboxAccess', params);
  }

  private async start(): Promise<void> {
    this.statusValue = 'starting';
    fs.rmSync(this.socketPath, { force: true });

    const isTsRuntime = fs.existsSync(path.resolve(process.cwd(), 'src/sandbox-runner/index.ts'));
    const entry = isTsRuntime ? 'src/sandbox-runner/index.ts' : 'dist/sandbox-runner/index.js';
    const args = isTsRuntime ? ['--import', 'tsx', entry] : [entry];
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      env: {
        ...process.env,
        SANDBOX_RUNNER_SOCKET: this.socketPath,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;

    child.stdout?.on('data', (chunk) => logger.debug('runner stdout', { output: chunk.toString('utf-8').trim() }));
    child.stderr?.on('data', (chunk) => logger.warn('runner stderr', { output: chunk.toString('utf-8').trim() }));
    child.once('exit', (code, signal) => {
      // Gateway's stop ends the runner with it: expected then (stand rc.10, O-2).
      if (isShuttingDown()) logger.info('Sandbox runner stopped with Opfield', { code, signal });
      else logger.warn('Sandbox runner exited', { code, signal });
      if (this.child === child) {
        this.child = null;
        this.statusValue = 'unavailable';
      }
    });

    await this.waitForSocket(10_000);
    const health = await this.callRunner<SandboxRunnerHealth>('health', {});
    if (!health.ok) throw new Error('Sandbox runner health check failed');
    this.statusValue = 'running';
    logger.info('Sandbox runner started', { pid: child.pid, socketPath: this.socketPath });
  }

  private async waitForSocket(timeoutMs: number): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (fs.existsSync(this.socketPath)) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    this.statusValue = 'unavailable';
    throw new Error('Sandbox runner socket did not become ready');
  }

  private callRunner<TResult>(
    method: SandboxRunnerRequest['method'],
    params: unknown,
    timeoutMs = 25 * 60 * 1000
  ): Promise<TResult> {
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const socket = net.createConnection({ path: this.socketPath });
      let buffer = '';
      const timeout = setTimeout(() => {
        socket.destroy();
        reject(new Error(`Sandbox runner call timed out: ${method}`));
      }, timeoutMs);

      socket.on('connect', () => {
        socket.write(`${JSON.stringify({ id, method, params } satisfies SandboxRunnerRequest)}\n`);
      });
      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf-8');
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          const response = JSON.parse(line) as SandboxRunnerResponse<TResult>;
          if (response.id !== id) continue;
          clearTimeout(timeout);
          socket.end();
          if (response.error) {
            reject(new Error(response.error));
          } else {
            resolve(response.result as TResult);
          }
        }
      });
      socket.on('error', (error) => {
        clearTimeout(timeout);
        this.statusValue = 'unavailable';
        reject(error);
      });
    });
  }
}
