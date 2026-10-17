import { AppError } from '@/middleware/error-handler.js';
import {
  type HostingHttp,
  HostingHttpClient,
  HostingProviderError,
  type HostingRequestOptions,
} from '../hosting-http.js';
import { hostingOsIdentity } from '../hosting-image-policy.js';
import { hostingLocationLabel } from '../hosting-location.js';
import {
  type HostingAccount,
  type HostingActionRequest,
  type HostingCatalog,
  type HostingCatalogOption,
  type HostingConnection,
  type HostingCreateRequest,
  type HostingInventory,
  type HostingMoney,
  type HostingPowerState,
  type HostingProviderAdapter,
  type HostingProviderOperation,
  type HostingResourceSnapshot,
  hostingCapabilities,
} from '../hosting-provider.types.js';

const PAGE_SIZE = 50;
const MAX_PAGES = 100;
const MARKER_LABEL = 'marker';
// legacy-name: the pre-2.12.1 Hetzner server label — remove once every hosting resource was reconciled by 2.12.1+
const LEGACY_MARKER_LABEL = LEGACY_HOSTING_MARKER_LABEL;
type Json = Record<string, unknown>;
type HAddress = { ip: string; network: string; mac?: string };
type HType = {
  id: string;
  name: string;
  cores: number | null;
  memory: number | null;
  disk: number | null;
  architecture: 'x64' | 'arm64' | undefined;
  availableLocations?: string[];
};
type HServer = {
  id: string;
  name: string;
  status: string;
  created: string | null;
  location: string;
  type: HType | null;
  imageId: string | null;
  addresses: HAddress[];
  labels: Record<string, string>;
};
type HPrice = { location: string; hourly: string | null; monthly: string | null };
type HPricing = { currency: string; types: Map<string, HPrice[]> };
type CatalogOption = HostingCatalogOption & { locationPrices?: Record<string, HostingMoney> };
type HAction = { id: string; status: string; resourceId: string | null; failed: boolean };

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function unsafe(): never {
  throw new HostingProviderError(502, false, 'Provider returned an unsafe response');
}
function mutationResponse<T>(parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    if (error instanceof HostingProviderError) {
      throw new HostingProviderError(error.providerStatus, true, 'Provider returned an invalid mutation response');
    }
    throw new HostingProviderError(502, true, 'Provider returned an invalid mutation response');
  }
}
function invalid(): never {
  throw new HostingProviderError(400, false, 'Invalid provider request');
}
function record(value: unknown): Json {
  return isRecord(value) ? value : unsafe();
}
function optionalRecord(value: unknown): Json | null {
  return value === undefined || value === null ? null : record(value);
}
function string(value: unknown): string {
  return typeof value === 'string' && value.trim() !== '' ? value : unsafe();
}
function optionalString(value: unknown): string | null {
  return value === undefined || value === null ? null : string(value);
}
function id(value: unknown): string {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  return string(value);
}
function input(value: string): string {
  return typeof value === 'string' && value.trim() !== '' ? value : invalid();
}
function text(value: string): string {
  return typeof value === 'string' ? value : invalid();
}
function number(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return unsafe();
}
function values(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : unsafe();
}
function strings(value: unknown): string[] {
  return values(value).map((entry) => string(entry));
}
function architecture(value: unknown): 'x64' | 'arm64' | undefined {
  const normalized = optionalString(value)?.toLowerCase();
  if (normalized === undefined) return undefined;
  if (normalized === 'x86' || normalized === 'x86_64' || normalized === 'x64') return 'x64';
  if (normalized === 'arm' || normalized === 'arm64' || normalized === 'aarch64') return 'arm64';
  return unsafe();
}
function labels(value: unknown): Record<string, string> {
  const object = optionalRecord(value);
  if (!object) return {};
  return Object.fromEntries(Object.entries(object).map(([key, entry]) => [key, string(entry)]));
}
function pageNumber(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  const page =
    typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(page) && page >= 1 ? page : unsafe();
}
function nextPage(root: Json, page: number, pageCount: number): number | null {
  const pagination = optionalRecord(optionalRecord(root.meta)?.pagination);
  if (pagination) {
    const last = pageNumber(pagination.last_page);
    if (Object.hasOwn(pagination, 'next_page')) {
      const next = pageNumber(pagination.next_page);
      if (next === null) return last !== null && page < last ? unsafe() : null;
      return next;
    }
    if (last !== null) return page < last ? page + 1 : null;
  }
  return pageCount === PAGE_SIZE ? page + 1 : null;
}

