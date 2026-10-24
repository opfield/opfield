import { randomUUID } from 'node:crypto';
import { FLEET_ROLES, type FleetNode, type FleetRole, type MatrixContext } from './context.js';
import { data, describe, errorCode, expectOk, Failure, ok, type Response, rows, Skip, sleep, waitFor } from './http.js';
import { excerpt } from './report.js';

/** Small VMs: the matrix tests behaviour, not capacity. Builder and storage get room for their images. */
const SIZES: Record<FleetRole, { cpu: number; memoryMb: number; diskGb: number }> = {
  nginx: { cpu: 1, memoryMb: 1024, diskGb: 8 },
  docker: { cpu: 1, memoryMb: 2048, diskGb: 16 },
  storage: { cpu: 2, memoryMb: 2048, diskGb: 20 },
  builder: { cpu: 2, memoryMb: 2048, diskGb: 20 },
  monitoring: { cpu: 1, memoryMb: 1024, diskGb: 8 },
  relay: { cpu: 1, memoryMb: 1024, diskGb: 8 },
};
// MATRIX_SIZES=docker=1:1024:16,storage=2:2048:20 overrides cpu:memoryMb:diskGb per role.
for (const entry of (process.env.MATRIX_SIZES ?? '').split(',').filter(Boolean)) {
  const [role, spec] = entry.split('=');
  const [cpu, memoryMb, diskGb] = String(spec).split(':').map(Number);
  if (role && role in SIZES && cpu && memoryMb && diskGb) SIZES[role as FleetRole] = { cpu, memoryMb, diskGb };
}
const IMAGE_FAMILIES = ['debian-13', 'ubuntu-24.04', 'fedora'] as const;
const TERMINAL = new Set(['ready', 'failed']);

const hosting = (ctx: MatrixContext) => `/api/integrations/hosting/${ctx.config.connectorId}`;

function ipv4s(value: unknown) {
  return [...JSON.stringify(value ?? '').matchAll(/\b(\d{1,3}(?:\.\d{1,3}){3})\b/g)].map((match) => match[1]!);
}

function expandRange(range: string) {
  const out: string[] = [];
  for (const part of range
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)) {
    const [from, to] = part.split('-').map((item) => item.trim());
    const base = from!.split('.').slice(0, 3).join('.');
    const start = Number(from!.split('.')[3]);
    const end = to ? Number(to.split('.').pop()) : start;
    for (let octet = start; octet <= end; octet += 1) out.push(`${base}.${octet}`);
  }
  return out;
}

export async function loadConnector(ctx: MatrixContext) {
  const response = await ctx.client.get(hosting(ctx), { template: '/api/integrations/hosting/{id}' });
  expectOk(response, 'GET hosting connector');
  ctx.undocumentedUsed.add('GET /api/integrations/hosting/{id}');
  return data<any>(response);
}

async function loadCatalog(ctx: MatrixContext) {
  const template = '/api/integrations/hosting/{id}/catalog';
  ctx.undocumentedUsed.add(`GET ${template}`);
  const catalog = await waitFor(
    async () => {
      const response = await ctx.client.get(`${hosting(ctx)}/catalog`, { template });
      if (ok(response)) return data<any>(response);
      if (response.status === 503) {
        await ctx.client.post(`${hosting(ctx)}/sync`, undefined, { template: '/api/integrations/hosting/{id}/sync' });
        return undefined;
      }
      throw new Failure(`GET hosting catalog: ${describe(response)}`, response);
    },
    { timeoutMs: 180_000, intervalMs: ctx.config.pollMs }
  );
  if (!catalog) throw new Error('Hosting catalog did not become ready within 3 min');
  return catalog;
}

export async function listResources(ctx: MatrixContext) {
  const template = '/api/integrations/hosting/{id}/resources';
  ctx.undocumentedUsed.add(`GET ${template}`);
  const response = await ctx.client.get(`${hosting(ctx)}/resources`, { template });
  expectOk(response, 'GET hosting resources');
  return rows(response);
}

async function listNodes(ctx: MatrixContext) {
  const response = await ctx.client.get('/api/nodes', { query: { limit: 100 } });
  expectOk(response, 'GET /api/nodes');
  return rows(response);
}

