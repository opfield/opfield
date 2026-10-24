import type { MatrixContext } from './context.js';
import { execInContainer } from './exec.js';
import { data, describe, expectOk, Failure, ok, rows, Skip, sleep, waitFor } from './http.js';
import { httpProbe } from './probe.js';

/**
 * Binding / Secure Link vs a restarting container (binding-restart-report.md, "Live repro"). The app exits at once
 * when its link variable is unset, so without the link it crash-loops in Docker `restarting`, and with it it serves
 * "ok" on :3000. A link applied during that window must still end with the variable, the link network, a running
 * container and an answering app; a Route Secure Link must survive the binding recreating its target.
 */
type LinkKind = 'database' | 'storage';

const appCommand = (variable: string) => [
  'sh',
  '-c',
  `test -n "$${variable}" || exit 1; exec node -e "require('http').createServer((q,s)=>s.end('ok')).listen(3000)"`,
];

type Inspect = { id: string; status: string; restartCount: number; networks: string[] };

async function inspect(ctx: MatrixContext, nodeId: string, name: string): Promise<Inspect | undefined> {
  const response = await ctx.client.get(`/api/docker/nodes/${nodeId}/containers/${encodeURIComponent(name)}`, {
    template: '/api/docker/nodes/{nodeId}/containers/{containerId}',
    secretResponse: true,
  });
  if (!ok(response)) return undefined;
  const row = data<any>(response) ?? {};
  return {
    id: String(row.Id ?? row.id ?? ''),
    status: String(row.State?.Status ?? row.state ?? ''),
    restartCount: Number(row.RestartCount ?? 0),
    networks: Object.keys(row.NetworkSettings?.Networks ?? {}),
  };
}

export class BindingRestartRepro {
  constructor(
    private readonly ctx: MatrixContext,
    private readonly nodeId: string,
    private readonly address: string | undefined,
    private readonly storage: { postgres?: any; s3?: any; bucket?: string }
  ) {}

  private base(kind: LinkKind) {
    return kind === 'database'
      ? {
          path: `/api/databases/managed/${this.storage.postgres?.id}/bindings`,
          template: '/api/databases/managed/{id}/bindings',
        }
      : {
          path: `/api/managed-storage/${this.storage.s3?.id}/bindings`,
          template: '/api/managed-storage/{id}/bindings',
        };
  }

  private variable(kind: LinkKind) {
    return kind === 'database' ? 'DATABASE_URL' : 'S3_ENDPOINT';
  }

  async createApp(kind: LinkKind, name: string, port: number) {
    const { ctx } = this;
    const imageRef = 'node:24-alpine';
    const pull = await ctx.client.post(
      `/api/docker/nodes/${this.nodeId}/images/pull-sync`,
      { imageRef },
      {
        template: '/api/docker/nodes/{nodeId}/images/pull-sync',
        timeoutMs: 300_000,
      }
    );
    expectOk(pull, `pull ${imageRef}`);
    const body = {
      image: imageRef,
      name,
      restartPolicy: 'unless-stopped',
      command: appCommand(this.variable(kind)),
      ports: [{ hostPort: port, containerPort: 3000 }],
      labels: { 'opfield.matrix': ctx.config.seed },
    };
    const created = await ctx.client.post(`/api/docker/nodes/${this.nodeId}/containers`, body, {
      template: '/api/docker/nodes/{nodeId}/containers',
      timeoutMs: 300_000,
    });
    expectOk(created, `create ${name}`, { method: 'POST', path: '/api/docker/nodes/{nodeId}/containers', body });
    ctx.onCleanup(`container ${name}`, async () => {
      const current = await inspect(ctx, this.nodeId, name);
      if (!current) return;
      await ctx.client.post(
        `/api/docker/nodes/${this.nodeId}/containers/${current.id}/stop`,
        { timeout: 2 },
        {
          template: '/api/docker/nodes/{nodeId}/containers/{containerId}/stop',
        }
      );
      await sleep(3000);
      const removed = await ctx.client.delete(`/api/docker/nodes/${this.nodeId}/containers/${current.id}`, {
        template: '/api/docker/nodes/{nodeId}/containers/{containerId}',
        query: { force: true },
      });
      if (!ok(removed) && removed.status !== 404)
        throw new Failure(`DELETE container ${name}: ${describe(removed)}`, removed);
    });
    const visible = await waitFor(async () => inspect(ctx, this.nodeId, name), {
      timeoutMs: 120_000,
      intervalMs: 2000,
    });
    if (!visible) throw new Error(`${name} never became visible`);
    await ctx.client.post(`/api/docker/nodes/${this.nodeId}/containers/${visible.id}/start`, undefined, {
      template: '/api/docker/nodes/{nodeId}/containers/{containerId}/start',
    });
  }