function parseLocation(value: unknown): HostingCatalogOption {
  const object = record(value);
  // Pricing, image placement and server creation use location names (e.g. fsn1),
  // not the numeric identity exposed by the locations collection.
  const name = string(object.name);
  return {
    id: name,
    name: hostingLocationLabel(
      name,
      optionalString(object.city) ?? undefined,
      optionalString(object.country) ?? undefined
    ),
  };
}
function parseType(value: unknown): HType {
  const object = record(value);
  return {
    id: id(object.id),
    name: string(object.name),
    cores: number(object.cores),
    memory: number(object.memory),
    disk: number(object.disk),
    architecture: architecture(object.architecture),
    ...(object.locations === undefined
      ? {}
      : {
          availableLocations: values(object.locations)
            .map(record)
            .filter((location) => location.available === true)
            .map((location) => string(location.name)),
        }),
  };
}
function parseImage(value: unknown): HostingCatalogOption {
  const object = record(value);
  const result: HostingCatalogOption = { id: id(object.id), name: optionalString(object.name) ?? id(object.id) };
  const imageArchitecture = architecture(object.architecture);
  const imageLocations = strings(object.locations);
  const systemName = /^(ubuntu|debian|fedora)-(\d+(?:\.\d+)?)$/.exec(result.name);
  if (object.type === 'system' && systemName && !object.deprecated && !object.deleted)
    result.operatingSystem = hostingOsIdentity(systemName[1]!, systemName[2]!);
  if (imageArchitecture) result.architecture = imageArchitecture;
  if (imageLocations.length > 0) result.locations = imageLocations;
  return result;
}
function priceValue(value: unknown): string | null {
  const object = optionalRecord(value);
  if (!object) return null;
  return optionalString(object.gross) ?? optionalString(object.net);
}
function parsePricing(value: unknown): HPricing {
  const pricing = record(record(value).pricing);
  const entries = values(pricing.server_types);
  const types = new Map<string, HPrice[]>();
  for (const entry of entries) {
    const object = record(entry);
    const prices: HPrice[] = [];
    for (const price of values(object.prices)) {
      const priceObject = record(price);
      prices.push({
        location: string(priceObject.location),
        hourly: priceValue(priceObject.price_hourly),
        monthly: priceValue(priceObject.price_monthly),
      });
    }
    types.set(id(object.id), prices);
  }
  return { currency: string(pricing.currency), types };
}
function parseAddress(value: unknown, network: string): HAddress {
  const object = record(value);
  const mac = optionalString(object.mac_address);
  return mac ? { ip: string(object.ip), network, mac } : { ip: string(object.ip), network };
}
function publicAddresses(value: unknown): HAddress[] {
  const object = optionalRecord(value);
  if (!object) return [];
  const addresses = [
    ...(object.ipv4 === undefined || object.ipv4 === null ? [] : [parseAddress(object.ipv4, 'public')]),
    ...(object.ipv6 === undefined || object.ipv6 === null ? [] : [parseAddress(object.ipv6, 'public')]),
  ];
  addresses.push(...strings(object.alias_ips).map((ip) => ({ ip, network: 'public-alias' })));
  return addresses;
}
function privateAddresses(value: unknown): HAddress[] {
  const result: HAddress[] = [];
  for (const entry of values(value)) {
    const object = record(entry);
    const networkValue = object.network;
    const network =
      networkValue === undefined || networkValue === null
        ? 'private'
        : typeof networkValue === 'number' && Number.isSafeInteger(networkValue)
          ? `private:${networkValue}`
          : `private:${string(networkValue)}`;
    const main = parseAddress(object, network);
    result.push(main);
    result.push(
      ...strings(object.alias_ips).map((ip) => (main.mac ? { ip, network, mac: main.mac } : { ip, network }))
    );
  }
  return result;
}
function locationOf(object: Json): string {
  const direct = optionalRecord(object.location);
  const datacenter = optionalRecord(object.datacenter);
  const nested = datacenter ? optionalRecord(datacenter.location) : null;
  return (
    optionalString(nested?.name) ??
    optionalString(direct?.name) ??
    optionalString(datacenter?.name) ??
    (nested?.id === undefined || nested.id === null ? null : id(nested.id)) ??
    (direct?.id === undefined || direct.id === null ? null : id(direct.id)) ??
    ''
  );
}
function parseServer(value: unknown): HServer {
  const object = record(value);
  const typeObject = optionalRecord(object.server_type);
  const imageObject = optionalRecord(object.image);
  return {
    id: id(object.id),
    name: string(object.name),
    status: string(object.status),
    created: optionalString(object.created),
    location: locationOf(object),
    type: typeObject ? parseType(typeObject) : null,
    imageId: imageObject ? id(imageObject.id) : null,
    addresses: [...publicAddresses(object.public_net), ...privateAddresses(object.private_net)],
    labels: labels(object.labels),
  };
}
function parseAction(value: unknown): HAction {
  const object = record(value);
  const resourceValues = values(object.resources);
  const first = resourceValues[0];
  const resourceId = first === undefined ? null : id(record(first).id);
  const status = string(object.status).toLowerCase();
  return {
    id: id(object.id),
    status,
    resourceId,
    failed: status === 'error' || (object.error !== undefined && object.error !== null),
  };
}
function actionStatus(action: HAction): HostingProviderOperation['status'] {
  if (action.failed || action.status === 'error') return 'failed';
  if (action.status === 'success') return 'succeeded';
  if (action.status === 'running') return 'running';
  return 'unknown';
}
function operation(action: HAction, resourceId?: string): HostingProviderOperation {
  const result: HostingProviderOperation = { id: action.id, status: actionStatus(action) };
  const resolvedId = resourceId ?? action.resourceId;
  if (resolvedId) result.resourceId = resolvedId;
  if (result.status === 'failed') result.error = 'Provider action failed';
  return result;
}
function powerState(status: string): HostingPowerState {
  if (status === 'running') return 'running';
  if (status === 'off') return 'stopped';
  if (status === 'starting' || status === 'initializing' || status === 'rebuilding') return 'starting';
  if (status === 'stopping' || status === 'deleting') return 'stopping';
  return 'unknown';
}
function normalize(server: HServer, observedAt: string, baseUrl: string): HostingResourceSnapshot {
  const type = server.type;
  return {
    remoteId: server.id,
    kind: 'vm',
    name: server.name,
    location: server.location,
    powerState: powerState(server.status.toLowerCase()),
    cpu: type?.cores ?? null,
    memoryMb: type?.memory === null || type?.memory === undefined ? null : Math.round(type.memory * 1024),
    diskGb: type?.disk ?? null,
    sizeId: type?.id,
    imageId: server.imageId ?? undefined,
    addresses: server.addresses.map((address) => ({
      ip: address.ip,
      mac: address.mac,
      network: address.network,
      direct: true,
    })),
    incarnation: server.created,
    marker: server.labels[MARKER_LABEL] ?? server.labels[LEGACY_MARKER_LABEL],
    providerUrl: new URL(`/v1/servers/${encodeURIComponent(server.id)}`, baseUrl).toString(),
    capabilities: hostingCapabilities({ start: true, shutdown: true, reboot: true, resize: true, delete: true }),
    observedAt,
  };
}
function price(amount: string, currency: string, period: 'hour' | 'month') {
  return { amount, currency, estimated: true, period } as const;
}
function locationPrice(entry: HPrice, currency: string): HostingMoney | null {
  if (entry.monthly !== null) return price(entry.monthly, currency, 'month');
  if (entry.hourly !== null) return price(entry.hourly, currency, 'hour');
  return null;
}
function typeOption(serverType: HType, pricing: HPricing): CatalogOption {
  const prices = (pricing.types.get(serverType.id) ?? []).filter(
    (entry) => serverType.availableLocations === undefined || serverType.availableLocations.includes(entry.location)
  );
  const locationPrices: Record<string, HostingMoney> = {};
  for (const entry of prices) {
    const amount = locationPrice(entry, pricing.currency);
    if (amount) locationPrices[entry.location] = amount;
  }
  const option: CatalogOption = {
    id: serverType.id,
    name: serverType.name,
    locations: prices.map((entry) => entry.location),
    cpu: serverType.cores ?? undefined,
    memoryMb:
      serverType.memory === null || serverType.memory === undefined ? undefined : Math.round(serverType.memory * 1024),
    diskGb: serverType.disk ?? undefined,
    architecture: serverType.architecture,
  };
  const firstLocation = prices[0]?.location;
  if (Object.keys(locationPrices).length > 0) {
    option.locationPrices = locationPrices;
    if (firstLocation && locationPrices[firstLocation]) option.price = locationPrices[firstLocation];
  }
  return option;
}

