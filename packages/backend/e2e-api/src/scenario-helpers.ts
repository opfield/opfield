import { asArray, unwrapData } from './api-client.js';
import type { TestCase } from './test-harness.js';
import { expectApiAccessible, expectOk } from './test-harness.js';

export type Row = Record<string, any>;

export function firstId(rows: Row[]) {
  return typeof rows[0]?.id === 'string' ? rows[0].id : null;
}

export function asRow(value: unknown) {
  return unwrapData<Row>(value);
}

export async function listRows(
  ctx: Parameters<TestCase['run']>[0],
  path: string,
  query?: Record<string, string | number>
) {
  const response = await ctx.client.get(path, { query });
  if ((response.status === 403 || response.status === 503) && response.text.includes('"code":"FEATURE_DISABLED"')) {
    return [];
  }
  expectApiAccessible(response, `GET ${path}`);
  return asArray<Row>(response.body);
}

export async function findDockerNode(ctx: Parameters<TestCase['run']>[0]) {
  const nodes = await listRows(ctx, '/api/nodes', { type: 'docker', limit: 20 });
  return nodes.find((row) => row.status === 'online' && row.isConnected !== false) ?? null;
}

export async function findDockerComposeNode(ctx: Parameters<TestCase['run']>[0]) {
  const nodes = await listRows(ctx, '/api/nodes', { type: 'docker', limit: 20 });
  return (
    nodes.find(
      (row) =>
        row.status === 'online' &&
        row.isConnected !== false &&
        (row.capabilities?.dockerComposeV1 === true || row.capabilities?.capabilities?.includes('docker_compose_v1'))
    ) ?? null
  );
}

export async function getSystemConfig(ctx: Parameters<TestCase['run']>[0]) {
  const response = await ctx.client.get('/api/system/config');
  expectOk(response, 'GET /api/system/config');
  return asRow(response.body) as {
    features?: {
      loggingEnabled?: boolean;
    };
  };
}

export function getDockerContainerId(value: unknown) {
  const row = asRow(value);
  return (row.id ?? row.Id) as string | undefined;
}

export async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForContainerVisible(
  ctx: Parameters<TestCase['run']>[0],
  nodeId: string,
  containerName: string
): Promise<Row | null> {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const containers = await listRows(ctx, `/api/docker/nodes/${nodeId}/containers`, { search: containerName });
    const row = containers.find((container) => container.name === containerName || container.Name === containerName);
    if (row && !row._transition) return row;
    await sleep(1000);
  }
  return null;
}

export async function waitForDockerTask(
  ctx: Parameters<TestCase['run']>[0],
  taskId: string,
  timeoutMs = 180_000
): Promise<Row> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await ctx.client.get(`/api/docker/tasks/${encodeURIComponent(taskId)}`);
    expectApiAccessible(response, `GET docker task ${taskId}`);
    const task = asRow(response.body);
    if (task.status === 'succeeded') return task;
    if (task.status === 'failed' || task.status === 'cancelled') {
      throw new Error(`Docker task ${taskId} ${task.status}: ${task.error ?? 'unknown error'}`);
    }
    await sleep(500);
  }
  throw new Error(`Docker task ${taskId} did not finish within ${timeoutMs}ms`);
}

export async function resolveDockerRuntimeImage(ctx: Parameters<TestCase['run']>[0], nodeId: string) {
  if (ctx.config.dockerImage) return ctx.config.dockerImage;

  const images = await listRows(ctx, `/api/docker/nodes/${nodeId}/images`);
  const tags = images.flatMap((image) => (Array.isArray(image.repoTags) ? image.repoTags : []));
  const candidates = ['nginx', 'caddy', 'httpd', 'traefik', 'redis', 'busybox', 'alpine', 'node', 'opfield'];
  for (const candidate of candidates) {
    const tag = tags.find((value) => String(value).toLowerCase().includes(candidate));
    if (tag) return tag;
  }
  return null;
}

export function skipWithoutMutations(ctx: Parameters<NonNullable<TestCase['skip']>>[0]) {
  return ctx.config.allowMutations ? false : 'set OPFIELD_E2E_ALLOW_MUTATIONS=1';
}

export function skipWithoutRuntimeMutations(ctx: Parameters<NonNullable<TestCase['skip']>>[0]) {
  return ctx.config.allowRuntimeMutations ? false : 'set OPFIELD_E2E_ALLOW_RUNTIME_MUTATIONS=1';
}

export function isLocalDockerRuntimeUnavailable(text: string) {
  return (
    text.includes('cannot enter cgroupv2') ||
    text.includes('unable to apply cgroup configuration') ||
    text.includes('operation not permitted')
  );
}