  /** Polls inspect every 0.5 s until Docker reports `restarting` (the crash loop's backoff window). */
  async waitRestarting(name: string) {
    const hit = await waitFor(
      async () => ((await inspect(this.ctx, this.nodeId, name))?.status === 'restarting' ? true : undefined),
      { timeoutMs: 90_000, intervalMs: 500 }
    );
    if (!hit) throw new Error(`${name} never showed State.Status=restarting within 90 s`);
  }

  async createBinding(kind: LinkKind, name: string) {
    const { path, template } = this.base(kind);
    const body =
      kind === 'database'
        ? {
            targetNodeId: this.nodeId,
            targetType: 'container',
            targetResourceId: name,
            environment: { connectionUri: 'DATABASE_URL' },
          }
        : {
            targetNodeId: this.nodeId,
            targetType: 'container',
            targetResourceId: name,
            environment: {
              endpoint: 'S3_ENDPOINT',
              accessKeyId: 'S3_KEY',
              secretAccessKey: 'S3_SECRET',
              bucket: 'S3_BUCKET',
            },
            buckets: [this.storage.bucket],
          };
    const response = await this.ctx.client.post(path, body, { template, timeoutMs: 300_000 });
    expectOk(response, `create ${kind} binding`, { method: 'POST', path: template, body });
    const id = String(data<any>(response)?.id ?? data<any>(response)?.binding?.id);
    this.ctx.onCleanup(`${kind} binding ${id}`, async () => {
      await this.ctx.client.delete(`${path}/${id}`, { template: `${template}/{bindingId}` });
    });
    return id;
  }

  async deleteBinding(kind: LinkKind, id: string) {
    const { path, template } = this.base(kind);
    expectOk(
      await this.ctx.client.delete(`${path}/${id}`, { template: `${template}/{bindingId}` }),
      `delete ${kind} binding`
    );
    await waitFor(
      async () => (rows(await this.ctx.client.get(path, { template })).some((row) => row.id === id) ? undefined : true),
      { timeoutMs: 120_000, intervalMs: this.ctx.config.pollMs }
    );
  }

  /**
   * The assertions of repro A.3: binding ready/active, variable + network on the container, the container running
   * and staying running, the app answering. Throws with every difference.
   */
  async assertLinked(kind: LinkKind, id: string, name: string, port: number, timeoutMs = 120_000) {
    const { ctx } = this;
    const { path, template } = this.base(kind);
    let problems: string[] = [];
    const settled = await waitFor(
      async () => {
        problems = [];
        const binding = rows(await ctx.client.get(path, { template })).find((row) => row.id === id);
        if (binding?.status !== 'ready')
          problems.push(
            `binding status ${binding?.status ?? 'missing'}${binding?.lastError ? ` (${String(binding.lastError).slice(0, 120)})` : ''}`
          );
        if (binding?.observedState !== undefined && binding.observedState !== 'active')
          problems.push(`binding observedState ${binding.observedState}`);
        const current = await inspect(ctx, this.nodeId, name);
        if (!current) problems.push('container missing');
        else {
          if (current.status !== 'running') problems.push(`container ${current.status}`);
          if (binding?.networkName && !current.networks.includes(binding.networkName))
            problems.push(`network ${binding.networkName} not attached`);
          if (current.status === 'running') {
            const env = await execInContainer(ctx, this.nodeId, current.id, 'env | cut -d= -f1');
            if (env.output === undefined) problems.push(`env unreadable (${env.error})`);
            else if (!env.output.split('\n').includes(this.variable(kind)))
              problems.push(`${this.variable(kind)} missing in the runtime env`);
          }
        }
        return problems.length ? undefined : true;
      },
      { timeoutMs, intervalMs: ctx.config.pollMs }
    );
    if (!settled) throw new Failure(`${kind} link vs restarting container: ${problems.join('; ')}`);
    const first = await inspect(ctx, this.nodeId, name);
    await sleep(10_000);
    const second = await inspect(ctx, this.nodeId, name);
    if (second?.status !== 'running' || (first && second && second.restartCount > first.restartCount))
      throw new Failure(
        `${name} keeps restarting after the link applied (restarts ${first?.restartCount} → ${second?.restartCount}, ${second?.status})`
      );
    if (this.address) {
      const probe = await waitFor(
        async () => {
          const result = await httpProbe(`http://${this.address}:${port}/`);
          return result.status === 200 && result.body.includes('ok') ? true : undefined;
        },
        { timeoutMs: 60_000, intervalMs: 2000 }
      );
      if (!probe) throw new Failure(`${name} does not answer on :${port} although the link is active`);
    }
  }

