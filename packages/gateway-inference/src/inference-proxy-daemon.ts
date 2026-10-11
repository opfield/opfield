import { spawn } from 'node:child_process';
import { syncCodexCatalog } from './codex-catalog.js';
import { inspectCodexConfiguration, resolveCodexPaths } from './codex-config.js';
import type { CredentialStore } from './credentials.js';
import { CliError, redactText } from './errors.js';
import {
  inferenceProxyBaseUrl,
  inferenceProxyInstanceId,
  probeInferenceProxy,
  startInferenceProxy,
} from './inference-proxy.js';
import type { CliPaths } from './paths.js';

const START_TIMEOUT_MS = 5_000;
const STOP_TIMEOUT_MS = 2_000;
const CATALOG_REFRESH_INTERVAL_MS = 60_000;

export interface InferenceProxyDaemonManager {
  ensure(input: {
    paths: CliPaths;
    profileName: string;
    remoteBaseUrl: string;
    runtimeFile: string;
    env?: NodeJS.ProcessEnv;
  }): Promise<{ baseUrl: string }>;
  stop(input: { paths: CliPaths; profileName: string }): Promise<void>;
}

export const inferenceProxyDaemonManager: InferenceProxyDaemonManager = {
  ensure: ensureInferenceProxyDaemon,
  stop: stopInferenceProxyDaemon,
};

export async function runInferenceProxyDaemon(input: {
  paths: CliPaths;
  profileName: string;
  credentials: CredentialStore;
  signal?: AbortSignal;
}): Promise<void> {
  const integrationPaths = resolveCodexPaths(input.paths, input.profileName);
  const configured = await inspectCodexConfiguration({ paths: integrationPaths, profile: input.profileName });
  if (!configured.configured || !configured.baseUrl) {
    throw new CliError('CODEX_NOT_CONFIGURED', 'Opfield inference is not configured. Run setup codex again.');
  }
  const proxy = await startInferenceProxy({
    paths: input.paths,
    profileName: input.profileName,
    remoteBaseUrl: configured.baseUrl,
    getToken: async () => {
      const credential = await input.credentials.getRuntime(input.profileName);
      if (!credential) {
        throw new CliError('RUNTIME_TOKEN_MISSING', 'Opfield inference token is missing. Run setup codex again.');
      }
      return credential.token;
    },
  });
  if (!proxy.owned) return;

  let refreshPromise: Promise<void> | null = null;
  const refreshCatalog = () => {
    if (refreshPromise) return refreshPromise;
    refreshPromise = (async () => {
      const credential = await input.credentials.getRuntime(input.profileName);
      if (!credential) return;
      await syncCodexCatalog({
        modelsUrl: `${configured.baseUrl!.replace(/\/$/, '')}/models`,
        token: credential.token,
        catalogFile: integrationPaths.catalogFile,
        metadataFile: integrationPaths.metadataFile,
        lockFile: integrationPaths.lockFile,
      });
    })().finally(() => {
      refreshPromise = null;
    });
    return refreshPromise;
  };
  const reportRefreshError = (error: unknown) =>
    process.stderr.write(
      `Opfield catalog daemon refresh failed: ${redactText(error instanceof Error ? error.message : String(error))}\n`
    );
  void refreshCatalog().catch(reportRefreshError);
  const refreshTimer = setInterval(() => void refreshCatalog().catch(reportRefreshError), CATALOG_REFRESH_INTERVAL_MS);
  refreshTimer.unref();

  try {
    await waitForShutdown(input.signal);
  } finally {
    clearInterval(refreshTimer);
    await proxy.close();
  }
}

export async function ensureInferenceProxyDaemon(input: {
  paths: CliPaths;
  profileName: string;
  remoteBaseUrl: string;
  runtimeFile: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{ baseUrl: string }> {
  const expectedInstanceId = inferenceProxyInstanceId(input.paths, input.profileName, input.remoteBaseUrl);
  const current = await probeInferenceProxy(input.paths, input.profileName);
  if (current?.instanceId === expectedInstanceId && current.owner === 'daemon') {
    return { baseUrl: inferenceProxyBaseUrl(input.paths, input.profileName) };
  }
  if (current) {
    await terminateProxy(current.pid, input.paths, input.profileName);
  }

  const child = spawn(
    process.execPath,
    [input.runtimeFile, ...(input.paths.homeDir ? ['--home', input.paths.homeDir] : []), '__proxy'],
    {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, ...input.env },
    }
  );
  let spawnError: Error | undefined;
  child.once('error', (error) => {
    spawnError = error;
  });
  child.unref();

  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (spawnError) {
      throw new CliError('INFERENCE_PROXY_START_FAILED', 'Could not start the local inference proxy.', {
        cause: spawnError,
      });
    }
    const health = await probeInferenceProxy(input.paths, input.profileName);
    if (health?.instanceId === expectedInstanceId && health.owner === 'daemon') {
      return { baseUrl: inferenceProxyBaseUrl(input.paths, input.profileName) };
    }
    if (child.exitCode !== null) break;
    await delay(50);
  }

  if (child.pid) {
    try {
      process.kill(child.pid, 'SIGTERM');
    } catch {
      // The failed child has already exited.
    }
  }
  throw new CliError(
    'INFERENCE_PROXY_START_FAILED',
    `The local inference proxy did not start on ${inferenceProxyBaseUrl(input.paths, input.profileName)}.`
  );
}

export async function stopInferenceProxyDaemon(input: { paths: CliPaths; profileName: string }): Promise<void> {
  const health = await probeInferenceProxy(input.paths, input.profileName);
  if (!health || health.owner !== 'daemon') return;
  await terminateProxy(health.pid, input.paths, input.profileName);
}

async function terminateProxy(pid: number, paths: CliPaths, profileName: string): Promise<void> {
  try {
    process.kill(pid, 'SIGTERM');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const health = await probeInferenceProxy(paths, profileName);
    if (!health || health.pid !== pid) return;
    await delay(50);
  }
  throw new CliError('INFERENCE_PROXY_STOP_FAILED', `Local inference proxy process ${pid} did not stop.`);
}

function waitForShutdown(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      process.off('SIGINT', finish);
      process.off('SIGTERM', finish);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    process.once('SIGINT', finish);
    process.once('SIGTERM', finish);
    signal?.addEventListener('abort', finish, { once: true });
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
