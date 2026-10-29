import { createHash, randomUUID } from 'node:crypto';
import type { MatrixContext } from './context.js';
import type { Crawler } from './crawl.js';
import { data, describe, errorCode, expectOk, Failure, ok, type Response, rows, Skip, sleep, waitFor } from './http.js';
import { desiredOf, expectConsumerMatches } from './links.js';
import { httpProbe, type ProbeResult, sseProbe } from './probe.js';
import { runBindingRestartRepro } from './repro.js';

/** 1x1 PNG for the App icon upload. */
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);

function findString(value: unknown, key: RegExp, depth = 0): string | undefined {
  if (!value || typeof value !== 'object' || depth > 4) return undefined;
  for (const [name, item] of Object.entries(value as Record<string, unknown>)) {
    if (key.test(name) && typeof item === 'string' && item) return item;
  }
  for (const item of Object.values(value as Record<string, unknown>)) {
    const nested = findString(item, key, depth + 1);
    if (nested) return nested;
  }
  return undefined;
}

function isRunning(row: any) {
  const inspected = row?.State ?? row?.state;
  if (inspected && typeof inspected === 'object') return inspected.Running === true || inspected.Status === 'running';
  const state = String(inspected ?? row?.status ?? '').toLowerCase();
  return state === 'running' || state.startsWith('up');
}

/** Polls a GET until `status` lands in `done` (returns the row) or `failed` / the deadline (throws). */
async function waitForStatus(
  ctx: MatrixContext,
  label: string,
  path: string,
  template: string,
  done: string[],
  failed: string[],
  timeoutMs: number,
  pick: (body: any) => any = (body) => body
) {
  let last: any;
  let lastResponse: Response | undefined;
  const result = await waitFor(
    async () => {
      lastResponse = await ctx.client.get(path, { template });
      if (!ok(lastResponse)) return undefined;
      last = pick(data<any>(lastResponse));
      const status = String(last?.status ?? last?.state ?? '');
      if (failed.includes(status))
        throw new Failure(
          `${label} ended in status ${status}: ${String(last?.error ?? last?.lastError ?? last?.statusMessage ?? '').slice(0, 200)}`,
          lastResponse
        );
      return done.includes(status) ? last : undefined;
    },
    { timeoutMs, intervalMs: ctx.config.pollMs }
  );
  if (!result)
    throw new Failure(
      `${label} did not reach ${done.join('/')} within ${Math.round(timeoutMs / 60_000)} min (last status ${String(last?.status ?? last?.state ?? lastResponse?.status)})`,
      lastResponse
    );
  return result;
}

async function waitTask(ctx: MatrixContext, taskId: string | undefined, label: string) {
  if (!taskId) return;
  ctx.track({
    kind: 'docker-task',
    label,
    deadlineMs: ctx.config.deadlines.taskMs,
    poll: async () => {
      const task = data<any>(
        await ctx.client.get(`/api/docker/tasks/${taskId}`, { template: '/api/docker/tasks/{id}' })
      );
      const state = String(task?.status ?? 'unknown');
      return { state, terminal: ['succeeded', 'failed', 'cancelled'].includes(state) };
    },
  });
  await waitForStatus(
    ctx,
    label,
    `/api/docker/tasks/${taskId}`,
    '/api/docker/tasks/{id}',
    ['succeeded'],
    ['failed', 'cancelled'],
    ctx.config.deadlines.taskMs
  );
}

async function probeUntil(
  url: string,
  options: { host?: string; expect: (status: number, body: string) => boolean; timeoutMs: number; intervalMs: number }
) {
  let last: ProbeResult = { status: 0, body: '' };
  const hit = await waitFor(
    async () => {
      last = await httpProbe(url, { host: options.host });
      return options.expect(last.status, last.body) ? last : undefined;
    },
    { timeoutMs: options.timeoutMs, intervalMs: options.intervalMs }
  );
  return { hit, last };
}

type DockerState = { web?: { id: string; name: string } };

export async function runRuntime(ctx: MatrixContext, crawler: Crawler | undefined) {
  const docker: DockerState = {};
  const storage: { postgres?: any; s3?: any; s3ConnectionId?: string; bucket?: string } = {};
  await Promise.all([dockerLane(ctx, docker), storageLane(ctx, storage), miscLane(ctx)]);
  await crossLane(ctx, docker, storage);
  void crawler;
}

const pulled = new Map<string, Promise<void>>();

/** Containers need their image on the node first; pull once per node and image. */
async function ensureImage(ctx: MatrixContext, nodeId: string, imageRef: string) {
  const key = `${nodeId}|${imageRef}`;
  if (!pulled.has(key))
    pulled.set(
      key,
      (async () => {
        const response = await ctx.client.post(
          `/api/docker/nodes/${nodeId}/images/pull-sync`,
          { imageRef },
          {
            template: '/api/docker/nodes/{nodeId}/images/pull-sync',
            timeoutMs: 300_000,
          }
        );
        expectOk(response, `pull ${imageRef}`, {
          method: 'POST',
          path: '/api/docker/nodes/{nodeId}/images/pull-sync',
          body: { imageRef },
        });
        await waitTask(ctx, data<any>(response)?.taskId, `pull ${imageRef}`);
      })()
    );
  await pulled.get(key);
}

async function createContainer(ctx: MatrixContext, nodeId: string, name: string, extra: Record<string, unknown>) {
  await ensureImage(ctx, nodeId, String(extra.image ?? 'nginx:alpine'));
  const body = {
    image: 'nginx:alpine',
    name,
    restartPolicy: 'unless-stopped',
    labels: { 'opfield.matrix': ctx.config.seed },
    ...extra,
  };
  const response = await ctx.client.post(`/api/docker/nodes/${nodeId}/containers`, body, {
    template: '/api/docker/nodes/{nodeId}/containers',
    timeoutMs: 300_000,
  });
  expectOk(response, `create container ${name}`, {
    method: 'POST',
    path: '/api/docker/nodes/{nodeId}/containers',
    body,
  });
  const created = data<any>(response);
  ctx.onCleanup(`container ${name}`, () => removeContainer(ctx, nodeId, name));
  await waitTask(ctx, created?.taskId ?? created?.task?.id, `container ${name} create task`);
  const row = await waitFor(
    async () => {
      const found = await ctx.client.get(`/api/docker/nodes/${nodeId}/containers/by-name/${encodeURIComponent(name)}`, {
        template: '/api/docker/nodes/{nodeId}/containers/by-name/{containerName}',
      });
      return ok(found) && data<any>(found) ? data<any>(found) : undefined;
    },
    { timeoutMs: ctx.config.deadlines.taskMs, intervalMs: ctx.config.pollMs }
  );
  if (!row) throw new Error(`container ${name} never became visible`);
  const id = String(row.id ?? row.Id ?? created?.id ?? name);
  if (!isRunning(row)) {
    const start = await ctx.client.post(
      `/api/docker/nodes/${nodeId}/containers/${encodeURIComponent(id)}/start`,
      undefined,
      {
        template: '/api/docker/nodes/{nodeId}/containers/{containerId}/start',
      }
    );
    expectOk(start, `start container ${name}`);
    await waitTask(ctx, data<any>(start)?.taskId, `container ${name} start task`);
  }
  const running = await waitFor(
    async () => {
      const found = await ctx.client.get(`/api/docker/nodes/${nodeId}/containers/${encodeURIComponent(id)}`, {
        template: '/api/docker/nodes/{nodeId}/containers/{containerId}',
      });
      return ok(found) && isRunning(data<any>(found)) ? data<any>(found) : undefined;
    },
    { timeoutMs: ctx.config.deadlines.taskMs, intervalMs: ctx.config.pollMs }
  );
  if (!running)
    throw new Error(
      `container ${name} is not running ${Math.round(ctx.config.deadlines.taskMs / 60_000)} min after create/start`
    );
  return { id, name };
}

