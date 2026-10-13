import { normalizeIp } from '@/lib/ip-cidr.js';
import { AppError } from '@/middleware/error-handler.js';
import { monthlyVmExpenses } from '../hosting-account-summary.js';
import { type HostingHttp, HostingHttpClient, HostingProviderError } from '../hosting-http.js';
import { hostingOsIdentity } from '../hosting-image-policy.js';
import { hostingLocationLabel } from '../hosting-location.js';
import {
  type HostingAccount,
  type HostingAccountSummary,
  type HostingActionRequest,
  type HostingAddress,
  type HostingCapabilities,
  type HostingCatalog,
  type HostingCatalogOption,
  type HostingConnection,
  type HostingCreateRequest,
  type HostingFinance,
  type HostingInventory,
  type HostingInvoice,
  type HostingMoney,
  type HostingPowerState,
  type HostingProviderAdapter,
  type HostingProviderOperation,
  type HostingResourceSnapshot,
  hostingCapabilities,
} from '../hosting-provider.types.js';
import {
  bytesTo,
  CLOUDBLAST_API_PREFIX,
  CLOUDBLAST_CURRENCY,
  CloudBlastApi,
  id,
  input,
  invalid,
  type Json,
  mutationResponse,
  number,
  optionalRecord,
  optionalString,
  record,
  string,
  unsafe,
  uuid,
  values,
} from './cloudblast-api.js';
import { CloudBlastBackupsAdapter } from './cloudblast-backups.js';
import { CloudBlastFirewallAdapter } from './cloudblast-firewall.js';