function chooseImage(ctx: MatrixContext, catalog: any, role: FleetRole, index: number, offset: number) {
  const images: any[] = (catalog.images ?? []).filter(
    (image: any) => !Array.isArray(image.supportedRoles) || image.supportedRoles.includes(role)
  );
  if (!images.length) throw new Skip(`hosting catalog offers no image for role ${role}`);
  const family = IMAGE_FAMILIES[(index + offset) % IMAGE_FAMILIES.length]!;
  return images.find((image) => String(image.id).startsWith(family)) ?? ctx.rng.pick(images);
}

async function pollOperation(
  ctx: MatrixContext,
  operationId: string,
  label: string,
  deadlineMs: number,
  stopEarly?: (operation: any) => Promise<boolean>
) {
  const template = '/api/hosting/operations/{id}';
  ctx.undocumentedUsed.add(`GET ${template}`);
  const started = Date.now();
  const timeline: Array<{ phase: string; at: number }> = [];
  let last: any;
  for (;;) {
    const response = await ctx.client.get(`/api/hosting/operations/${operationId}`, { template });
    if (ok(response)) {
      last = data<any>(response);
      if (timeline.at(-1)?.phase !== last.phase) timeline.push({ phase: last.phase, at: Date.now() });
      if (TERMINAL.has(last.phase)) break;
      if (stopEarly && (await stopEarly(last))) break;
    }
    if (Date.now() - started > deadlineMs) break;
    await sleep(ctx.config.pollMs);
  }
  const phases = timeline.map((entry) => `${entry.phase}@${Math.round((entry.at - started) / 1000)}s`).join(' → ');
  ctx.report.note(`${label}: ${phases}`);
  return { operation: last, timeline, ms: Date.now() - started, phases };
}

async function waitNodeOnline(ctx: MatrixContext, nodeId: string, timeoutMs: number) {
  let last: any;
  const online = await waitFor(
    async () => {
      const response = await ctx.client.get(`/api/nodes/${nodeId}`, { template: '/api/nodes/{id}' });
      if (!ok(response)) return undefined;
      last = data<any>(response);
      return last?.status === 'online' && last?.isConnected !== false ? last : undefined;
    },
    { timeoutMs, intervalMs: ctx.config.pollMs }
  );
  return { online, last };
}

let poolAddresses: string[] = [];

function resourceAddress(resource: any, gateway?: string) {
  const candidates = ipv4s(resource).filter((ip) => ip !== gateway && !ip.endsWith('.0') && !ip.startsWith('127.'));
  return candidates.find((ip) => poolAddresses.includes(ip)) ?? candidates[0];
}