async function dockerLane(ctx: MatrixContext, state: DockerState) {
  const dockerNode = ctx.node('docker');
  await ctx.step('runtime:docker container lifecycle + published port', async () => {
    const node = ctx.requireNode('docker');
    state.web = await createContainer(ctx, node.nodeId, ctx.name('web'), {
      ports: [{ hostPort: 18080, containerPort: 80 }],
    });
    const base = `/api/docker/nodes/${node.nodeId}/containers/${encodeURIComponent(state.web.id)}`;
    for (const [suffix, template] of [
      ['/logs', '/api/docker/nodes/{nodeId}/containers/{containerId}/logs'],
      ['/stats', '/api/docker/nodes/{nodeId}/containers/{containerId}/stats'],
      ['/top', '/api/docker/nodes/{nodeId}/containers/{containerId}/top'],
      ['/env', '/api/docker/nodes/{nodeId}/containers/{containerId}/env'],
    ] as const)
      expectOk(await ctx.client.get(`${base}${suffix}`, { template }), `GET container ${suffix}`);
    if (!node.address) throw new Skip('docker node address unknown for the published-port probe');
    const { hit, last } = await probeUntil(`http://${node.address}:18080/`, {
      expect: (status, body) => status === 200 && /nginx/i.test(body),
      timeoutMs: 120_000,
      intervalMs: ctx.config.pollMs,
    });
    if (!hit)
      throw new Error(
        `published port 18080 on the docker node never served nginx (last ${last.status} ${last.error ?? ''})`
      );
    const restart = await ctx.client.post(
      `${base}/restart`,
      {},
      { template: '/api/docker/nodes/{nodeId}/containers/{containerId}/restart' }
    );
    expectOk(restart, 'restart container');
    await waitTask(ctx, data<any>(restart)?.taskId, 'container restart task');
    const back = await probeUntil(`http://${node.address}:18080/`, {
      expect: (status) => status === 200,
      timeoutMs: 120_000,
      intervalMs: ctx.config.pollMs,
    });
    if (!back.hit) throw new Error('container did not serve again within 2 min after restart');
  });

  await ctx.step('runtime:docker deployment blue/green', async () => {
    const node = ctx.requireNode('docker');
    const body = {
      name: ctx.name('deploy'),
      image: 'nginx:alpine',
      routes: [{ hostPort: 18081, containerPort: 80, isPrimary: true }],
      health: {
        path: '/',
        timeoutSeconds: 5,
        intervalSeconds: 3,
        successThreshold: 1,
        startupGraceSeconds: 2,
        deployTimeoutSeconds: 240,
      },
      drainSeconds: 2,
    };
    const created = await ctx.client.post(`/api/docker/nodes/${node.nodeId}/deployments`, body, {
      template: '/api/docker/nodes/{nodeId}/deployments',
      timeoutMs: 300_000,
    });
    expectOk(created, 'create deployment', { method: 'POST', path: '/api/docker/nodes/{nodeId}/deployments', body });
    const deployment = data<any>(created);
    const id = String(deployment?.id ?? deployment?.deployment?.id);
    const path = `/api/docker/nodes/${node.nodeId}/deployments/${id}`;
    const template = '/api/docker/nodes/{nodeId}/deployments/{deploymentId}';
    ctx.onCleanup(`deployment ${id}`, async () => {
      await removeOrThrow(ctx, path, { template });
    });
    const pick = (value: any) => value?.deployment ?? value;
    ctx.track({
      kind: 'docker-deployment',
      label: 'matrix deployment',
      deadlineMs: ctx.config.deadlines.workloadMs,
      poll: async () => {
        const current = pick(data<any>(await ctx.client.get(path, { template })));
        const status = String(current?.status ?? 'missing');
        return { state: status, terminal: !['creating', 'deploying', 'switching', 'deleting'].includes(status) };
      },
    });
    let current = pick(data<any>(await ctx.client.get(path, { template })));
    if (current?.status !== 'ready') {
      const deploy = await ctx.client.post(`${path}/deploy`, {}, { template: `${template}/deploy` });
      if (!ok(deploy) && deploy.status !== 409) expectOk(deploy, 'deploy');
      current = await waitForStatus(
        ctx,
        'deployment',
        path,
        template,
        ['ready'],
        ['failed', 'degraded'],
        ctx.config.deadlines.workloadMs,
        pick
      );
    }
    if (node.address) {
      const { hit, last } = await probeUntil(`http://${node.address}:18081/`, {
        expect: (status) => status === 200,
        timeoutMs: 120_000,
        intervalMs: ctx.config.pollMs,
      });
      if (!hit) throw new Error(`deployment route 18081 never answered 200 (last ${last.status} ${last.error ?? ''})`);
    }
    // A second deploy switches slots; the route must keep answering.
    const redeploy = await ctx.client.post(
      `${path}/deploy`,
      { env: { MX_ROUND: '2' } },
      { template: `${template}/deploy` }
    );
    expectOk(redeploy, 'redeploy');
    await sleep(ctx.config.pollMs);
    await waitForStatus(
      ctx,
      'deployment redeploy',
      path,
      template,
      ['ready'],
      ['failed', 'degraded'],
      ctx.config.deadlines.workloadMs,
      pick
    );
    const removed = await ctx.client.delete(path, { template });
    expectOk(removed, 'delete deployment');
    const gone = await waitFor(
      async () => ((await ctx.client.get(path, { template })).status === 404 ? true : undefined),
      { timeoutMs: 120_000, intervalMs: ctx.config.pollMs }
    );
    if (!gone) throw new Error('deleted deployment is still readable 2 min later');
  });

  await ctx.step('runtime:docker compose project', async () => {
    const node = ctx.requireNode('docker');
    const projectName = ctx.name('compose');
    const yaml = [
      'services:',
      '  app:',
      '    image: nginx:alpine',
      '    restart: unless-stopped',
      '    mem_limit: 64m',
      '',
    ].join('\n');
    const create = await ctx.client.post(
      `/api/docker/nodes/${node.nodeId}/compose-projects`,
      { projectName, yaml, variables: {}, secretKeys: [] },
      { template: '/api/docker/nodes/{nodeId}/compose-projects' }
    );
    expectOk(create, 'create compose project');
    const created = data<any>(create);
    const projectId = created?.project?.id as string;
    const revisionId = created?.revision?.id as string;
    const projectPath = `/api/docker/nodes/${node.nodeId}/compose-projects/${projectId}`;
    ctx.onCleanup(`compose ${projectName}`, async () => {
      const down = await ctx.client.post(
        `${projectPath}/actions/down`,
        { idempotencyKey: randomUUID(), removeOrphans: true, volumeNames: [] },
        {
          template: '/api/docker/nodes/{nodeId}/compose-projects/{projectId}/actions/{action}',
        }
      );
      if (ok(down)) await sleep(5000);
      await ctx.client.delete(projectPath, { template: '/api/docker/nodes/{nodeId}/compose-projects/{projectId}' });
    });
    const action = async (name: string, body: Record<string, unknown>) => {
      const response = await ctx.client.post(
        `${projectPath}/actions/${name}`,
        { idempotencyKey: randomUUID(), removeOrphans: false, volumeNames: [], ...body },
        {
          template: '/api/docker/nodes/{nodeId}/compose-projects/{projectId}/actions/{action}',
        }
      );
      expectOk(response, `compose ${name}`);
      const operationId = data<any>(response)?.id as string;
      ctx.track({
        kind: 'compose-operation',
        label: `compose ${name}`,
        deadlineMs: ctx.config.deadlines.workloadMs,
        poll: async () => {
          const operation = rows(await ctx.client.get(`${projectPath}/operations`)).find(
            (row) => row.id === operationId
          );
          const status = String(operation?.status ?? 'missing');
          // A deleted project takes its operations with it.
          return { state: status, terminal: ['succeeded', 'failed', 'cancelled', 'missing'].includes(status) };
        },
      });
      const done = await waitFor(
        async () => {
          const operation = rows(
            await ctx.client.get(`${projectPath}/operations`, {
              template: '/api/docker/nodes/{nodeId}/compose-projects/{projectId}/operations',
            })
          ).find((row) => row.id === operationId);
          if (operation?.status === 'failed' || operation?.status === 'cancelled')
            throw new Error(`compose ${name} ${operation.status}: ${String(operation.error ?? '').slice(0, 200)}`);
          return operation?.status === 'succeeded' ? operation : undefined;
        },
        { timeoutMs: ctx.config.deadlines.workloadMs, intervalMs: ctx.config.pollMs }
      );
      if (!done)
        throw new Error(
          `compose ${name} did not finish within ${Math.round(ctx.config.deadlines.workloadMs / 60_000)} min`
        );
    };
    await action('apply', { revisionId });
    const project = data<any>(
      await ctx.client.get(projectPath, { template: '/api/docker/nodes/{nodeId}/compose-projects/{projectId}' })
    );
    if (!JSON.stringify(project ?? {}).includes('running'))
      throw new Error(
        `compose project applied but no service reports running: ${JSON.stringify(project?.project?.status ?? project?.status)}`
      );
    await action('down', {});
  });

  void dockerNode;
}