const MIB = 1024 ** 2;
const GIB = 1024 ** 3;
const POWER_PREFIX = 'power:';
const MARKER = /^gw-[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const MARKER_SUFFIX = /-(gw-[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})$/;
/** CloudBlast sells only x86-64 KVM plans (no ARM plans are documented); installer-supported families only. */
const ADMITTED_DISTRIBUTIONS = new Set(['ubuntu', 'debian']);
const RESIZE_UNSUPPORTED = 'CloudBlast does not expose plan changes through its API';
const POWER_ACTIONS = { start: 'start', shutdown: 'shutdown', reboot: 'restart' } as const;

type CbServer = {
  uuid: string;
  name: string;
  status: string | null;
  cpu: number | null;
  memoryMb: number | null;
  diskGb: number | null;
  location: string;
  addresses: HostingAddress[];
  plan: { id: string; price: HostingMoney | null } | null;
  marker?: string;
};
type CbStatus = { state: string | null; task: Json | null; serverStatus: string | null };
type CbLocation = { id: string; label: string };
type CbPlan = HostingCatalogOption & { available: boolean };

function amount(value: unknown): HostingMoney | null {
  const parsed = number(value);
  return parsed === null ? null : { amount: String(parsed), currency: CLOUDBLAST_CURRENCY, estimated: false };
}
function price(value: unknown, period: 'hour' | 'month'): HostingMoney | null {
  const parsed = amount(value);
  return parsed && Number(parsed.amount) >= 0 ? { ...parsed, estimated: true, period } : null;
}
function planPrice(object: Json): HostingMoney | null {
  return price(object.monthly_price, 'month') ?? price(object.hourly_price, 'hour');
}
function capabilities(account: boolean, finance: boolean): HostingCapabilities {
  const result = hostingCapabilities({
    create: account,
    start: true,
    shutdown: true,
    reboot: true,
    delete: true,
    finance,
  });
  if (!account) result.create = { available: false, reason: 'Provisioning is an account action' };
  result.resize = { available: false, reasonCode: 'unsupported', reason: RESIZE_UNSUPPORTED };
  return result;
}
/** Hostname carries the operation marker: CloudBlast has no labels or tags. */
function hostname(name: string, marker: string): string {
  if (!MARKER.test(marker)) return invalid();
  const prefix =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'opfield';
  return `${prefix.slice(0, 63 - marker.length - 1).replace(/-+$/g, '')}-${marker}`;
}
function parseAddress(value: unknown): HostingAddress {
  const object = record(value);
  const ip = normalizeIp(string(object.address));
  return ip ? { ip, network: 'public', direct: true } : unsafe();
}
/**
 * Neither the server list nor its details report a location (only an internal `node_id`), so this is
 * normally empty; Opfield then keeps the location it requested at creation.
 */
function locationOf(object: Json): string {
  const location = optionalRecord(object.location);
  if (location && location.id !== undefined && location.id !== null) return id(location.id);
  return object.location_id === undefined || object.location_id === null ? '' : id(object.location_id);
}
function parseServer(value: unknown): CbServer {
  const object = record(value);
  const serverUuid = uuid(object.uuid);
  const plan = optionalRecord(object.plan);
  const host = optionalString(object.hostname) ?? '';
  const marker = MARKER_SUFFIX.exec(host)?.[1];
  // `name` is the plan label (for example "VMA21"); the hostname is the server's own name.
  const label = marker ? host.slice(0, -(marker.length + 1)) : host;
  return {
    uuid: serverUuid,
    name: label || (optionalString(object.name) ?? serverUuid),
    status: optionalString(object.status),
    cpu: number(object.cpu),
    memoryMb: bytesTo(object.memory, MIB),
    diskGb: bytesTo(object.disk, GIB),
    location: locationOf(object),
    addresses: values(object.ip_addresses).map(parseAddress),
    plan: plan ? { id: id(plan.id), price: planPrice(plan) } : null,
    marker,
  };
}
function parseStatus(value: unknown): CbStatus {
  const object = record(value);
  return {
    state: optionalString(object.state)?.toLowerCase() ?? null,
    task: optionalRecord(object.power_task),
    serverStatus: optionalString(object.server_status),
  };
}
function powerState(status: CbStatus): HostingPowerState {
  if (status.serverStatus === 'deleting') return 'stopping';
  if (status.task?.status === 'pending') {
    const transition = `${optionalString(status.task.action) ?? ''} ${optionalString(status.task.state) ?? ''}`;
    if (/shut|stop|kill|suspend/i.test(transition)) return 'stopping';
    if (/start|boot|reset|resume/i.test(transition)) return 'starting';
  }
  if (status.state === 'running') return 'running';
  if (status.state === 'stopped') return 'stopped';
  return 'unknown';
}
function parseLocation(value: unknown): CbLocation {
  const object = record(value);
  const locationId = id(object.id);
  const code = optionalString(object.short_code) ?? locationId;
  return { id: locationId, label: hostingLocationLabel(code, optionalString(object.description) ?? undefined) };
}
function parsePlan(value: unknown): CbPlan {
  const object = record(value);
  const price = planPrice(object);
  return {
    id: id(object.id),
    name: string(object.name),
    cpu: number(object.cpu) ?? undefined,
    memoryMb: bytesTo(object.memory, MIB) ?? undefined,
    diskGb: bytesTo(object.disk, GIB) ?? undefined,
    architecture: 'x64',
    ...(price ? { price } : {}),
    // Only listed with location_id; stock can run out between catalog refreshes.
    available: object.available !== false,
  };
}
function parseTemplate(value: unknown): HostingCatalogOption {
  const object = record(value);
  const slug = string(object.slug);
  const name = optionalString(object.name) ?? slug;
  // Plain names ("Ubuntu 24.04 LTS", "Debian 12") or plain slugs ("ubuntu-24-04", "debian-12") only;
  // application templates and other distributions stay closed for automatic installation.
  const byName = /^(ubuntu|debian)\s+(\d+(?:\.\d+)?)(?:\s+lts)?$/i.exec(name.trim());
  const bySlug = name === slug ? /^(ubuntu|debian)-(\d+)(?:[.-](\d{2}))?$/i.exec(slug) : null;
  const version = byName ? byName[2]! : bySlug ? (bySlug[3] ? `${bySlug[2]}.${bySlug[3]}` : bySlug[2]!) : null;
  const family = (byName?.[1] ?? bySlug?.[1])?.toLowerCase();
  const operatingSystem =
    family && version && ADMITTED_DISTRIBUTIONS.has(family) ? hostingOsIdentity(family, version) : undefined;
  return {
    id: slug,
    name,
    ...(operatingSystem ? { operatingSystem, architecture: 'x64' as const } : {}),
  };
}
function parseInvoice(value: unknown): HostingInvoice {
  const object = record(value);
  return {
    id: id(object.id),
    status: optionalString(object.status)?.toLowerCase() ?? 'unknown',
    total: amount(object.total),
    date: optionalString(object.created_at),
  };
}
function unsupported(): never {
  throw new AppError(409, 'HOSTING_ACTION_UNSUPPORTED', 'This operation is not available through the CloudBlast API');
}

export class CloudBlastHostingAdapter implements HostingProviderAdapter {
  readonly provider = 'cloudblast' as const;
  readonly firewall: CloudBlastFirewallAdapter;
  private readonly api: CloudBlastApi;
  constructor(
    private readonly connection: HostingConnection,
    http: HostingHttp = new HostingHttpClient(connection)
  ) {
    this.api = new CloudBlastApi(http);
    this.firewall = new CloudBlastFirewallAdapter(this.api, (remoteId) => this.getResource(remoteId));
  }
  snapshots() {
    return new CloudBlastBackupsAdapter(this.api);
  }

  async test(): Promise<HostingAccount> {
    const account = record(await this.api.data('/account'));
    const inventory = record(await this.api.request('/servers', { query: { page: 1 } }));
    if (!Array.isArray(inventory.data)) return unsafe();
    const holder = [optionalString(account.name), optionalString(account.surname)].filter(Boolean).join(' ');
    return {
      // The numeric account ID survives token rotation; never derive ownership from the token.
      authority: `cloudblast:${id(account.id)}`,
      name: optionalString(account.email) ?? (holder || 'CloudBlast'),
      capabilities: capabilities(true, number(account.credit) !== null),
    };
  }

  async catalog(): Promise<HostingCatalog> {
    const locations = await this.api.array('/locations', parseLocation);
    const sizes = new Map<string, HostingCatalogOption & { locations: string[] }>();
    const images = new Map<string, HostingCatalogOption & { locations: string[] }>();
    for (const location of locations) {
      const plans = await this.api.pages('/plans', parsePlan, { location_id: Number(location.id) });
      for (const { available, ...plan } of plans) {
        if (!available) continue;
        const size = sizes.get(plan.id) ?? { ...plan, locations: [], locationPrices: {} };
        size.locations.push(location.id);
        if (plan.price) size.locationPrices![location.id] = plan.price;
        sizes.set(plan.id, size);
      }
      const templates = await this.api.array(`/locations/${encodeURIComponent(location.id)}/templates`, parseTemplate);
      for (const template of templates) {
        const image = images.get(template.id) ?? { ...template, locations: [] };
        image.locations.push(location.id);
        images.set(template.id, image);
      }
    }
    return {
      locations: locations.map((location) => ({ id: location.id, name: location.label })),
      sizes: [...sizes.values()],
      images: [...images.values()],
    };
  }

  private async status(remoteId: string): Promise<CbStatus> {
    return parseStatus(await this.api.data(`${this.api.server(remoteId)}/status`));
  }

  private normalize(server: CbServer, status: CbStatus): HostingResourceSnapshot {
    return {
      remoteId: server.uuid,
      kind: 'vm',
      name: server.name,
      location: server.location,
      powerState:
        server.status === 'installing' || server.status?.startsWith('restoring_') ? 'starting' : powerState(status),
      cpu: server.cpu,
      memoryMb: server.memoryMb,
      diskGb: server.diskGb,
      sizeId: server.plan?.id,
      addresses: server.addresses,
      incarnation: `uuid:${server.uuid}`,
      ...(server.marker ? { marker: server.marker } : {}),
      providerUrl: new URL(
        `${CLOUDBLAST_API_PREFIX}/servers/${encodeURIComponent(server.uuid)}`,
        this.connection.baseUrl
      ).toString(),
      ...(server.plan?.price ? { price: server.plan.price } : {}),
      capabilities: capabilities(false, false),
      observedAt: new Date().toISOString(),
    };
  }

  /** Details carry the plan price; only whitelisted fields are parsed (never the root password). */
  private async server(remoteId: string): Promise<HostingResourceSnapshot> {
    const server = parseServer(await this.api.data(this.api.server(remoteId)));
    if (server.uuid !== remoteId.toLowerCase()) return unsafe();
    return this.normalize(server, await this.status(server.uuid));
  }

  async listResources(): Promise<HostingInventory> {
    const servers = await this.api.pages('/servers', parseServer);
    const resources: HostingResourceSnapshot[] = [];
    for (const server of servers) resources.push(await this.server(server.uuid));
    return { resources, complete: true, observedAt: new Date().toISOString() };
  }

  async getResource(remoteId: string): Promise<HostingResourceSnapshot | null> {
    try {
      return await this.server(input(remoteId));
    } catch (error) {
      if (error instanceof HostingProviderError && !error.outcomeUnknown && error.providerStatus === 404) return null;
      throw error;
    }
  }

  /** Install keys are named by the operation marker, so a lost response never registers a second key. */
  private async installKeys(marker: string): Promise<string[]> {
    const keys = await this.api.array('/ssh-keys', record);
    return keys.filter((key) => key.name === marker).map((key) => id(key.id));
  }

  /**
   * CloudBlast has no user data: register the operation's one-time public key and create the server
   * with it; Opfield then installs over SSH with the matching private key.
   */
  async create(request: HostingCreateRequest): Promise<HostingProviderOperation> {
    const name = hostname(input(request.name), input(request.marker));
    const publicKey = input(request.sshPublicKey);
    let keyId = (await this.installKeys(request.marker))[0];
    if (!keyId) {
      const created = await this.api.request('/ssh-keys', {
        method: 'POST',
        body: { name: request.marker, public_key: publicKey },
      });
      keyId = mutationResponse(() => id(record(record(created).data).id));
    }
    const planId = Number(input(request.size));
    const locationId = Number(input(request.location));
    if (!Number.isSafeInteger(planId) || !Number.isSafeInteger(locationId)) return invalid();
    let payload: unknown;
    try {
      payload = await this.api.request('/servers', {
        method: 'POST',
        body: {
          plan_id: planId,
          location_id: locationId,
          template_slug: input(request.image),
          hostname: name,
          ssh_key_ids: [Number(keyId)],
        },
      });
    } catch (error) {
      // A definite rejection created nothing: do not leave the one-time key registered.
      if (error instanceof HostingProviderError && !error.outcomeUnknown)
        await this.releaseInstallKey(request.marker).catch(() => undefined);
      throw error;
    }
    return mutationResponse(() => ({
      id: null,
      resourceId: parseServer(record(payload).data).uuid,
      status: 'succeeded' as const,
    }));
  }

  /** Idempotent: deletes every account key registered for this operation marker. */
  async releaseInstallKey(marker: string): Promise<{ deleted: number }> {
    if (!MARKER.test(marker)) return invalid();
    const keys = await this.installKeys(marker);
    for (const keyId of keys) {
      try {
        await this.api.request(`/ssh-keys/${encodeURIComponent(keyId)}`, { method: 'DELETE' });
      } catch (error) {
        if (!(error instanceof HostingProviderError) || error.outcomeUnknown || error.providerStatus !== 404)
          throw error;
      }
    }
    return { deleted: keys.length };
  }

  async action(resource: HostingResourceSnapshot, request: HostingActionRequest): Promise<HostingProviderOperation> {
    const resourceId = input(resource.remoteId);
    if (request.action === 'delete') {
      // Without keep_ips CloudBlast keeps only addresses that were already reserved.
      await this.api.request(this.api.server(resourceId), { method: 'DELETE' });
      return { id: null, resourceId, status: 'succeeded' };
    }
    if (request.action === 'resize' || request.action === 'recover') return unsupported();
    const action = POWER_ACTIONS[request.action];
    if (!action) return invalid();
    const payload = await this.api.request(`${this.api.server(resourceId)}/actions`, {
      method: 'POST',
      body: { action },
    });
    return mutationResponse(() => {
      const task = optionalRecord(record(record(payload).data).task);
      if (task?.status === 'failed')
        return { id: null, resourceId, status: 'failed', error: 'CloudBlast rejected the power action' };
      const upid = task ? (optionalString(task.upid) ?? '') : '';
      return { id: `${POWER_PREFIX}${action}:${upid}`, resourceId, status: 'running' };
    });
  }

  /** Power tasks are polled through the real-time status of the same server; never re-sent. */
  async operation(operationId: string, resourceId?: string): Promise<HostingProviderOperation> {
    const match = /^power:(start|shutdown|restart):(.*)$/.exec(operationId);
    if (!match || !resourceId) return invalid();
    const [, action, upid] = match;
    const status = await this.status(resourceId);
    const task = status.task;
    const result = { id: operationId, resourceId };
    if (task) {
      const sameTask = upid ? optionalString(task.upid) === upid : optionalString(task.action) === action;
      if (!sameTask) return { ...result, status: 'unknown' };
      if (task.status === 'pending') return { ...result, status: 'running' };
      if (task.status === 'failed')
        return { ...result, status: 'failed', error: 'CloudBlast reported that the power action failed' };
      return { ...result, status: 'unknown' };
    }
    const expected = action === 'shutdown' ? 'stopped' : 'running';
    return { ...result, status: status.state === expected ? 'succeeded' : 'unknown' };
  }

  async accountSummary(resources: HostingResourceSnapshot[]): Promise<HostingAccountSummary> {
    let balance: HostingMoney | null = null;
    try {
      balance = amount(record(await this.api.data('/account')).credit);
    } catch {
      // Monthly VM prices remain useful when the account endpoint is briefly unavailable.
    }
    return {
      balance,
      monthlyExpenses: monthlyVmExpenses(resources, CLOUDBLAST_CURRENCY),
      observedAt: new Date().toISOString(),
    };
  }

  async finance(cursor?: string): Promise<HostingFinance> {
    const page = cursor === undefined ? 1 : Number(cursor);
    if (!Number.isSafeInteger(page) || page < 1) return invalid();
    const account = record(await this.api.data('/account'));
    const root = record(await this.api.request('/account/invoices', { query: { page } }));
    const meta = record(root.meta);
    const last = number(meta.last_page);
    const result: HostingFinance = {
      balance: amount(account.credit),
      // Account usage reports allocated resources, not money.
      usage: null,
      invoices: values(root.data).map(parseInvoice),
      transactions: [],
      observedAt: new Date().toISOString(),
    };
    if (last !== null && page < last) result.nextCursor = String(page + 1);
    return result;
  }
}