async function orderRole(
  ctx: MatrixContext,
  role: FleetRole,
  request: Record<string, unknown>,
  origin: FleetNode['origin']
): Promise<FleetNode | undefined> {
  const label = `hosting ${origin === 'installed-existing' ? 'install' : 'order'} ${role}`;
  const response = await ctx.client.post('/api/hosting/operations', request, { template: '/api/hosting/operations' });
  ctx.undocumentedUsed.add('POST /api/hosting/operations');
  if (!ok(response)) {
    ctx.report.add({
      severity: 'critical',
      invariant: 'hosting-order-accepted',
      title: `Ordering a ${role} VM was refused: ${errorCode(response) ?? response.status}`,
      request: { method: 'POST', path: '/api/hosting/operations', body: excerpt(request, '', 400) },
      response: { status: response.status, excerpt: excerpt(response.body, response.text) },
    });
    ctx.report.cover(`fleet:${role}`, 'failed', 'order', `order refused ${response.status}`);
    return undefined;
  }
  const accepted = data<any>(response);
  const operationId = accepted.id as string;
  // The same idempotency key must return the same operation, never a second VM.
  const replay = await ctx.client.post('/api/hosting/operations', request, { template: '/api/hosting/operations' });
  if (!ok(replay) || data<any>(replay)?.id !== operationId)
    ctx.report.add({
      severity: 'critical',
      invariant: 'idempotent-replay',
      title: `Replaying a hosting order with the same idempotencyKey did not return the same operation (${role})`,
      request: { method: 'POST', path: '/api/hosting/operations' },
      response: { status: replay.status, excerpt: excerpt(replay.body, replay.text) },
    });
  ctx.track({
    kind: 'hosting-operation',
    label,
    deadlineMs: ctx.config.deadlines.hostingOperationMs,
    poll: async () => {
      const current = await ctx.client.get(`/api/hosting/operations/${operationId}`, {
        template: '/api/hosting/operations/{id}',
      });
      const phase = data<any>(current)?.phase ?? `http-${current.status}`;
      return { state: phase, terminal: TERMINAL.has(phase) };
    },
  });
  // A node that is online and connected while its operation still waits is a readiness bug: stop waiting after a grace.
  let onlineSince: number | undefined;
  const onlineGraceMs = Math.max(60_000, Number(process.env.MATRIX_ONLINE_GRACE_MS) || 240_000);
  const result = await pollOperation(
    ctx,
    operationId,
    label,
    ctx.config.deadlines.hostingOperationMs,
    async (operation) => {
      const id = operation.nodeId ?? operation.node?.id ?? operation.result?.nodeId;
      if (!id) return false;
      const node = data<any>(await ctx.client.get(`/api/nodes/${id}`, { template: '/api/nodes/{id}' }));
      if (node?.status === 'online' && node?.isConnected !== false) onlineSince ??= Date.now();
      else onlineSince = undefined;
      return onlineSince !== undefined && Date.now() - onlineSince > onlineGraceMs;
    }
  );
  const operation = result.operation ?? accepted;
  const nodeId = (operation.nodeId ?? operation.node?.id ?? operation.result?.nodeId) as string | undefined;
  const resourceId = (operation.resourceId ?? operation.result?.resourceId) as string | undefined;
  const failedNode = (): FleetNode | undefined =>
    nodeId || resourceId
      ? {
          role,
          nodeId: nodeId ?? '',
          name: String(request.name),
          operationId,
          resourceId,
          origin,
          image: String(request.image),
          ready: false,
          phase: operation.phase,
        }
      : undefined;
  if (!TERMINAL.has(operation.phase)) {
    const online = onlineSince !== undefined;
    ctx.report.add({
      severity: 'critical',
      invariant: online ? 'online-means-ready' : 'async-terminal',
      title: online
        ? `${label}: node is online and connected but the operation stays "${operation.phase}" (${Math.round((Date.now() - onlineSince!) / 60_000)} min after the node came online)`
        : `${label}: operation stuck in phase "${operation.phase}" after ${Math.round(result.ms / 60_000)} min`,
      request: { method: 'GET', path: `/api/hosting/operations/${operationId}` },
      response: { status: 200, excerpt: excerpt(operation, '') },
      detail: `phase timeline: ${result.phases}; image ${String(request.image)}`,
    });
    ctx.report.cover(`fleet:${role}`, 'failed', 'operation-terminal', `stuck in ${operation.phase}`);
    const node = failedNode();
    // The node itself works: keep it in the fleet so the runtime phase still covers the role.
    if (node && online) node.ready = true;
    return node;
  }
  if (operation.phase === 'failed') {
    ctx.report.add({
      severity: 'critical',
      invariant: 'hosting-operation-ready',
      title:
        `${label} failed: ${operation.errorCode ?? ''} ${String(operation.errorMessage ?? '').slice(0, 160)}`.trim(),
      request: { method: 'GET', path: `/api/hosting/operations/${operationId}` },
      response: { status: 200, excerpt: excerpt(operation, '') },
      detail: `phase timeline: ${result.phases}; image ${String(request.image)}`,
    });
    ctx.report.cover(`fleet:${role}`, 'failed', 'operation-ready', operation.errorCode ?? 'failed');
    return failedNode();
  }
  if (!nodeId) throw new Error(`${label}: ready operation carries no nodeId`);
  const { online, last } = await waitNodeOnline(ctx, nodeId, ctx.config.deadlines.nodeOnlineMs);
  if (!online)
    ctx.report.add({
      severity: 'critical',
      invariant: 'ready-means-online',
      title: `${label}: operation is ready but node is ${last?.status ?? 'unknown'} (connected=${String(last?.isConnected)})`,
      request: { method: 'GET', path: `/api/nodes/${nodeId}` },
      response: { status: 200, excerpt: excerpt(last, '') },
    });
  ctx.report.cover(`fleet:${role}`, online ? 'exercised' : 'failed', 'ready+online');
  return {
    role,
    nodeId,
    name: String(request.name),
    operationId,
    resourceId,
    origin,
    image: String(request.image),
    ready: Boolean(online),
    phase: operation.phase,
  };
}