export class HetznerHostingAdapter implements HostingProviderAdapter {
  snapshots() {
    return new VmSnapshotAdapter(this.connection, this.http);
  }
  readonly provider = 'hetzner' as const;
  /** Server IDs whose marker a read on this instance found only under the legacy label. */
  private readonly legacyLabels = new Set<string>();
  constructor(
    private readonly connection: HostingConnection,
    private readonly http: HostingHttp = new HostingHttpClient(connection)
  ) {}
  private async request<T>(path: string, options: HostingRequestOptions = {}): Promise<T> {
    try {
      return await this.http.request<T>(path, options);
    } catch (error) {
      if (error instanceof HostingProviderError) {
        throw error;
      }
      throw new HostingProviderError(502, (options.method ?? 'GET') !== 'GET', 'Provider request failed');
    }
  }
  private async listPage<T>(path: string, key: string, parse: (value: unknown) => T): Promise<T[]> {
    const result: T[] = [];
    let page = 1;
    for (let count = 0; count < MAX_PAGES; count += 1) {
      const root = record(await this.request<unknown>(path, { query: { page, per_page: PAGE_SIZE } }));
      const pageValues = root[key];
      if (!Array.isArray(pageValues)) return unsafe();
      result.push(...pageValues.map((value) => parse(value)));
      const next = nextPage(root, page, pageValues.length);
      if (next === null) return result;
      if (next <= page) return unsafe();
      page = next;
    }
    throw new HostingProviderError(502, false, 'Provider pagination was incomplete');
  }
  async test(): Promise<HostingAccount> {
    const root = record(await this.request<unknown>('/v1/servers', { query: { page: 1, per_page: 1 } }));
    if (!Array.isArray(root.servers)) return unsafe();
    return {
      authority: 'hetzner-cloud',
      name: 'Hetzner Cloud',
      capabilities: hostingCapabilities({
        create: true,
        start: true,
        shutdown: true,
        reboot: true,
        resize: true,
        delete: true,
      }),
    };
  }
  async catalog(): Promise<HostingCatalog> {
    const locations = await this.listPage('/v1/locations', 'locations', parseLocation);
    const types = await this.listPage('/v1/server_types', 'server_types', parseType);
    const images = await this.listPage('/v1/images', 'images', parseImage);
    const pricing = parsePricing(await this.request<unknown>('/v1/pricing'));
    return {
      locations,
      sizes: types
        .map((serverType) => typeOption(serverType, pricing))
        .filter((option) => option.locations!.length > 0),
      images,
    };
  }
  async listResources(): Promise<HostingInventory> {
    const servers = await this.listPage('/v1/servers', 'servers', parseServer);
    for (const server of servers) this.observeLabels(server);
    const observedAt = new Date().toISOString();
    return {
      resources: servers.map((server) => normalize(server, observedAt, this.connection.baseUrl)),
      complete: true,
      observedAt,
    };
  }
  async getResource(remoteId: string): Promise<HostingResourceSnapshot | null> {
    try {
      const root = record(await this.request<unknown>(`/v1/servers/${encodeURIComponent(input(remoteId))}`));
      const server = parseServer(root.server);
      this.observeLabels(server);
      return normalize(server, new Date().toISOString(), this.connection.baseUrl);
    } catch (error) {
      if (error instanceof HostingProviderError && error.providerStatus === 404) return null;
      throw error;
    }
  }
  private observeLabels(server: HServer) {
    if (server.labels[MARKER_LABEL] === undefined && server.labels[LEGACY_MARKER_LABEL] !== undefined)
      this.legacyLabels.add(server.id);
    else this.legacyLabels.delete(server.id);
  }
  /**
   * Moves a marker an older release wrote under the legacy label key to the current key. Labels only;
   * every other label is sent back unchanged.
   */
  async rewriteLegacyMarker(resource: HostingResourceSnapshot): Promise<boolean> {
    if (!resource.marker || !this.legacyLabels.has(resource.remoteId)) return false;
    this.legacyLabels.delete(resource.remoteId);
    const path = `/v1/servers/${encodeURIComponent(input(resource.remoteId))}`;
    const server = parseServer(record(await this.request<unknown>(path)).server);
    const { [LEGACY_MARKER_LABEL]: legacy, ...labels } = server.labels;
    if (legacy !== resource.marker || labels[MARKER_LABEL] !== undefined) return false;
    await this.request<unknown>(path, { method: 'PUT', body: { labels: { ...labels, [MARKER_LABEL]: legacy } } });
    return true;
  }
  async create(request: HostingCreateRequest): Promise<HostingProviderOperation> {
    const body = {
      name: input(request.name),
      location: input(request.location),
      server_type: input(request.size),
      image: input(request.image),
      user_data: text(request.userData),
      labels: { [MARKER_LABEL]: input(request.marker) },
    };
    const payload = await this.request<unknown>('/v1/servers', { method: 'POST', body });
    return mutationResponse(() => {
      const root = record(payload);
      const server = parseServer(root.server);
      return root.action === undefined || root.action === null
        ? { id: null, resourceId: server.id, status: 'succeeded' }
        : operation(parseAction(root.action), server.id);
    });
  }
  async action(resource: HostingResourceSnapshot, request: HostingActionRequest): Promise<HostingProviderOperation> {
    const resourceId = input(resource.remoteId);
    const encodedId = encodeURIComponent(resourceId);
    if (request.action === 'delete') {
      await this.request<unknown>(`/v1/servers/${encodedId}`, { method: 'DELETE' });
      return { id: null, resourceId, status: 'succeeded' };
    }
    let path: string;
    let body: Record<string, string | number | boolean> | undefined;
    if (request.action === 'start') path = `/v1/servers/${encodedId}/actions/poweron`;
    else if (request.action === 'shutdown') path = `/v1/servers/${encodedId}/actions/shutdown`;
    else if (request.action === 'reboot') path = `/v1/servers/${encodedId}/actions/reboot`;
    else if (request.action === 'resize') {
      path = `/v1/servers/${encodedId}/actions/change_type`;
      const type = input(request.size ?? resource.sizeId ?? '');
      body = {
        server_type: /^\d+$/.test(type) && Number.isSafeInteger(Number(type)) ? Number(type) : type,
        upgrade_disk: request.diskGb === undefined || resource.diskGb === null || request.diskGb > resource.diskGb,
      };
    } else return invalid();
    let payload: unknown;
    try {
      payload = await this.request<unknown>(path, { method: 'POST', ...(body === undefined ? {} : { body }) });
    } catch (error) {
      if (
        request.action === 'resize' &&
        error instanceof HostingProviderError &&
        !error.outcomeUnknown &&
        [400, 401, 403, 404, 405, 413, 415, 422, 429].includes(error.providerStatus)
      )
        throw new AppError(409, 'HOSTING_RESIZE_REJECTED', error.message);
      throw error;
    }
    return mutationResponse(() => operation(parseAction(record(payload).action), resourceId));
  }
  async operation(idValue: string, resourceId?: string): Promise<HostingProviderOperation> {
    const root = record(await this.request<unknown>(`/v1/actions/${encodeURIComponent(input(idValue))}`));
    return operation(parseAction(root.action), resourceId);
  }
}

import { LEGACY_HOSTING_MARKER_LABEL } from '@/lib/legacy-compat.js';
import { VmSnapshotAdapter } from './vm-snapshots.js';