async function storageLane(
  ctx: MatrixContext,
  state: { postgres?: any; s3?: any; s3ConnectionId?: string; bucket?: string; postgresConnectionId?: string } & Record<
    string,
    any
  >
) {
  await ctx.step('runtime:managed postgres create + data round-trip', async () => {
    const node = ctx.requireNode('storage');
    const catalog = await ctx.client.get('/api/databases/managed/catalog');
    expectOk(catalog, 'managed database catalog');
    const version = pickVersion(data(catalog), 'postgres');
    if (!version) throw new Skip('managed database catalog offers no PostgreSQL version');
    const body = {
      name: ctx.name('pg'),
      type: 'postgres',
      version,
      nodeId: node.nodeId,
      storageSizeGb: 1,
      cpuCores: 0.5,
      memoryMb: 512,
      databaseName: 'mx',
    };
    const created = await ctx.client.post('/api/databases/managed', body, { timeoutMs: 300_000 });
    expectOk(created, 'create managed postgres', { method: 'POST', path: '/api/databases/managed', body });
    const id = String(data<any>(created)?.id);
    const path = `/api/databases/managed/${id}`;
    ctx.onCleanup(`managed postgres ${id}`, async () => {
      await removeOrThrow(ctx, path, { template: '/api/databases/managed/{id}' });
      await waitFor(
        async () =>
          (await ctx.client.get(path, { template: '/api/databases/managed/{id}' })).status === 404 ? true : undefined,
        {
          timeoutMs: 180_000,
          intervalMs: ctx.config.pollMs,
        }
      );
    });
    trackStatus(ctx, 'managed-postgres', path, '/api/databases/managed/{id}', ['creating', 'updating', 'deleting']);
    const row = await waitForStatus(
      ctx,
      'managed postgres',
      path,
      '/api/databases/managed/{id}',
      ['ready'],
      ['error'],
      ctx.config.deadlines.workloadMs
    );
    state.postgres = row;
    const connectionId = row.databaseConnectionId ?? findString(row, /databaseConnectionId/);
    if (!connectionId) throw new Error('ready managed postgres carries no databaseConnectionId');
    state.postgresConnectionId = connectionId;
    const query = async (sql: string) => {
      const response = await ctx.client.post(
        `/api/databases/${connectionId}/postgres/query`,
        { sql, maxRows: 10 },
        {
          template: '/api/databases/{id}/postgres/query',
          timeoutMs: 120_000,
        }
      );
      expectOk(response, `SQL ${sql.split(' ').slice(0, 3).join(' ')}`, {
        method: 'POST',
        path: '/api/databases/{id}/postgres/query',
        body: { sql },
      });
      return data<any>(response);
    };
    const marker = `mx-${ctx.config.seed}-${randomUUID().slice(0, 8)}`;
    await waitFor(
      async () => {
        const response = await ctx.client.post(
          `/api/databases/${connectionId}/postgres/query`,
          { sql: 'select 1 as ok', maxRows: 1 },
          {
            template: '/api/databases/{id}/postgres/query',
            allow5xx: true,
          }
        );
        return ok(response) ? true : undefined;
      },
      { timeoutMs: 120_000, intervalMs: ctx.config.pollMs }
    );
    await query('create table if not exists mx_matrix (id serial primary key, marker text not null)');
    await query(`insert into mx_matrix (marker) values ('${marker}')`);
    const result = await query('select marker from mx_matrix order by id desc limit 1');
    if (!JSON.stringify(result).includes(marker))
      throw new Error(`PostgreSQL did not return the written marker: ${JSON.stringify(result).slice(0, 200)}`);
  });

  await ctx.step('runtime:managed S3 create + object round-trip', async () => {
    const node = ctx.requireNode('storage');
    const catalog = await ctx.client.get('/api/managed-storage/catalog');
    expectOk(catalog, 'managed storage catalog');
    const version = pickVersion(data(catalog), 'seaweedfs');
    if (!version) throw new Skip('managed storage catalog offers no version');
    const body = { name: ctx.name('s3'), version, nodeId: node.nodeId, storageSizeGb: 1, cpuCores: 0.5, memoryMb: 512 };
    const created = await ctx.client.post('/api/managed-storage', body, { timeoutMs: 300_000 });
    expectOk(created, 'create managed storage', { method: 'POST', path: '/api/managed-storage', body });
    const id = String(data<any>(created)?.id);
    const path = `/api/managed-storage/${id}`;
    ctx.onCleanup(`managed storage ${id}`, async () => {
      await removeOrThrow(ctx, path, { template: '/api/managed-storage/{id}' });
      await waitFor(
        async () =>
          (await ctx.client.get(path, { template: '/api/managed-storage/{id}' })).status === 404 ? true : undefined,
        {
          timeoutMs: 180_000,
          intervalMs: ctx.config.pollMs,
        }
      );
    });
    trackStatus(ctx, 'managed-s3', path, '/api/managed-storage/{id}', ['creating', 'updating', 'deleting']);
    const row = await waitForStatus(
      ctx,
      'managed S3',
      path,
      '/api/managed-storage/{id}',
      ['ready'],
      ['error'],
      ctx.config.deadlines.workloadMs
    );
    state.s3 = row;
    const connectionId = findString(row, /^(objectStorageConnectionId|storageConnectionId|connectionId)$/);
    if (!connectionId) throw new Error('ready managed S3 carries no object storage connection id');
    state.s3ConnectionId = connectionId;
    const bucket = ctx.name('bucket');
    const createBucket = await waitFor(
      async () => {
        const response = await ctx.client.post(
          `/api/object-storage/${connectionId}/buckets`,
          { bucket },
          { template: '/api/object-storage/{id}/buckets' }
        );
        if (ok(response) || response.status === 409) return response;
        return response.status >= 500
          ? undefined
          : (() => {
              throw new Failure(`create bucket: ${describe(response)}`, response);
            })();
      },
      { timeoutMs: 120_000, intervalMs: ctx.config.pollMs }
    );
    if (!createBucket) throw new Error('bucket creation kept failing for 2 min after the store reported ready');
    state.bucket = bucket;
    const payload = `opfield matrix ${ctx.config.seed} ${randomUUID()}`;
    const key = 'mx/object.txt';
    const upload = await ctx.client.call('POST', `/api/object-storage/${connectionId}/objects/upload`, {
      template: '/api/object-storage/{id}/objects/upload',
      query: { bucket, key, contentType: 'text/plain' },
      body: payload,
      headers: { 'Content-Type': 'application/octet-stream' },
    });
    expectOk(upload, 'upload object');
    const download = await ctx.client.get(`/api/object-storage/${connectionId}/objects/download`, {
      template: '/api/object-storage/{id}/objects/download',
      query: { bucket, key },
    });
    expectOk(download, 'download object');
    if (download.text !== payload)
      throw new Error(`downloaded object differs from the upload (${download.text.length} vs ${payload.length} bytes)`);
    const listed = await ctx.client.get(`/api/object-storage/${connectionId}/objects`, {
      template: '/api/object-storage/{id}/objects',
      query: { bucket, prefix: 'mx/' },
    });
    expectOk(listed, 'list objects');
    if (!listed.text.includes('object.txt')) throw new Error('uploaded object is not in the object list');
  });

  await ctx.step('runtime:database backup to managed S3', async () => {
    if (!state.postgresConnectionId) throw new Skip('managed postgres did not become ready');
    if (!state.s3ConnectionId || !state.bucket) throw new Skip('managed S3 did not become ready');
    const node = ctx.requireNode('storage');
    const body = {
      destinationId: state.s3ConnectionId,
      bucket: state.bucket,
      prefix: 'backups',
      executorNodeId: node.nodeId,
      timezone: 'UTC',
      retentionCount: 2,
      limits: { workspaceBytes: 1_073_741_824, timeoutSeconds: 900, cpuCores: 1, memoryMb: 512 },
      enabled: true,
    };
    const base = `/api/databases/${state.postgresConnectionId}/backups`;
    const policy = await ctx.client.post(`${base}/policies`, body, {
      template: '/api/databases/{id}/backups/policies',
    });
    expectOk(policy, 'create backup policy', { method: 'POST', path: '/api/databases/{id}/backups/policies', body });
    const policyId = String(data<any>(policy)?.id);
    ctx.onCleanup(`backup policy ${policyId}`, async () => {
      await removeOrThrow(ctx, `${base}/policies/${policyId}`, {
        template: '/api/databases/{id}/backups/policies/{policyId}',
      });
    });
    const run = await ctx.client.post(`${base}/policies/${policyId}/runs`, undefined, {
      template: '/api/databases/{id}/backups/policies/{policyId}/runs',
    });
    expectOk(run, 'start backup run');
    const runId = String(data<any>(run)?.id ?? data<any>(run)?.run?.id);
    const runPath = `${base}/runs/${runId}`;
    // Backup history pins the destination storage (STORAGE_BACKUP_HISTORY_EXISTS): the run goes before the store.
    ctx.onCleanup(`backup run ${runId}`, async () => {
      await removeOrThrow(ctx, runPath, {
        template: '/api/databases/{id}/backups/runs/{runId}',
        query: { artifacts: 'delete' },
      });
    });
    trackStatus(
      ctx,
      'backup-run',
      runPath,
      '/api/databases/{id}/backups/runs/{runId}',
      ['queued', 'running'],
      (value) => value?.run ?? value
    );
    await waitForStatus(
      ctx,
      'backup run',
      runPath,
      '/api/databases/{id}/backups/runs/{runId}',
      ['completed'],
      ['failed', 'cancelled'],
      ctx.config.deadlines.workloadMs,
      (value) => value?.run ?? value
    );
    const objects = await ctx.client.get(`/api/object-storage/${state.s3ConnectionId}/objects`, {
      template: '/api/object-storage/{id}/objects',
      query: { bucket: state.bucket, prefix: 'backups/' },
    });
    if (ok(objects) && !/backups\//.test(objects.text) && rows(objects).length === 0)
      throw new Error('backup run completed but the destination prefix holds no objects');
  });
}

function pickVersion(catalog: any, engine: string): string | undefined {
  const text = JSON.stringify(catalog ?? {});
  const engines: any[] = Array.isArray(catalog)
    ? catalog
    : (catalog?.engines ?? catalog?.types ?? catalog?.items ?? Object.values(catalog ?? {}));
  for (const entry of engines) {
    if (!entry || typeof entry !== 'object') continue;
    const name = String(entry.type ?? entry.engine ?? entry.id ?? entry.name ?? '');
    if (name && !name.includes(engine)) continue;
    const versions = entry.versions ?? entry.supportedVersions ?? entry.options;
    if (Array.isArray(versions) && versions.length) {
      const preferred = versions.find((version: any) => version?.default || version?.recommended) ?? versions[0];
      return String(typeof preferred === 'object' ? (preferred.version ?? preferred.id ?? preferred.value) : preferred);
    }
    if (entry.defaultVersion) return String(entry.defaultVersion);
  }
  const match = new RegExp(`"${engine}"[^\\]]*?"(?:version|defaultVersion)"\\s*:\\s*"([^"]+)"`).exec(text);
  return match?.[1];
}

function trackStatus(
  ctx: MatrixContext,
  kind: string,
  path: string,
  template: string,
  transient: string[],
  pick: (value: any) => any = (value) => value
) {
  ctx.track({
    kind,
    label: `${kind} ${path}`,
    deadlineMs: ctx.config.deadlines.workloadMs,
    poll: async () => {
      const response = await ctx.client.get(path, { template });
      if (response.status === 404) return { state: 'gone', terminal: true };
      const status = String(pick(data<any>(response))?.status ?? `http-${response.status}`);
      return { state: status, terminal: !transient.includes(status) };
    },
  });
}

async function miscLane(ctx: MatrixContext) {
  await ctx.step('runtime:PKI issue + revoke + CRL', async () => {
    const ca = await ctx.client.post('/api/cas', {
      commonName: `${ctx.name('ca')}`,
      keyAlgorithm: 'ecdsa-p256',
      validityYears: 1,
      maxValidityDays: 30,
    });
    if (ca.status === 403 && errorCode(ca) === 'FEATURE_DISABLED') throw new Skip('PKI is disabled');
    expectOk(ca, 'create CA');
    const caId = String(data<any>(ca)?.id);
    ctx.onCleanup(`CA ${caId}`, async () => {
      await removeOrThrow(ctx, `/api/cas/${caId}`, { template: '/api/cas/{id}' });
    });
    const cert = await ctx.client.post('/api/certificates', {
      caId,
      type: 'tls-server',
      commonName: `${ctx.name('cert')}.example.test`,
      sans: [`${ctx.name('san')}.example.test`],
      keyAlgorithm: 'ecdsa-p256',
      validityDays: 7,
    });
    expectOk(cert, 'issue certificate');
    const certRow = data<any>(cert);
    const certId = String(certRow?.certificate?.id ?? certRow?.id);
    ctx.onCleanup(`certificate ${certId}`, async () => {
      await removeOrThrow(ctx, `/api/certificates/${certId}`, { template: '/api/certificates/{id}' });
    });
    expectOk(
      await ctx.client.get(`/api/certificates/${certId}/chain`, { template: '/api/certificates/{id}/chain' }),
      'certificate chain'
    );
    const crlBefore = await ctx.client.get(`/pki/crl/${caId}`, { template: '/pki/crl/{caId}' });
    expectOk(
      await ctx.client.post(
        `/api/certificates/${certId}/revoke`,
        { reason: 'cessationOfOperation' },
        { template: '/api/certificates/{id}/revoke' }
      ),
      'revoke'
    );
    const after = data<any>(
      await ctx.client.get(`/api/certificates/${certId}`, { template: '/api/certificates/{id}' })
    );
    if ((after?.certificate ?? after)?.status !== 'revoked')
      throw new Error(`revoked certificate reads back as ${(after?.certificate ?? after)?.status}`);
    const crlAfter = await waitFor(
      async () => {
        const crl = await ctx.client.get(`/pki/crl/${caId}`, { template: '/pki/crl/{caId}' });
        return ok(crl) && crl.text.length > 0 && crl.text !== crlBefore.text ? crl : undefined;
      },
      { timeoutMs: 60_000, intervalMs: ctx.config.pollMs }
    );
    if (!crlAfter) throw new Error('the CA CRL did not change within 60 s after a revocation');
  });

  await ctx.step('runtime:App with icon upload', async () => {
    const created = await ctx.client.post('/api/apps', { name: ctx.name('app'), description: 'opfield matrix' });
    expectOk(created, 'create app');
    const appId = String(data<any>(created)?.id);
    ctx.onCleanup(`app ${appId}`, async () => {
      await removeOrThrow(ctx, `/api/apps/${appId}`, { template: '/api/apps/{id}' });
    });
    const form = new FormData();
    form.append('logo', new Blob([PNG_1PX], { type: 'image/png' }), 'logo.png');
    const upload = await ctx.client.call('PUT', `/api/apps/${appId}/logo`, {
      template: '/api/apps/{id}/logo',
      body: form,
    });
    expectOk(upload, 'upload app logo');
    const app = data<any>(await ctx.client.get(`/api/apps/${appId}`, { template: '/api/apps/{id}' }));
    const logo = findString(app, /logo/i);
    if (!logo) throw new Error('app has no logo reference after a successful upload');
    if (logo.startsWith('/') || logo.startsWith('http')) {
      const image = await ctx.client.get(logo, { template: '<app logo url>' });
      if (!ok(image)) throw new Error(`app logo URL answers ${image.status}`);
    }
    expectOk(
      await ctx.client.delete(`/api/apps/${appId}/logo`, { template: '/api/apps/{id}/logo' }),
      'remove app logo'
    );
    expectOk(await ctx.client.delete(`/api/apps/${appId}`, { template: '/api/apps/{id}' }), 'delete app');
  });

  await ctx.step('runtime:Pages upload + publish through a route', async () => {
    const options = await ctx.client.get('/api/pages/placement-options');
    if (options.status === 403) throw new Skip(`Pages unavailable: ${errorCode(options) ?? options.status}`);
    expectOk(options, 'pages placement options');
    const nginx = ctx.requireNode('nginx');
    const created = await ctx.client.post('/api/pages', { name: ctx.name('site'), nodeId: nginx.nodeId });
    if (created.status === 403 || errorCode(created) === 'LICENSE_FEATURE_REQUIRED')
      throw new Skip(`Pages refused: ${errorCode(created) ?? created.status}`);
    expectOk(created, 'create pages project', { method: 'POST', path: '/api/pages', body: { nodeId: nginx.nodeId } });
    const projectId = String(data<any>(created)?.id);
    ctx.onCleanup(`pages ${projectId}`, async () => {
      // A project refuses deletion while it has Deployments, and a tagged Deployment is protected: tags, Deployments, project.
      for (const tag of rows(
        await ctx.client.get(`/api/pages/${projectId}/tags`, { template: '/api/pages/{projectId}/tags' })
      ).filter((item) => !['latest'].includes(String(item.name ?? item.tag))))
        await removeOrThrow(
          ctx,
          `/api/pages/${projectId}/tags/${encodeURIComponent(String(tag.name ?? tag.tag ?? tag.id))}`,
          { template: '/api/pages/{projectId}/tags/{tag}' }
        );
      for (const deployment of rows(
        await ctx.client.get(`/api/pages/${projectId}/deployments`, { template: '/api/pages/{projectId}/deployments' })
      ))
        await removeOrThrow(ctx, `/api/pages/${projectId}/deployments/${deployment.id}`, {
          template: '/api/pages/{projectId}/deployments/{deploymentId}',
        });
      // Deployment removal finishes in the background; the project delete answers 409 until it has.
      let last: Response | undefined;
      const removed = await waitFor(
        async () => {
          last = await ctx.client.delete(`/api/pages/${projectId}`, { template: '/api/pages/{id}' });
          return ok(last) || last.status === 404 ? true : last.status === 409 ? undefined : false;
        },
        { timeoutMs: 120_000, intervalMs: ctx.config.pollMs }
      );
      if (removed !== true) throw new Failure(`DELETE /api/pages/{id}: ${last ? describe(last) : 'no response'}`, last);
    });
    const html = `<!doctype html><title>mx</title><p>opfield matrix ${ctx.config.seed}</p>`;
    const sha256 = createHash('sha256').update(html).digest('hex');
    const upload = await ctx.client.post('/api/pages-deploy/deployments', {
      projectId,
      declaredSizeBytes: Buffer.byteLength(html),
      sha256,
      format: 'html',
      source: { provider: 'manual' },
    });
    expectOk(upload, 'create pages upload');
    const uploadId = String(data<any>(upload)?.upload?.id);
    const chunk = await ctx.client.call('PUT', `/api/pages-deploy/uploads/${uploadId}/chunks`, {
      template: '/api/pages-deploy/uploads/{id}/chunks',
      body: html,
      headers: { 'Content-Type': 'application/octet-stream', 'Upload-Offset': '0' },
    });
    expectOk(chunk, 'upload pages chunk');
    const finalized = await ctx.client.post(`/api/pages-deploy/uploads/${uploadId}/finalize`, undefined, {
      template: '/api/pages-deploy/uploads/{id}/finalize',
    });
    expectOk(finalized, 'finalize pages upload');
    const deploymentId = String(data<any>(finalized)?.deployment?.id);
    const deploymentPath = `/api/pages/${projectId}/deployments/${deploymentId}`;
    trackStatus(
      ctx,
      'pages-deployment',
      deploymentPath,
      '/api/pages/{projectId}/deployments/{deploymentId}',
      ['uploading', 'validating', 'stored', 'staging', 'cleaning'],
      (value) => value?.deployment ?? value
    );
    await waitForStatus(
      ctx,
      'pages deployment',
      deploymentPath,
      '/api/pages/{projectId}/deployments/{deploymentId}',
      ['ready'],
      ['failed'],
      ctx.config.deadlines.workloadMs,
      (value) => value?.deployment ?? value
    );
    const tagged = await ctx.client.put(
      `/api/pages/${projectId}/tags/production`,
      { deploymentId },
      { template: '/api/pages/{projectId}/tags/{tag}' }
    );
    expectOk(tagged, 'tag the deployment');
    const tags = rows(
      await ctx.client.get(`/api/pages/${projectId}/tags`, { template: '/api/pages/{projectId}/tags' })
    );
    const tagId = (tags.find((tag) => tag.name === 'production' || tag.tag === 'production') ?? tags[0])?.id;
    if (!tagId) throw new Error('a tagged Pages deployment lists no tag');
    if (!nginx.address) return;
    const domain = `${ctx.name('site')}.example.test`;
    const route = await ctx.client.post('/api/proxy-hosts', {
      type: 'proxy',
      nodeId: nginx.nodeId,
      domainNames: [domain],
      createMissingDomains: true,
      upstreamKind: 'pages',
      pageProjectId: projectId,
      pageTagId: tagId,
    });
    expectOk(route, 'route to pages');
    const routeId = String(data<any>(route)?.id);
    ctx.onCleanup(`route ${routeId}`, async () => {
      await removeOrThrow(ctx, `/api/proxy-hosts/${routeId}`, { template: '/api/proxy-hosts/{id}' });
    });
    const { hit, last } = await probeUntil(`http://${nginx.address}/`, {
      host: domain,
      expect: (status, body) => status === 200 && body.includes(`opfield matrix ${ctx.config.seed}`),
      timeoutMs: 180_000,
      intervalMs: ctx.config.pollMs,
    });
    if (!hit)
      throw new Error(
        `the pages route never served the uploaded page (last ${last.status} ${last.error ?? last.body.slice(0, 80)})`
      );
    expectOk(
      await ctx.client.delete(`/api/proxy-hosts/${routeId}`, { template: '/api/proxy-hosts/{id}' }),
      'delete pages route'
    );
  });

  await ctx.step('runtime:relay pool membership + drain/resume', async () => {
    const relay = ctx.requireNode('relay');
    const pool = await ctx.client.get('/api/system/relay');
    ctx.undocumentedUsed.add('GET /api/system/relay');
    expectOk(pool, 'GET relay pool');
    const instances = rows(pool).length ? rows(pool) : (data<any>(pool)?.instances ?? data<any>(pool)?.relays ?? []);
    const instance = (instances as any[]).find(
      (row) => row.nodeId === relay.nodeId || JSON.stringify(row).includes(relay.nodeId)
    );
    if (!instance)
      throw new Error(`the fleet relay node is not in the relay pool (${instances.length} instances listed)`);
    const healthy = await waitFor(
      async () => {
        const current =
          (rows(await ctx.client.get('/api/system/relay')) as any[]).find((row) => row.id === instance.id) ?? instance;
        return /connected|online|active|healthy|ready/i.test(
          JSON.stringify([current.status, current.state, current.health])
        )
          ? current
          : undefined;
      },
      { timeoutMs: 120_000, intervalMs: ctx.config.pollMs }
    );
    if (!healthy)
      throw new Error(
        `fleet relay instance never reports a healthy state: ${JSON.stringify([instance.status, instance.state]).slice(0, 120)}`
      );
    const iid = encodeURIComponent(String(instance.id ?? instance.instanceId));
    ctx.undocumentedUsed.add('POST /api/system/relay/instances/{instanceId}/drain');
    expectOk(
      await ctx.client.post(
        `/api/system/relay/instances/${iid}/drain`,
        { confirm: true },
        { template: '/api/system/relay/instances/{instanceId}/drain' }
      ),
      'drain relay'
    );
    const resume = await ctx.client.post(
      `/api/system/relay/instances/${iid}/resume`,
      { confirm: true },
      { template: '/api/system/relay/instances/{instanceId}/resume' }
    );
    expectOk(resume, 'resume relay');
  });

  await ctx.step('runtime:builder advertises build execution', async () => {
    const builder = ctx.requireNode('builder');
    const node = data<any>(await ctx.client.get(`/api/nodes/${builder.nodeId}`, { template: '/api/nodes/{id}' }));
    if (!JSON.stringify(node?.capabilities ?? {}).includes('docker_builder_execution_v1'))
      throw new Error('online builder node does not advertise docker_builder_execution_v1');
    const connectors = await ctx.client.get('/api/docker/sources/connectors');
    if (!rows(connectors).length)
      throw new Skip(
        'no git source connector on this installation: a build needs a repository source, so only builder readiness was checked'
      );
  });

  await ctx.step(
    'runtime:hosting node projection of an unknown id is 404',
    async () => {
      const response = await ctx.client.get(`/api/hosting/nodes/${randomUUID()}`, {
        template: '/api/hosting/nodes/{id}',
      });
      if (response.status !== 404)
        throw new Failure(
          `GET /api/hosting/nodes/<unknown> answers ${response.status} ${response.text.slice(0, 80)}`,
          response
        );
    },
    { invariant: 'unknown-id-404', severity: 'medium' }
  );

  await ctx.step('runtime:monitoring node reports health', async () => {
    const monitoring = ctx.requireNode('monitoring');
    const node = data<any>(await ctx.client.get(`/api/nodes/${monitoring.nodeId}`, { template: '/api/nodes/{id}' }));
    if (!node?.lastHealthReport) throw new Error('monitoring node is online but has no health report');
    expectOk(await ctx.client.get('/api/monitoring/health-status'), 'monitoring health status');
  });
}

async function crossLane(ctx: MatrixContext, docker: DockerState, storage: Record<string, any>) {
  await ctx.step('runtime:ingress route to a docker container + HTTP probe', async () => {
    const nginx = ctx.requireNode('nginx');
    const dockerNode = ctx.requireNode('docker');
    if (!docker.web) throw new Skip('the docker web container was not created');
    if (!nginx.address) throw new Skip('nginx node address unknown');
    const domain = `${ctx.name('web')}.example.test`;
    const body = {
      type: 'proxy',
      nodeId: nginx.nodeId,
      domainNames: [domain],
      createMissingDomains: true,
      upstreamKind: 'docker_container',
      dockerNodeId: dockerNode.nodeId,
      dockerContainerName: docker.web.name,
      dockerContainerPort: 80,
    };
    const route = await ctx.client.post('/api/proxy-hosts', body);
    expectOk(route, 'create route', { method: 'POST', path: '/api/proxy-hosts', body });
    const routeId = String(data<any>(route)?.id);
    ctx.onCleanup(`route ${routeId}`, async () => {
      await removeOrThrow(ctx, `/api/proxy-hosts/${routeId}`, { template: '/api/proxy-hosts/{id}' });
    });
    const served = await probeUntil(`http://${nginx.address}/`, {
      host: domain,
      expect: (status, text) => status === 200 && /nginx/i.test(text),
      timeoutMs: 180_000,
      intervalMs: ctx.config.pollMs,
    });
    if (!served.hit) {
      const host = data<any>(
        await ctx.client.get(`/api/proxy-hosts/${routeId}`, { template: '/api/proxy-hosts/{id}' })
      );
      const rendered = await ctx.client.get(`/api/proxy-hosts/${routeId}/rendered-config`, {
        template: '/api/proxy-hosts/{id}/rendered-config',
      });
      const upstream = (rendered.text.match(/(proxy_pass|server|upstream)[^;]{0,120};/g) ?? []).slice(0, 4).join(' ');
      throw new Error(
        `route never served the container within 3 min (last ${served.last.status} ${served.last.error ?? ''}); route health ${JSON.stringify([host?.healthStatus ?? host?.health, host?.lastError ?? host?.statusMessage]).slice(0, 160)}; rendered upstream: ${upstream.slice(0, 300)}`
      );
    }
    expectOk(
      await ctx.client.get(`/api/proxy-hosts/${routeId}/rendered-config`, {
        template: '/api/proxy-hosts/{id}/rendered-config',
      }),
      'rendered config'
    );
    expectOk(
      await ctx.client.post(
        `/api/proxy-hosts/${routeId}/toggle`,
        { enabled: false },
        { template: '/api/proxy-hosts/{id}/toggle' }
      ),
      'disable route'
    );
    const disabled = await probeUntil(`http://${nginx.address}/`, {
      host: domain,
      expect: (status, text) => !(status === 200 && /nginx/i.test(text) && !/404/.test(text)),
      timeoutMs: 90_000,
      intervalMs: ctx.config.pollMs,
    });
    if (!disabled.hit) throw new Error('a disabled route still serves the upstream 90 s later');
    expectOk(
      await ctx.client.post(
        `/api/proxy-hosts/${routeId}/toggle`,
        { enabled: true },
        { template: '/api/proxy-hosts/{id}/toggle' }
      ),
      'enable route'
    );
    expectOk(
      await ctx.client.delete(`/api/proxy-hosts/${routeId}`, { template: '/api/proxy-hosts/{id}' }),
      'delete route'
    );
  });

  await runLinkScenarios(ctx, docker, storage);
  await runBindingRestartRepro(ctx, storage);

  await ctx.step(
    'runtime:failing app raises navigationAttention.apps',
    async () => {
      const dockerNode = ctx.requireNode('docker');
      const created = await ctx.client.post('/api/apps', { name: ctx.name('sickapp') });
      expectOk(created, 'create app');
      const appId = String(data<any>(created)?.id);
      ctx.onCleanup(`app ${appId}`, async () => {
        await removeOrThrow(ctx, `/api/apps/${appId}`, { template: '/api/apps/{id}' });
      });
      const detail = data<any>(await ctx.client.get(`/api/apps/${appId}`, { template: '/api/apps/{id}' }));
      const environments: any[] = detail?.environments ?? detail?.app?.environments ?? [];
      const environment =
        environments.find((env) => /prod/i.test(String(env.name ?? env.slug ?? ''))) ?? environments[0];
      if (!environment?.id) throw new Error('a new app lists no environment to place a member in');
      // A new environment allows no node: placing a workload is refused (APP_ENV_NO_ALLOWED_NODE) until one is allowed.
      expectOk(
        await ctx.client.post(
          `/api/apps/${appId}/environments/${environment.id}/nodes`,
          { nodeId: dockerNode.nodeId },
          { template: '/api/apps/{id}/environments/{envId}/nodes' }
        ),
        'allow the Docker node in the environment'
      );
      const crash = await createCrashLooper(ctx, dockerNode.nodeId, ctx.name('sickapp-c'));
      const place = await ctx.client.post('/api/apps/members/place', {
        target: { appId, environmentId: environment.id },
        members: [{ type: 'container', id: crash, nodeId: dockerNode.nodeId }],
      });
      expectOk(place, 'place the crash-looping container in the app');
      const refused: any[] = data<any>(place)?.refused ?? [];
      if (refused.length)
        throw new Error(`placement refused the crash-looping container: ${JSON.stringify(refused).slice(0, 300)}`);
      ctx.onCleanup(`app member ${crash}`, async () => {
        await ctx.client.post('/api/apps/members/place', {
          target: null,
          members: [{ type: 'container', id: crash, nodeId: dockerNode.nodeId }],
        });
      });
      let last: { health?: unknown; attention?: unknown } = {};
      const raised = await waitFor(
        async () => {
          const app = rows(await ctx.client.get('/api/apps', { query: { limit: 100 } })).find(
            (row) => row.id === appId
          );
          const bootstrap = data<any>(await ctx.client.post('/api/monitoring/dashboard/bootstrap', {}));
          last = { health: app?.health, attention: bootstrap?.navigationAttention?.apps };
          return app?.health === 'failing' && last.attention === 'critical' ? true : undefined;
        },
        { timeoutMs: 180_000, intervalMs: ctx.config.pollMs }
      );
      if (!raised)
        throw new Error(
          `an app whose only member crash-loops reads health ${String(last.health)} and sidebar attention ${String(last.attention)} (expected failing / critical)`
        );
    },
    { invariant: 'app-health-attention' }
  );

  await ctx.step(
    'runtime:event stream first event through a buffering nginx',
    async () => {
      const nginx = ctx.requireNode('nginx');
      const dockerNode = ctx.requireNode('docker');
      if (!nginx.address) throw new Skip('nginx node address unknown');
      const upstream = new URL(ctx.config.url);
      const domain = `${ctx.name('sse')}.example.test`;
      const route = await ctx.client.post('/api/proxy-hosts', {
        type: 'proxy',
        nodeId: nginx.nodeId,
        domainNames: [domain],
        createMissingDomains: true,
        upstreamKind: 'manual',
        forwardScheme: upstream.protocol === 'https:' ? 'https' : 'http',
        forwardHost: upstream.hostname,
        forwardPort: Number(upstream.port || (upstream.protocol === 'https:' ? 443 : 80)),
        // Opfield answers only its own host: the route sends it instead of the test domain, as a route in front of an
        // Opfield reached by its public address does.
        customHeaders: [{ name: 'Host', value: upstream.host }],
      });
      expectOk(route, 'route in front of the Opfield API');
      const routeId = String(data<any>(route)?.id);
      ctx.onCleanup(`route ${routeId}`, async () => {
        await removeOrThrow(ctx, `/api/proxy-hosts/${routeId}`, { template: '/api/proxy-hosts/{id}' });
      });
      // The node's default server answers /health itself ("OK"): only Opfield's JSON shows the route is in place.
      const up = await probeUntil(`http://${nginx.address}/health`, {
        host: domain,
        expect: (status, body) => status === 200 && body.includes('"status"'),
        timeoutMs: 180_000,
        intervalMs: ctx.config.pollMs,
      });
      if (!up.hit)
        throw new Error(
          `the route in front of Opfield never answered /health (last ${up.last.status} ${up.last.error ?? ''})`
        );
      const result = await sseProbe(`http://${nginx.address}/api/nodes/${dockerNode.nodeId}/logs`, {
        host: domain,
        headers: { Authorization: `Bearer ${ctx.config.token}` },
        timeoutMs: 15_000,
      });
      if (result.status !== 200)
        throw new Error(`event stream through nginx answered ${result.status} ${result.error ?? ''}`);
      // nginx acts on X-Accel-Buffering and never passes it on (the crawl checks the header on Opfield itself): here
      // only the first event's arrival shows the stream left unbuffered.
      if (result.firstEventMs === undefined)
        throw new Error(`no event arrived through the buffering nginx within 15 s (${result.error ?? ''})`);
      ctx.report.note(`event stream through nginx: first event after ${result.firstEventMs} ms`);
    },
    { invariant: 'event-stream-unbuffered' }
  );
}

type LinkAdapter = {
  kind: 'database-binding' | 'storage-binding' | 'container-link';
  available: () => string | undefined;
  create: (consumer: string) => Promise<string>;
  get: (id: string) => Promise<any | undefined>;
  remove: (id: string) => Promise<void>;
  fallbackEnv: Record<string, string>;
};

/**
 * Every link kind gets the same generic cycle on its own consumer container, and each check asserts the invariant
 * desired = actual on the consumer: create, consumer recreate, consumer restart, delete, create while the consumer
 * restarts (seeded chaos), and for the database binding a crash-looping consumer.
 */
async function runLinkScenarios(ctx: MatrixContext, docker: DockerState, storage: Record<string, any>) {
  const dockerNode = ctx.node('docker');
  if (!dockerNode?.ready) {
    ctx.report.cover('invariant:link desired=actual (present)', 'skipped', undefined, 'no ready docker node');
    return;
  }
  const nodeId = dockerNode.nodeId;
  const rng = ctx.rng.fork('links');
  const bindingAdapter = (kind: 'database-binding' | 'storage-binding'): LinkAdapter => {
    const base = () =>
      kind === 'database-binding'
        ? `/api/databases/managed/${storage.postgres?.id}/bindings`
        : `/api/managed-storage/${storage.s3?.id}/bindings`;
    const template =
      kind === 'database-binding' ? '/api/databases/managed/{id}/bindings' : '/api/managed-storage/{id}/bindings';
    const fallbackEnv: Record<string, string> =
      kind === 'database-binding'
        ? { connectionUri: 'MX_DATABASE_URL' }
        : {
            endpoint: 'MX_S3_ENDPOINT',
            accessKeyId: 'MX_S3_KEY',
            secretAccessKey: 'MX_S3_SECRET',
            bucket: 'MX_S3_BUCKET',
          };
    return {
      kind,
      fallbackEnv,
      available: () =>
        kind === 'database-binding'
          ? storage.postgres
            ? undefined
            : 'managed postgres did not become ready'
          : storage.s3 && storage.bucket
            ? undefined
            : 'managed S3 did not become ready',
      create: async (consumer) => {
        const body: Record<string, unknown> = {
          targetNodeId: nodeId,
          targetType: 'container',
          targetResourceId: consumer,
          environment: fallbackEnv,
          ...(kind === 'storage-binding' ? { buckets: [storage.bucket] } : {}),
        };
        const created = await ctx.client.post(base(), body, { template, timeoutMs: 300_000 });
        expectOk(created, `create ${kind}`, { method: 'POST', path: template, body });
        const id = String(data<any>(created)?.id ?? data<any>(created)?.binding?.id);
        ctx.onCleanup(`${kind} ${id}`, async () => {
          await removeOrThrow(ctx, `${base()}/${id}`, { template: `${template}/{bindingId}` });
        });
        return id;
      },
      get: async (id) => rows(await ctx.client.get(base(), { template })).find((row) => row.id === id),
      remove: async (id) => {
        expectOk(await ctx.client.delete(`${base()}/${id}`, { template: `${template}/{bindingId}` }), `delete ${kind}`);
      },
    };
  };
  const linkAdapter: LinkAdapter = {
    kind: 'container-link',
    fallbackEnv: { host: 'MX_WEB_HOST', port: 'MX_WEB_PORT', url: 'MX_WEB_URL' },
    available: () => (docker.web ? undefined : 'the link target container was not created'),
    create: async (consumer) => {
      const body = {
        sourceNodeId: nodeId,
        sourceType: 'container',
        sourceResourceId: consumer,
        targetNodeId: nodeId,
        targetType: 'container',
        targetResourceId: docker.web!.name,
        targetPort: 80,
        alias: `mxweb${rng.int(10, 99)}`,
        environment: { host: 'MX_WEB_HOST', port: 'MX_WEB_PORT', url: 'MX_WEB_URL' },
      };
      const created = await ctx.client.post('/api/docker/container-links', body, { timeoutMs: 300_000 });
      expectOk(created, 'create container link', { method: 'POST', path: '/api/docker/container-links', body });
      const id = String(data<any>(created)?.id ?? data<any>(created)?.link?.id);
      ctx.onCleanup(`container link ${id}`, async () => {
        await removeOrThrow(ctx, `/api/docker/container-links/${id}`, { template: '/api/docker/container-links/{id}' });
      });
      return id;
    },
    get: async (id) => {
      const response = await ctx.client.get(`/api/docker/container-links/${id}`, {
        template: '/api/docker/container-links/{id}',
      });
      return ok(response) ? (data<any>(response)?.link ?? data<any>(response)) : undefined;
    },
    remove: async (id) => {
      expectOk(
        await ctx.client.delete(`/api/docker/container-links/${id}`, { template: '/api/docker/container-links/{id}' }),
        'delete container link'
      );
    },
  };

  const settle = async (adapter: LinkAdapter, id: string, label: string) => {
    let last: any;
    const row = await waitFor(
      async () => {
        last = await adapter.get(id);
        const status = String(last?.status ?? '');
        if (status === 'error') return last;
        return status === 'ready' ? last : undefined;
      },
      { timeoutMs: ctx.config.deadlines.workloadMs, intervalMs: ctx.config.pollMs }
    );
    if (!row)
      throw new Failure(
        `${adapter.kind} ${label}: still "${String(last?.status ?? 'missing')}" after ${Math.round(ctx.config.deadlines.workloadMs / 60_000)} min`
      );
    return row;
  };
  const restartConsumer = async (consumer: string) => {
    // 409 CONTAINER_BUSY while a link recreates the consumer: retry so the restart lands right after it.
    let response: Response | undefined;
    await waitFor(
      async () => {
        response = await ctx.client.post(
          `/api/docker/nodes/${nodeId}/containers/${encodeURIComponent(consumer)}/restart`,
          { timeout: 2 },
          {
            template: '/api/docker/nodes/{nodeId}/containers/{containerId}/restart',
          }
        );
        if (response.status === 409 && errorCode(response) === 'CONTAINER_BUSY') return undefined;
        if (response.status === 404) {
          // The consumer is gone for a moment while a link recreates it.
          ctx.report.add({
            severity: 'low',
            invariant: 'workload-addressable',
            title:
              'A container being recreated by a link apply answers 404 CONTAINER_NOT_FOUND to restart (instead of 409 CONTAINER_BUSY)',
            dedupeKey: 'workload-addressable|restart-404-during-link',
            response: { status: response.status, excerpt: describe(response) },
          });
          return undefined;
        }
        return true;
      },
      { timeoutMs: 60_000, intervalMs: 1000 }
    );
    const restarted = expectOk(response!, 'restart consumer');
    await waitTask(ctx, data<any>(restarted)?.taskId, 'consumer restart task');
  };

  const cycle = async (adapter: LinkAdapter) => {
    const unavailable = adapter.available();
    const op = (name: string) => `link:${adapter.kind} ${name}`;
    if (unavailable) {
      ctx.report.cover(op('cycle'), 'skipped', undefined, unavailable);
      return;
    }
    const consumer = await ctx.step(op('consumer container'), () =>
      createContainer(ctx, nodeId, ctx.name(`c-${adapter.kind.split('-')[0]}`), {})
    );
    if (!consumer) return;
    const invariant = { invariant: 'link-desired-equals-actual', severity: 'high' as const };
    let id: string | undefined;
    let desired = { env: [] as string[], network: undefined as string | undefined };
    const check = async (label: string, present = true, linkId = id) => {
      await expectConsumerMatches(ctx, {
        label: `${adapter.kind} ${label}`,
        nodeId,
        container: consumer.name,
        env: desired.env,
        network: desired.network,
        present,
      });
      // The binding API's own view must agree: observedState "active" exactly when the consumer carries the link.
      if (!present || !linkId || adapter.kind === 'container-link') return;
      const row = await waitFor(
        async () => {
          const current = await adapter.get(linkId);
          return current?.observedState === undefined || current.observedState === 'active' ? current : undefined;
        },
        { timeoutMs: 60_000, intervalMs: ctx.config.pollMs }
      );
      ctx.report.cover(
        'invariant:binding observedState=active matches the consumer',
        row ? 'exercised' : 'failed',
        label
      );
      if (!row) {
        const current = await adapter.get(linkId);
        throw new Failure(
          `${adapter.kind} ${label}: the consumer carries the link but the binding reads observedState "${current?.observedState}" (${current?.status})`
        );
      }
    };

    await ctx.step(
      op('create → consumer has the link'),
      async () => {
        id = await adapter.create(consumer.name);
        const row = await settle(adapter, id, 'create');
        if (row.status === 'error')
          throw new Error(`${adapter.kind} create ended in error: ${String(row.lastError ?? '').slice(0, 200)}`);
        desired = desiredOf(row, adapter.fallbackEnv);
        await check('create');
      },
      invariant
    );
    if (!id) return;
    await ctx.step(
      op('consumer recreate keeps the link'),
      async () => {
        const response = await ctx.client.post(
          `/api/docker/nodes/${nodeId}/containers/${encodeURIComponent(consumer.name)}/recreate`,
          {},
          {
            template: '/api/docker/nodes/{nodeId}/containers/{containerId}/recreate',
            timeoutMs: 300_000,
          }
        );
        expectOk(response, 'recreate consumer');
        await waitTask(ctx, data<any>(response)?.taskId, 'consumer recreate task');
        await check('consumer recreate');
      },
      invariant
    );
    await ctx.step(
      op('consumer recreate while it restarts (chaos)'),
      async () => {
        const delayMs = rng.int(0, 2000);
        ctx.chaos.push({
          nodeId,
          role: `consumer of ${adapter.kind}`,
          at: Date.now(),
          action: `workload restart ${delayMs}ms into consumer recreate`,
        });
        const recreate = ctx.client.post(
          `/api/docker/nodes/${nodeId}/containers/${encodeURIComponent(consumer.name)}/recreate`,
          {},
          {
            template: '/api/docker/nodes/{nodeId}/containers/{containerId}/recreate',
            timeoutMs: 300_000,
          }
        );
        const [response] = await Promise.all([recreate, sleep(delayMs).then(() => restartConsumer(consumer.name))]);
        if (ok(response))
          await waitTask(ctx, data<any>(response)?.taskId, 'consumer recreate task').catch(() => undefined);
        else if (response.status !== 409) expectOk(response, 'recreate consumer during a restart');
        await check('consumer recreate during a restart');
      },
      invariant
    );
    await ctx.step(
      op('consumer restart keeps the link'),
      async () => {
        await restartConsumer(consumer.name);
        await check('consumer restart');
      },
      invariant
    );
    await ctx.step(
      op('delete → consumer is clean'),
      async () => {
        await adapter.remove(id!);
        const gone = await waitFor(async () => ((await adapter.get(id!)) ? undefined : true), {
          timeoutMs: 180_000,
          intervalMs: ctx.config.pollMs,
        });
        if (!gone) throw new Error(`${adapter.kind} still listed 3 min after delete`);
        await check('delete', false);
      },
      invariant
    );
    // Seeded chaos: restart the consumer while the link is being created.
    await ctx.step(
      op('create while the consumer restarts (chaos)'),
      async () => {
        const delayMs = rng.int(0, 2500);
        ctx.chaos.push({
          nodeId,
          role: `consumer of ${adapter.kind}`,
          at: Date.now(),
          action: `workload restart ${delayMs}ms into link create`,
        });
        const [createdId] = await Promise.all([
          adapter.create(consumer.name),
          sleep(delayMs).then(() => restartConsumer(consumer.name)),
        ]);
        const row = await settle(adapter, createdId, 'create during restart');
        if (row.status === 'ready') {
          desired = desiredOf(row, adapter.fallbackEnv);
          await check('create during consumer restart', true, createdId);
        } else {
          // An error is an honest outcome; it must still not leave half-applied env behind once removed.
          ctx.report.note(
            `${adapter.kind} created during a consumer restart ended in error: ${String(row.lastError ?? '').slice(0, 160)}`
          );
        }
        await adapter.remove(createdId);
        await waitFor(async () => ((await adapter.get(createdId)) ? undefined : true), {
          timeoutMs: 180_000,
          intervalMs: ctx.config.pollMs,
        });
        await check('delete after chaos create', false);
      },
      invariant
    );
  };

  const crashLoop = async () => {
    const adapter = bindingAdapter('database-binding');
    if (adapter.available()) return;
    await ctx.step(
      'link:database-binding to a crash-looping consumer',
      async () => {
        const crash = await createCrashLooper(ctx, nodeId, ctx.name('crashloop'));
        ctx.chaos.push({ nodeId, role: 'crash-looping consumer', at: Date.now(), action: 'bind a crash-looping app' });
        const id = await adapter.create(crash);
        const row = await settle(adapter, id, 'create on a crash-looping consumer');
        if (row.status === 'ready') {
          const desired = desiredOf(row, adapter.fallbackEnv);
          await expectConsumerMatches(ctx, {
            label: 'database-binding create on a crash-looping consumer',
            nodeId,
            container: crash,
            env: desired.env,
            network: desired.network,
            present: true,
          });
        } else
          ctx.report.note(
            `binding to a crash-looping consumer ended in error: ${String(row.lastError ?? '').slice(0, 160)}`
          );
        await adapter.remove(id);
        await waitFor(async () => ((await adapter.get(id)) ? undefined : true), {
          timeoutMs: 180_000,
          intervalMs: ctx.config.pollMs,
        });
      },
      { invariant: 'link-desired-equals-actual', severity: 'high' }
    );
  };

  await Promise.all([
    cycle(bindingAdapter('database-binding')),
    cycle(bindingAdapter('storage-binding')),
    cycle(linkAdapter),
  ]);
  await crashLoop();
}

/** A container that exits 20 s after every start, restarted forever by Docker. */
async function createCrashLooper(ctx: MatrixContext, nodeId: string, name: string) {
  await ensureImage(ctx, nodeId, 'alpine:3');
  const body = {
    image: 'alpine:3',
    name,
    restartPolicy: 'always',
    command: ['sh', '-c', 'sleep 20; exit 3'],
    labels: { 'opfield.matrix': ctx.config.seed },
  };
  const response = await ctx.client.post(`/api/docker/nodes/${nodeId}/containers`, body, {
    template: '/api/docker/nodes/{nodeId}/containers',
    timeoutMs: 300_000,
  });
  expectOk(response, 'create crash-looping container', {
    method: 'POST',
    path: '/api/docker/nodes/{nodeId}/containers',
    body,
  });
  ctx.onCleanup(`container ${name}`, () => removeContainer(ctx, nodeId, name));
  await waitTask(ctx, data<any>(response)?.taskId ?? data<any>(response)?.task?.id, 'crash-looper create task');
  const visible = await waitFor(
    async () => {
      const found = await ctx.client.get(`/api/docker/nodes/${nodeId}/containers/by-name/${encodeURIComponent(name)}`, {
        template: '/api/docker/nodes/{nodeId}/containers/by-name/{containerName}',
      });
      return ok(found) ? true : undefined;
    },
    { timeoutMs: ctx.config.deadlines.taskMs, intervalMs: ctx.config.pollMs }
  );
  if (!visible) throw new Error('crash-looping container never became visible');
  await ctx.client.post(`/api/docker/nodes/${nodeId}/containers/${encodeURIComponent(name)}/start`, undefined, {
    template: '/api/docker/nodes/{nodeId}/containers/{containerId}/start',
  });
  return name;
}

/** Removes a container by its id (looked up by name), then waits until the name is free. */
async function removeContainer(ctx: MatrixContext, nodeId: string, name: string) {
  const found = await ctx.client.get(`/api/docker/nodes/${nodeId}/containers/by-name/${encodeURIComponent(name)}`, {
    template: '/api/docker/nodes/{nodeId}/containers/by-name/{containerName}',
  });
  if (found.status === 404) return;
  const id = String(data<any>(found)?.Id ?? data<any>(found)?.id ?? name);
  // DELETE refuses a running container (CONTAINER_RUNNING): stop it first.
  const stop = await ctx.client.post(
    `/api/docker/nodes/${nodeId}/containers/${encodeURIComponent(id)}/stop`,
    { timeout: 2 },
    {
      template: '/api/docker/nodes/{nodeId}/containers/{containerId}/stop',
    }
  );
  if (ok(stop)) await waitTask(ctx, data<any>(stop)?.taskId, `stop container ${name}`).catch(() => undefined);
  const response = await ctx.client.delete(`/api/docker/nodes/${nodeId}/containers/${encodeURIComponent(id)}`, {
    template: '/api/docker/nodes/{nodeId}/containers/{containerId}',
    query: { force: true },
  });
  if (!ok(response) && response.status !== 404)
    throw new Failure(`DELETE container ${name}: ${describe(response)}`, response);
  await waitTask(ctx, data<any>(response)?.taskId, `remove container ${name}`);
  const gone = await waitFor(
    async () =>
      (
        await ctx.client.get(`/api/docker/nodes/${nodeId}/containers/by-name/${encodeURIComponent(name)}`, {
          template: '/api/docker/nodes/{nodeId}/containers/by-name/{containerName}',
        })
      ).status === 404
        ? true
        : undefined,
    { timeoutMs: 90_000, intervalMs: ctx.config.pollMs }
  );
  if (!gone) throw new Failure(`container ${name} still exists 90 s after a successful DELETE`);
}

/** DELETE for cleanups: anything but 2xx/404 throws, so a refused delete becomes a cleanup finding. */
async function removeOrThrow(
  ctx: MatrixContext,
  path: string,
  options: Parameters<MatrixContext['client']['delete']>[1] = {}
) {
  const response = await ctx.client.delete(path, options);
  if (!ok(response) && response.status !== 404)
    throw new Failure(`DELETE ${options.template ?? path}: ${describe(response)}`, response);
}

/** Runs every registered cleanup in reverse order; failures become findings so a leaky delete is visible. */
export async function runCleanups(ctx: MatrixContext) {
  for (const cleanup of ctx.cleanups.splice(0).reverse()) {
    try {
      await cleanup.run();
    } catch (error) {
      ctx.report.add({
        severity: 'medium',
        invariant: 'cleanup',
        title: `cleanup ${cleanup.label}: ${(error as Error).message.slice(0, 200)}`,
        dedupeKey: `cleanup|${cleanup.label}`,
      });
    }
  }
}

export { errorCode };

/**
 * Compose apply interrupted by a node reboot (MATRIX_ONLY=compose-reboot): reboot the docker VM mid-pull and
 * mid-up; the operation must end (succeeded, or failed with the interrupted reason) and the project leave
 * `reconciling` within the deadline.
 */
export async function runComposeRebootCheck(ctx: MatrixContext) {
  const node = ctx.node('docker');
  if (!node?.resourceId) {
    ctx.report.cover('compose-reboot', 'skipped', undefined, 'no ready docker VM');
    return;
  }
  const { listResources } = await import('./fleet.js');
  const reboot = async () => {
    const resource = (await listResources(ctx)).find((row) => row.id === node.resourceId);
    const response = await ctx.client.post(
      `/api/hosting/resources/${node.resourceId}/actions`,
      {
        idempotencyKey: randomUUID(),
        action: 'reboot',
        expectedIncarnation: String(resource?.incarnation ?? resource?.snapshot?.incarnation ?? ''),
        confirmed: true,
        reason: `opfield matrix ${ctx.config.seed}`,
      },
      { template: '/api/hosting/resources/{id}/actions' }
    );
    expectOk(response, 'hosting reboot');
    ctx.chaos.push({ nodeId: node.nodeId, role: 'docker', at: Date.now(), action: 'reboot' });
    return ctx.chaos.at(-1)!;
  };
  const waitOnline = async (since: number) =>
    waitFor(
      async () => {
        const row = data<any>(await ctx.client.get(`/api/nodes/${node.nodeId}`, { template: '/api/nodes/{id}' }));
        const seen = Date.parse(row?.lastSeenAt ?? '') || 0;
        return row?.status === 'online' && row?.isConnected !== false && seen > since + 5000 ? true : undefined;
      },
      { timeoutMs: ctx.config.deadlines.chaosRecoveryMs, intervalMs: ctx.config.pollMs }
    );

  for (const [label, image, delayMs] of [
    ['mid-pull', 'node:24-bookworm', 2500],
    ['mid-up', 'nginx:alpine', 300],
  ] as const) {
    await ctx.step(
      `compose-reboot:apply with the node rebooted ${label}`,
      async () => {
        if (label === 'mid-up') await ensureImage(ctx, node.nodeId, image);
        const projectName = ctx.name(`cr-${label}`);
        const yaml = [
          'services:',
          '  app:',
          `    image: ${image}`,
          '    command: ["sleep", "3600"]',
          '    restart: unless-stopped',
          '',
        ].join('\n');
        const create = await ctx.client.post(
          `/api/docker/nodes/${node.nodeId}/compose-projects`,
          { projectName, yaml, variables: {}, secretKeys: [] },
          {
            template: '/api/docker/nodes/{nodeId}/compose-projects',
          }
        );
        expectOk(create, 'create compose project');
        const projectId = String(data<any>(create)?.project?.id);
        const revisionId = String(data<any>(create)?.revision?.id);
        const projectPath = `/api/docker/nodes/${node.nodeId}/compose-projects/${projectId}`;
        ctx.onCleanup(`compose ${projectName}`, async () => {
          const down = await ctx.client.post(
            `${projectPath}/actions/down`,
            { idempotencyKey: randomUUID(), removeOrphans: true, volumeNames: [] },
            {
              template: '/api/docker/nodes/{nodeId}/compose-projects/{projectId}/actions/{action}',
            }
          );
          // The down runs in the background; the project refuses deletion (COMPOSE_OPERATION_IN_PROGRESS) until it ends.
          let last: Response | undefined;
          const removed = await waitFor(
            async () => {
              last = await ctx.client.delete(projectPath, {
                template: '/api/docker/nodes/{nodeId}/compose-projects/{projectId}',
              });
              return ok(last) || last.status === 404
                ? true
                : errorCode(last) === 'COMPOSE_OPERATION_IN_PROGRESS'
                  ? undefined
                  : false;
            },
            { timeoutMs: 180_000, intervalMs: ctx.config.pollMs }
          );
          void down;
          if (removed !== true)
            throw new Failure(`DELETE compose project: ${last ? describe(last) : 'no response'}`, last);
        });
        const apply = await ctx.client.post(
          `${projectPath}/actions/apply`,
          { revisionId, idempotencyKey: randomUUID(), removeOrphans: false, volumeNames: [] },
          {
            template: '/api/docker/nodes/{nodeId}/compose-projects/{projectId}/actions/{action}',
          }
        );
        expectOk(apply, 'compose apply');
        const operationId = String(data<any>(apply)?.id);
        await sleep(delayMs);
        const event = await reboot();
        const timeline: string[] = [];
        const operationState = async () => {
          const operation = rows(
            await ctx.client.get(`${projectPath}/operations`, {
              template: '/api/docker/nodes/{nodeId}/compose-projects/{projectId}/operations',
            })
          ).find((row) => row.id === operationId);
          const project = data<any>(
            await ctx.client.get(projectPath, { template: '/api/docker/nodes/{nodeId}/compose-projects/{projectId}' })
          );
          const state = `${operation?.status ?? 'missing'}/${project?.project?.status ?? project?.status ?? '?'}`;
          if (timeline.at(-1)?.split('@')[0] !== state)
            timeline.push(`${state}@${Math.round((Date.now() - event.at) / 1000)}s`);
          return { operation, projectStatus: String(project?.project?.status ?? project?.status ?? '') };
        };
        const back = await waitOnline(event.at);
        event.recoveredAt = Date.now();
        if (!back) throw new Error('docker node did not come back after the reboot');
        const settled = await waitFor(
          async () => {
            const { operation, projectStatus } = await operationState();
            return ['succeeded', 'failed', 'cancelled'].includes(String(operation?.status)) &&
              projectStatus !== 'reconciling'
              ? { operation, projectStatus }
              : undefined;
          },
          { timeoutMs: 10 * 60_000, intervalMs: ctx.config.pollMs }
        );
        ctx.report.note(
          `compose ${label}: node back ${Math.round((event.recoveredAt - event.at) / 1000)}s after the reboot; ${timeline.join(' → ')}`
        );
        if (!settled)
          throw new Error(
            `compose apply interrupted ${label} did not settle within 10 min after the node returned (${timeline.join(' → ')})`
          );
        if (
          settled.operation.status === 'failed' &&
          !/interrupted|restart|disconnect/i.test(String(settled.operation.error ?? ''))
        )
          throw new Error(
            `compose apply interrupted ${label} failed without the interrupted reason: ${String(settled.operation.error ?? '').slice(0, 200)}`
          );
        ctx.report.note(
          `compose ${label}: operation ${settled.operation.status}${settled.operation.error ? ` (${String(settled.operation.error).slice(0, 160)})` : ''}, project ${settled.projectStatus}`
        );
      },
      { invariant: 'async-terminal', severity: 'high' }
    );
  }
}