/** Phase 1: order one VM per role in parallel, wait for ready + online, and check nothing is left half-enrolled. */
export async function provisionFleet(ctx: MatrixContext) {
  const connector = await loadConnector(ctx);
  if (connector.enabled === false) throw new Error('Hosting connector is disabled');
  const catalog = await loadCatalog(ctx);
  const settings = connector.settings ?? {};
  const location = settings.proxmoxHost ?? catalog.locations?.[0]?.id;
  const nodesBefore = await listNodes(ctx);
  const resourcesBefore = await listResources(ctx);

  if (ctx.config.reuseFleet) await reuseExistingFleet(ctx, nodesBefore);

  const offset = ctx.rng.int(0, IMAGE_FAMILIES.length - 1);
  const poolIps = settings.proxmox?.ipRange ? expandRange(settings.proxmox.ipRange) : [];
  poolAddresses = [...poolIps];
  const used = new Set([...ipv4s(resourcesBefore), ...ipv4s(nodesBefore)]);
  const freeIps = poolIps.filter((ip) => !used.has(ip));

  const orders = FLEET_ROLES.filter((role) => !ctx.fleet.has(role) && ctx.config.roles.includes(role)).map(
    async (role, index) => {
      try {
        const image = chooseImage(ctx, catalog, role, index, offset);
        const request: Record<string, unknown> = {
          connectorId: ctx.config.connectorId,
          idempotencyKey: randomUUID(),
          name: ctx.name(role),
          role,
          location,
          size: connector.provider === 'proxmox' ? 'custom' : catalog.sizes?.[0]?.id,
          image: image.id,
          ...(connector.provider === 'proxmox' ? SIZES[role] : {}),
        };
        if (role === 'relay') {
          // A relay advertises its own address, so it needs a known IP before the VM exists.
          const ip = freeIps.pop();
          if (!ip) throw new Skip('no free static IP left in the connector pool for the relay address');
          request.ipAddress = ip;
          request.relayAddress = ip;
        }
        const node = await orderRole(ctx, role, request, 'ordered');
        if (node) ctx.fleet.set(role, node);
      } catch (error) {
        if (error instanceof Skip) {
          ctx.report.cover(`fleet:${role}`, 'skipped', undefined, error.message);
          return;
        }
        ctx.report.add({
          severity: 'critical',
          invariant: 'hosting-order',
          title: `Ordering ${role}: ${(error as Error).message}`,
        });
      }
    }
  );
  await Promise.all(orders);

  // A failed order keeps its VM for diagnosis. Record it (done above), delete that VM and order the role once more
  // (the failed roles together, not all six), so one provider hiccup does not cost the whole runtime coverage of the role.
  // Only terminal failures: a VM whose operation is still running cannot be deleted and stays for teardown.
  const failed = [...ctx.fleet.values()].filter(
    (item) => !item.ready && item.origin === 'ordered' && item.phase === 'failed'
  );
  await Promise.all(
    failed.map((node) =>
      ctx.step(
        `fleet:${node.role} re-order after a failed order`,
        async () => {
          await removeFleetNode(ctx, node);
          ctx.fleet.delete(node.role);
          const index = FLEET_ROLES.indexOf(node.role);
          const image = chooseImage(ctx, catalog, node.role, index, offset);
          const request: Record<string, unknown> = {
            connectorId: ctx.config.connectorId,
            idempotencyKey: randomUUID(),
            name: ctx.name(`${node.role}-r`),
            role: node.role,
            location,
            size: connector.provider === 'proxmox' ? 'custom' : catalog.sizes?.[0]?.id,
            image: image.id,
            ...(connector.provider === 'proxmox' ? SIZES[node.role] : {}),
          };
          if (node.role === 'relay') {
            const ip = freeIps.pop();
            if (!ip) throw new Skip('no free static IP left for the relay retry');
            request.ipAddress = ip;
            request.relayAddress = ip;
          }
          const retried = await orderRole(ctx, node.role, request, 'ordered');
          if (retried) ctx.fleet.set(node.role, retried);
          if (!retried?.ready) throw new Error(`the re-order of ${node.role} did not become ready either`);
        },
        { invariant: 'hosting-operation-ready', severity: 'critical' }
      )
    )
  );

  await ctx.step('fleet:install-on-existing-vm', async () => {
    const candidates = await ctx.client.get(`${hosting(ctx)}/adoption-candidates`, {
      template: '/api/integrations/hosting/{id}/adoption-candidates',
    });
    const all = [...(await listResources(ctx)), ...rows(candidates)];
    const existing = all.find(
      (resource) =>
        resource.origin === 'discovered' && !resource.nodeId && !(resource.nodes ?? resource.bindings ?? []).length
    );
    if (!existing)
      throw new Skip(
        'no unbound discovered VM in the connector scope (every pool VM was created by Opfield); install-on-existing needs a VM made outside Opfield'
      );
    const role: FleetRole = 'monitoring';
    const node = await orderRole(
      ctx,
      role,
      {
        connectorId: ctx.config.connectorId,
        idempotencyKey: randomUUID(),
        name: ctx.name(`${role}-existing`),
        role,
        location,
        size: connector.provider === 'proxmox' ? 'custom' : catalog.sizes?.[0]?.id,
        image: chooseImage(ctx, catalog, role, 0, offset).id,
        existingResourceId: existing.id,
      },
      'installed-existing'
    );
    if (node) ctx.extraFleet.push(node);
  });

  await resolveAddresses(ctx, settings.proxmox?.gateway);
  await ctx.step(
    'fleet:nothing-half-enrolled',
    async () => {
      const operations = rows(
        await ctx.client.get(`${hosting(ctx)}/operations`, { template: '/api/integrations/hosting/{id}/operations' })
      );
      const fleetOps = new Set([...ctx.fleet.values()].map((node) => node.operationId));
      const open = operations.filter((operation) => fleetOps.has(operation.id) && !TERMINAL.has(operation.phase));
      const nodes = await listNodes(ctx);
      const halfEnrolled = nodes.filter(
        (node) => String(node.hostname ?? '').startsWith(ctx.config.prefix) && node.status !== 'online'
      );
      if (open.length || halfEnrolled.length)
        throw new Error(
          `open operations: ${open.map((operation) => `${operation.id}=${operation.phase}`).join(', ') || 'none'}; non-online fleet nodes: ${halfEnrolled.map((node) => `${node.hostname}=${node.status}`).join(', ') || 'none'}`
        );
    },
    { invariant: 'no-half-enrolled', severity: 'critical' }
  );
  console.log(
    `  fleet: ${[...ctx.fleet.values()].map((node) => `${node.role}=${node.address ?? '?'}(${node.image ?? node.origin})`).join(' ')}`
  );
}

