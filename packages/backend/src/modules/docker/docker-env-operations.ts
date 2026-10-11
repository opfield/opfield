import type { DrizzleExecutor } from '@/db/client.js';
import { appliedLayerKeys, planContainerLayer } from '@/modules/apps/app-container-layer.js';
import type { NodeDispatchService } from '@/services/node-dispatch.service.js';
import type { DockerEnvironmentService } from './docker-environment.service.js';
import type { DockerSecretService } from './docker-secret.service.js';
import { dockerSecretEnvMatcher, dockerSecretEnvOwners } from './docker-secret-env.js';

type DockerDispatchResult = { success: boolean; error?: string; detail?: string };

export interface DockerEnvOperationContext {
  /** Reads what the container received from its app environment layer (never shown or seeded as its own env). */
  db?: DrizzleExecutor;
  nodeDispatch: NodeDispatchService;
  environmentService?: DockerEnvironmentService;
  secretService?: DockerSecretService;
  parseResult(result: DockerDispatchResult): any;
}

export async function getContainerEnv(context: DockerEnvOperationContext, nodeId: string, containerId: string) {
  const result = await context.nodeDispatch.sendDockerContainerCommand(nodeId, 'inspect', { containerId });
  const inspect = context.parseResult(result);
  const allEnv: string[] = inspect?.Config?.Env || [];
  const name = (inspect?.Name ?? '').replace(/^\//, '');

  // Secrets have their own endpoint: the env leaves out every entry that carries one, a deployment slot's link
  // credentials and a Compose service's interpolated secrets included.
  const carriesSecret =
    context.secretService && name
      ? await dockerSecretEnvMatcher(context.secretService, dockerSecretEnvOwners(nodeId, inspect))
      : null;
  const secretFiltered = carriesSecret ? allEnv.filter((entry) => !carriesSecret(entry)) : allEnv;
  // Keys from the app environment layer are the environment's, not the container's own env.
  const layerKeys =
    context.db && name ? new Set(appliedLayerKeys(await planContainerLayer(context.db, nodeId, name))) : new Set();
  const visibleEnv =
    layerKeys.size > 0
      ? secretFiltered.filter((entry) => !layerKeys.has(entry.split('=')[0] ?? entry))
      : secretFiltered;

  if (context.environmentService && name) {
    const storedEnv = await context.environmentService.getDecryptedMap(nodeId, name);
    if (Object.keys(storedEnv).length > 0) {
      const storedList = envMapToList(storedEnv);
      return carriesSecret ? storedList.filter((entry) => !carriesSecret(entry)) : storedList;
    }

    await context.environmentService.seedFromRuntimeIfMissing(nodeId, name, envListToMap(visibleEnv));
  }

  return visibleEnv;
}

export function normalizeEnvRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key.trim().length > 0)
      .map(([key, entryValue]) => [key, String(entryValue ?? '')])
  );
}

export function envListToMap(entries: string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const entry of entries) {
    const idx = entry.indexOf('=');
    if (idx === -1) {
      env[entry] = '';
    } else {
      env[entry.slice(0, idx)] = entry.slice(idx + 1);
    }
  }
  return env;
}

export function envMapToList(env: Record<string, string>): string[] {
  return Object.entries(env).map(([key, value]) => `${key}=${value}`);
}