  async restart(name: string) {
    const current = await inspect(this.ctx, this.nodeId, name);
    return this.ctx.client.post(
      `/api/docker/nodes/${this.nodeId}/containers/${current?.id ?? name}/restart`,
      { timeout: 2 },
      {
        template: '/api/docker/nodes/{nodeId}/containers/{containerId}/restart',
      }
    );
  }

  async stop(name: string) {
    const current = await inspect(this.ctx, this.nodeId, name);
    expectOk(
      await this.ctx.client.post(
        `/api/docker/nodes/${this.nodeId}/containers/${current?.id ?? name}/stop`,
        { timeout: 2 },
        {
          template: '/api/docker/nodes/{nodeId}/containers/{containerId}/stop',
        }
      ),
      `stop ${name}`
    );
  }

  async start(name: string) {
    const current = await inspect(this.ctx, this.nodeId, name);
    expectOk(
      await this.ctx.client.post(
        `/api/docker/nodes/${this.nodeId}/containers/${current?.id ?? name}/start`,
        undefined,
        {
          template: '/api/docker/nodes/{nodeId}/containers/{containerId}/start',
        }
      ),
      `start ${name}`
    );
  }

  inspect(name: string) {
    return inspect(this.ctx, this.nodeId, name);
  }
}

/** Runs repro A (database + storage) and B (Route Secure Link across a binding recreate). */
export async function runBindingRestartRepro(
  ctx: MatrixContext,
  storage: { postgres?: any; s3?: any; bucket?: string }
) {
  const docker = ctx.node('docker');
  if (!docker) {
    ctx.report.cover('repro:binding vs restarting container', 'skipped', undefined, 'no ready docker node');
    return;
  }
  const repro = new BindingRestartRepro(ctx, docker.nodeId, docker.address, storage);
  const invariant = { invariant: 'link-desired-equals-actual', severity: 'critical' as const };
  for (const [kind, port] of [
    ['database', 18301],
    ['storage', 18302],
  ] as const) {
    if (kind === 'database' ? !storage.postgres : !storage.s3 || !storage.bucket) {
      ctx.report.cover(
        `repro:A ${kind} binding during a crash loop`,
        'skipped',
        undefined,
        `managed ${kind} not ready`
      );
      continue;
    }
    const name = ctx.name(`crash-${kind}`);
    let bindingId: string | undefined;
    await ctx.step(
      `repro:A ${kind} binding created during a crash loop`,
      async () => {
        await repro.createApp(kind, name, port);
        await repro.waitRestarting(name);
        bindingId = await repro.createBinding(kind, name);
        await repro.assertLinked(kind, bindingId, name, port);
      },
      invariant
    );
    if (!bindingId) continue;
    await ctx.step(
      `repro:A.4 ${kind} binding deleted and recreated during the crash loop`,
      async () => {
        await repro.deleteBinding(kind, bindingId!);
        await repro.waitRestarting(name);
        bindingId = await repro.createBinding(kind, name);
        await repro.assertLinked(kind, bindingId, name, port);
      },
      invariant
    );
    await ctx.step(
      `repro:A.5 ${kind} binding created right after an Opfield restart`,
      async () => {
        await repro.deleteBinding(kind, bindingId!);
        const restart = await repro.restart(name);
        if (!ok(restart) && restart.status !== 409) expectOk(restart, 'restart');
        bindingId = await repro.createBinding(kind, name);
        await repro.assertLinked(kind, bindingId, name, port, 180_000);
      },
      invariant
    );
  }

  const nginx = ctx.node('nginx');
  const dbApp = ctx.name('crash-database');
  await ctx.step(
    'repro:B Route Secure Link survives a binding recreate of a stopped target',
    async () => {
      if (!nginx?.address) throw new Skip('no ready nginx node with an address');
      if (!storage.postgres) throw new Failure('managed postgres not ready');
      const before = await repro.inspect(dbApp);
      if (before?.status !== 'running') throw new Failure(`repro A left ${dbApp} ${before?.status ?? 'missing'}`);
      const domain = `${ctx.name('crashroute')}.example.test`;
      const route = await ctx.client.post('/api/proxy-hosts', {
        type: 'proxy',
        nodeId: nginx.nodeId,
        domainNames: [domain],
        createMissingDomains: true,
        upstreamKind: 'docker_container',
        dockerNodeId: docker.nodeId,
        dockerContainerName: dbApp,
        dockerContainerPort: 3000,
      });
      expectOk(route, 'route to the crash app');
      const routeId = String(data<any>(route)?.id);
      ctx.onCleanup(`route ${routeId}`, async () => {
        await ctx.client.delete(`/api/proxy-hosts/${routeId}`, { template: '/api/proxy-hosts/{id}' });
      });
      const served = async (timeoutMs: number) =>
        waitFor(
          async () => {
            const result = await httpProbe(`http://${nginx.address}/`, { host: domain });
            return result.status === 200 && result.body.includes('ok') ? true : undefined;
          },
          { timeoutMs, intervalMs: 2000 }
        );
      if (!(await served(180_000))) throw new Failure('route never served the app before the recreate');
      const { path, template } = {
        path: `/api/databases/managed/${storage.postgres.id}/bindings`,
        template: '/api/databases/managed/{id}/bindings',
      };
      const current = rows(await ctx.client.get(path, { template })).find((row) => row.targetResourceId === dbApp);
      await repro.stop(dbApp);
      if (current) await repro.deleteBinding('database', current.id);
      const recreated = await repro.createBinding('database', dbApp);
      const routeRow = data<any>(
        await ctx.client.get(`/api/proxy-hosts/${routeId}`, { template: '/api/proxy-hosts/{id}' })
      );
      ctx.report.note(
        `repro B: route secureLinkLastError after the recreate of a stopped target: ${String(routeRow?.secureLinkLastError ?? 'none').slice(0, 120)}`
      );
      await repro.start(dbApp);
      const healed = await waitFor(
        async () => {
          const row = data<any>(
            await ctx.client.get(`/api/proxy-hosts/${routeId}`, { template: '/api/proxy-hosts/{id}' })
          );
          const result = await httpProbe(`http://${nginx.address}/`, { host: domain });
          return !row?.secureLinkLastError && result.status === 200 && result.body.includes('ok') ? true : undefined;
        },
        { timeoutMs: 60_000, intervalMs: 2000 }
      );
      const after = await repro.inspect(dbApp);
      if (!healed)
        throw new Failure(
          `Route ${domain} does not serve the recreated container 60 s after its start (secureLinkLastError ${String(
            data<any>(await ctx.client.get(`/api/proxy-hosts/${routeId}`, { template: '/api/proxy-hosts/{id}' }))
              ?.secureLinkLastError ?? 'none'
          ).slice(0, 120)})`
        );
      if (before && after && before.id === after.id)
        ctx.report.note('repro B: the binding recreate kept the container id');
      void recreated;
    },
    invariant
  );
}