/** Sweep mode: every node and VM named with the run prefix joins the fleet so teardown removes it. */
export async function adoptForSweep(ctx: MatrixContext) {
  const nodes = (await listNodes(ctx)).filter((row) => String(row.hostname ?? '').startsWith(ctx.config.prefix));
  for (const node of nodes) {
    const binding = await ctx.client.get(`/api/hosting/nodes/${node.id}`, { template: '/api/hosting/nodes/{id}' });
    const projection = data<any>(binding);
    const resourceId = projection?.resource?.id ?? projection?.resourceId ?? projection?.binding?.resourceId;
    ctx.extraFleet.push({
      role: node.type as FleetRole,
      nodeId: node.id,
      name: node.hostname,
      resourceId,
      origin: 'reused',
      ready: false,
    });
  }
  ctx.report.note(`sweep: ${nodes.length} run-prefixed nodes adopted for teardown`);
}

/** Picks up fleet nodes of an earlier run with the same SEED (named `<prefix><role>`). */
export async function reuseExistingFleet(ctx: MatrixContext, nodes?: any[]) {
  const all = nodes ?? (await listNodes(ctx));
  for (const role of FLEET_ROLES) {
    const matches = all.filter(
      (row) => [ctx.name(role), ctx.name(`${role}-r`)].includes(row.hostname) && row.type === role
    );
    // Only online nodes are reused; a half-enrolled one is left for teardown and the role is ordered again.
    const node = matches.find((row) => row.status === 'online');
    if (!node) continue;
    const binding = await ctx.client.get(`/api/hosting/nodes/${node.id}`, { template: '/api/hosting/nodes/{id}' });
    const projection = data<any>(binding);
    const resourceId = projection?.resource?.id ?? projection?.resourceId ?? projection?.binding?.resourceId;
    ctx.fleet.set(role, {
      role,
      nodeId: node.id,
      name: node.hostname,
      resourceId,
      origin: 'reused',
      ready: node.status === 'online',
    });
    ctx.report.note(`reusing fleet node ${node.hostname} (${node.status}, resource ${resourceId ?? 'unknown'})`);
  }
}

export async function resolveAddresses(ctx: MatrixContext, gateway?: string) {
  const resources = await listResources(ctx).catch(() => []);
  for (const node of ctx.fleet.values()) {
    const resource = resources.find((row) => row.id === node.resourceId);
    if (resource) node.address = resourceAddress(resource, gateway);
    if (!node.address) {
      const response = await ctx.client.get(`/api/nodes/${node.nodeId}`, { template: '/api/nodes/{id}' });
      const row = data<any>(response);
      node.address = row?.effectiveServiceAddress ?? row?.serviceAddress ?? ipv4s(row?.lastHealthReport ?? {})[0];
    }
  }
}

/** Node health at a moment: every fleet node that was ready is still (or again) online and connected. */
export async function assertFleetHealthy(ctx: MatrixContext, label: string) {
  await Promise.all(
    [...ctx.fleet.values()]
      .filter((node) => node.ready)
      .map(async (node) => {
        const { online, last } = await waitNodeOnline(ctx, node.nodeId, ctx.config.deadlines.nodeOnlineMs);
        if (!online)
          ctx.report.add({
            severity: 'high',
            invariant: 'nodes-healthy',
            title: `${label}: fleet ${node.role} node is ${last?.status ?? 'missing'} (connected=${String(last?.isConnected)})`,
            dedupeKey: `nodes-healthy|${label}|${node.role}`,
            request: { method: 'GET', path: `/api/nodes/${node.nodeId}` },
            response: last ? { status: 200, excerpt: excerpt(last, '') } : undefined,
          });
      })
  );
}

export async function hostingAction(
  ctx: MatrixContext,
  resourceId: string,
  action: 'reboot' | 'delete' | 'shutdown' | 'start',
  deadlineMs: number
) {
  const resources = await listResources(ctx);
  const resource = resources.find((row) => row.id === resourceId);
  if (!resource) return { missing: true as const };
  const incarnation = resource.incarnation ?? resource.snapshot?.incarnation;
  const body = {
    idempotencyKey: randomUUID(),
    action,
    expectedIncarnation: String(incarnation ?? ''),
    confirmed: true,
    reason: `opfield matrix ${ctx.config.seed}`,
  };
  const template = '/api/hosting/resources/{id}/actions';
  ctx.undocumentedUsed.add(`POST ${template}`);
  const response = await ctx.client.post(`/api/hosting/resources/${resourceId}/actions`, body, { template });
  expectOk(response, `hosting ${action}`, {
    method: 'POST',
    path: `/api/hosting/resources/${resourceId}/actions`,
    body,
  });
  const operationId = data<any>(response)?.id as string;
  const result = await pollOperation(ctx, operationId, `hosting ${action} ${resource.name ?? resourceId}`, deadlineMs);
  return { missing: false as const, ...result };
}

/** Confirmed hosting delete of one fleet VM, then its node record. Failures become findings. */
/**
 * A relay leaves the pool while it is online: drain it, then remove its node. Once its VM is gone it would be an
 * offline relay, removable only after its signed policy expires (days).
 */
async function retireRelay(ctx: MatrixContext, node: FleetNode) {
  const pool = await ctx.client.get('/api/system/relay');
  const instances: any[] = rows(pool).length ? rows(pool) : (data<any>(pool)?.instances ?? []);
  const instance = instances.find((row) => row.nodeId === node.nodeId || JSON.stringify(row).includes(node.nodeId));
  if (instance) {
    const iid = encodeURIComponent(String(instance.id ?? instance.instanceId));
    await ctx.client.post(
      `/api/system/relay/instances/${iid}/drain`,
      { confirm: true },
      { template: '/api/system/relay/instances/{instanceId}/drain' }
    );
  }
  let last: Response | undefined;
  const removed = await waitFor(
    async () => {
      last = await ctx.client.delete(`/api/nodes/${node.nodeId}`, { template: '/api/nodes/{id}' });
      return ok(last) || last.status === 404 ? true : last.status === 409 ? undefined : false;
    },
    { timeoutMs: 180_000, intervalMs: ctx.config.pollMs }
  );
  if (removed !== true)
    ctx.report.add({
      severity: 'high',
      invariant: 'teardown',
      title: `A drained, online relay node cannot be removed: ${last?.status} ${last ? (errorCode(last) ?? '') : ''}`,
      response: last ? { status: last.status, excerpt: excerpt(last.body, last.text) } : undefined,
    });
}

export async function removeFleetNode(ctx: MatrixContext, node: FleetNode) {
  if (node.role === 'relay' && node.nodeId) await retireRelay(ctx, node);
  if (node.resourceId) {
    try {
      let result: Awaited<ReturnType<typeof hostingAction>>;
      try {
        result = await hostingAction(ctx, node.resourceId, 'delete', 12 * 60_000);
      } catch (error) {
        if (!(error instanceof Failure) || errorCode(error.response!) !== 'HOSTING_RESOURCE_BUSY') throw error;
        // A never-finishing operation blocks deletion. Remove the node, reconcile the open operations, retry once.
        ctx.report.add({
          severity: 'high',
          invariant: 'teardown',
          title: `Deleting the ${node.role} VM is refused with HOSTING_RESOURCE_BUSY (another operation open)`,
          dedupeKey: `resource-busy|${node.role}`,
          response: error.response
            ? { status: error.response.status, excerpt: excerpt(error.response.body, error.response.text) }
            : undefined,
          detail:
            'The runner removed the node record and called reconcile on the open operation to unblock the delete.',
        });
        const nodeIds = node.nodeId
          ? [node.nodeId]
          : (await listNodes(ctx).catch(() => []))
              .filter((row) => row.hostname === node.name)
              .map((row) => String(row.id));
        for (const id of nodeIds) await ctx.client.delete(`/api/nodes/${id}`, { template: '/api/nodes/{id}' });
        const operations = rows(
          await ctx.client.get(`${hosting(ctx)}/operations`, { template: '/api/integrations/hosting/{id}/operations' })
        );
        for (const operation of operations.filter(
          (row) => row.resourceId === node.resourceId && !TERMINAL.has(row.phase)
        ))
          await ctx.client.post(`/api/hosting/operations/${operation.id}/reconcile`, undefined, {
            template: '/api/hosting/operations/{id}/reconcile',
          });
        // Let an operation that is still legitimately running (a reboot) finish before retrying.
        await waitFor(
          async () => {
            const open = rows(
              await ctx.client.get(`${hosting(ctx)}/operations`, {
                template: '/api/integrations/hosting/{id}/operations',
              })
            ).filter((row) => row.resourceId === node.resourceId && !TERMINAL.has(row.phase));
            return open.length ? undefined : true;
          },
          { timeoutMs: 120_000, intervalMs: ctx.config.pollMs }
        );
        result = await hostingAction(ctx, node.resourceId, 'delete', 12 * 60_000);
      }
      if (!result.missing && result.operation?.phase !== 'ready')
        ctx.report.add({
          severity: 'high',
          invariant: 'teardown',
          title: `Deleting the ${node.role} VM ended in phase ${result.operation?.phase ?? 'unknown'}`,
          dedupeKey: `teardown|${node.role}|${node.resourceId}`,
          response: { status: 200, excerpt: excerpt(result.operation, '') },
        });
    } catch (error) {
      ctx.report.add({
        severity: 'high',
        invariant: 'teardown',
        title: `Deleting the ${node.role} VM: ${(error as Error).message.slice(0, 200)}`,
      });
    }
  }
  if (!node.nodeId) return;
  const removed = await ctx.client.delete(`/api/nodes/${node.nodeId}`, { template: '/api/nodes/{id}' });
  if (!ok(removed) && removed.status !== 404)
    ctx.report.add({
      severity: 'high',
      invariant: 'teardown',
      title: `DELETE node ${node.role} returned ${removed.status} (${errorCode(removed) ?? ''})`,
      request: { method: 'DELETE', path: `/api/nodes/${node.nodeId}` },
      response: { status: removed.status, excerpt: excerpt(removed.body, removed.text) },
    });
}

async function rebootThenDelete(ctx: MatrixContext, nodes: FleetNode[]) {
  const targets = nodes.filter((node) => node.ready && node.resourceId);
  for (const [index, node] of targets.entries()) {
    const viaNode = index % 2 === 0;
    await ctx.step(
      `fleet:reboot then immediate ${viaNode ? 'node' : 'VM'} delete (${node.role})`,
      async () => {
        const resources = await listResources(ctx);
        const resource = resources.find((row) => row.id === node.resourceId);
        if (!resource) throw new Skip('resource not listed');
        const reboot = await ctx.client.post(
          `/api/hosting/resources/${node.resourceId}/actions`,
          {
            idempotencyKey: randomUUID(),
            action: 'reboot',
            expectedIncarnation: String(resource.incarnation ?? resource.snapshot?.incarnation ?? ''),
            confirmed: true,
            reason: `opfield matrix ${ctx.config.seed}`,
          },
          { template: '/api/hosting/resources/{id}/actions' }
        );
        expectOk(reboot, 'hosting reboot');
        const response = viaNode
          ? await ctx.client.delete(`/api/nodes/${node.nodeId}`, { template: '/api/nodes/{id}' })
          : await ctx.client.post(
              `/api/hosting/resources/${node.resourceId}/actions`,
              {
                idempotencyKey: randomUUID(),
                action: 'delete',
                expectedIncarnation: String(resource.incarnation ?? resource.snapshot?.incarnation ?? ''),
                confirmed: true,
                reason: `opfield matrix ${ctx.config.seed}`,
              },
              { template: '/api/hosting/resources/{id}/actions' }
            );
        const code = errorCode(response) ?? '';
        ctx.report.note(
          `reboot then ${viaNode ? 'DELETE node' : 'hosting delete'} (${node.role}): ${response.status} ${code}`
        );
        if (code === 'HOSTING_FIREWALL_BUSY')
          throw new Failure(
            `${viaNode ? 'node' : 'VM'} delete right after a reboot answers 409 HOSTING_FIREWALL_BUSY`,
            response
          );
        if (response.status >= 500)
          throw new Failure(
            `${viaNode ? 'node' : 'VM'} delete right after a reboot answers ${response.status}`,
            response
          );
      },
      { invariant: 'delete-after-reboot', severity: 'high' }
    );
  }
}

/** Removes every fleet VM (confirmed hosting delete) and node record, then checks nothing is left. */
export async function teardownFleet(ctx: MatrixContext) {
  const nodes = [...ctx.fleet.values(), ...ctx.extraFleet];
  // Pending orders that never reached the fleet map still own a VM: find them by name.
  const resources = await listResources(ctx).catch(() => []);
  const extra = resources.filter(
    (resource) =>
      String(resource.name ?? '').startsWith(ctx.config.prefix) &&
      !nodes.some((node) => node.resourceId === resource.id)
  );
  // MATRIX_REBOOT_THEN_DELETE=1: reboot a VM and delete it (or its node) immediately, while the reboot and the
  // firewall observation still hold the VM — deletion must not answer HOSTING_FIREWALL_BUSY.
  if (process.env.MATRIX_REBOOT_THEN_DELETE === '1') await rebootThenDelete(ctx, nodes);
  await Promise.all([
    ...nodes.map((node) => removeFleetNode(ctx, node)),
    // VMs of orders that never joined the fleet map (refused, interrupted): same removal path, without a node id.
    ...extra.map((resource) =>
      removeFleetNode(ctx, {
        role: 'docker',
        nodeId: '',
        name: String(resource.name ?? resource.id),
        resourceId: resource.id,
        origin: 'ordered',
        ready: false,
      })
    ),
  ]);
  // Node records of orders that never reported a node id (and any other run-prefixed node).
  for (const node of (await listNodes(ctx).catch(() => [])).filter((row) =>
    String(row.hostname ?? '').startsWith(ctx.config.prefix)
  ))
    await ctx.client.delete(`/api/nodes/${node.id}`, { template: '/api/nodes/{id}' });
  const fleetResourceIds = new Set(
    [...nodes.map((node) => node.resourceId), ...extra.map((resource) => resource.id)].filter(Boolean)
  );
  const leftover = await waitFor(
    async () => {
      const current = await listResources(ctx).catch(() => undefined);
      if (!current) return undefined;
      const left = current.filter(
        (resource) => fleetResourceIds.has(resource.id) || String(resource.name ?? '').startsWith(ctx.config.prefix)
      );
      return left.length === 0 ? [] : undefined;
    },
    { timeoutMs: 180_000, intervalMs: ctx.config.pollMs }
  );
  if (!leftover) {
    const current = await listResources(ctx).catch(() => []);
    ctx.report.add({
      severity: 'high',
      invariant: 'no-leftovers',
      title: 'Hosting resources of the fleet are still listed 3 min after confirmed deletion',
      detail: current
        .filter(
          (resource) => fleetResourceIds.has(resource.id) || String(resource.name ?? '').startsWith(ctx.config.prefix)
        )
        .map((resource) => `${resource.name ?? resource.id} (${resource.powerState ?? '?'})`)
        .join(', '),
    });
  }
  const nodesAfter = await listNodes(ctx).catch(() => []);
  const nodeLeft = nodesAfter.filter((node) => String(node.hostname ?? '').startsWith(ctx.config.prefix));
  if (nodeLeft.length)
    ctx.report.add({
      severity: 'medium',
      invariant: 'no-leftovers',
      title: `Fleet node records still present after teardown: ${nodeLeft.map((node) => node.hostname).join(', ')}`,
    });
  ctx.fleet.clear();
  ctx.extraFleet.length = 0;
}
