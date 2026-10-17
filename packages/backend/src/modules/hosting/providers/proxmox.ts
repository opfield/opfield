import { X509Certificate } from 'node:crypto';
import { isAlwaysBlockedOutboundIp, normalizeIp } from '@/lib/ip-cidr.js';
import { AppError } from '@/middleware/error-handler.js';
import {
  type HostingHttp,
  HostingHttpClient,
  HostingProviderError,
  type HostingRequestOptions,
} from '../hosting-http.js';
import {
  HOSTING_CLOUD_IMAGES,
  type HostingCloudImage,
  hostingCloudImage,
  hostingImageFilename,
  legacyHostingImageFilename,
} from '../hosting-images.js';
import {
  type HostingAccount,
  type HostingActionRequest,
  type HostingAddress,
  type HostingCatalog,
  type HostingConnection,
  type HostingCreateRequest,
  type HostingInventory,
  type HostingProviderAdapter,
  type HostingProviderOperation,
  type HostingProxmoxDiscovery,
  type HostingResourceSnapshot,
  hostingCapabilities,
} from '../hosting-provider.types.js';
import { assertProxmoxSeedRuntime, buildProxmoxSeed } from '../proxmox-seed.js';
import { ProxmoxFirewallAdapter } from './proxmox-firewall.js';

interface PveResource {
  id: string;
  vmid?: number;
  node: string;
  type: string;
  name?: string;
  status?: string;
  template?: number;
  maxcpu?: number;
  maxmem?: number;
  mem?: number;
  maxdisk?: number;
  disk?: number;
}
type PveConfig = Record<string, string | number | undefined>;

const DESCRIPTION_MARKER = /Opfield hosting (gw-[a-zA-Z0-9-]+)/;
// legacy-name: the pre-2.12.1 Proxmox VM description — remove once every hosting resource was reconciled by 2.12.1+
const LEGACY_DESCRIPTION_MARKER = /Gateway hosting (gw-[a-zA-Z0-9-]+)/;
function description(marker: string): string {
  return `Opfield hosting ${marker}`;
}
/** Per-operation bootstrap media, current name first. */
function seedFilenames(marker: string): string[] {
  return [
    `opfield-seed-${marker}.iso`,
    // legacy-name: Proxmox seed ISO "gateway-seed-<marker>.iso" — remove once no create operation started before 2.12.1 is still preparing
    `gateway-seed-${marker}.iso`,
  ];
}
/** Per-operation image imports, current name first. */
function imageFilenames(image: HostingCloudImage, marker: string): string[] {
  return [hostingImageFilename(image), legacyHostingImageFilename(image)].map((name) =>
    name.replace('.qcow2', `-${marker}.qcow2`)
  );
}
interface PveInterface {
  name?: string;
  'hardware-address'?: string;
  'ip-addresses'?: Array<{ 'ip-address': string }>;
}
interface CtInterface {
  name: string;
  hwaddr?: string;
  inet?: string;
  inet6?: string;
}
interface PveCertificate {
  filename?: string;
  fingerprint?: string;
  issuer?: string;
  pem?: string;
  subject?: string;
}
interface PveStorage {
  storage?: string;
  content?: string;
  active?: number;
}
interface PveNetwork {
  iface?: string;
  type?: string;
  active?: number;
}
const part = encodeURIComponent;
const mb = (value: number | undefined) => (value === undefined ? null : Math.round(value / 1024 ** 2));
const gb = (value: number | undefined) => (value === undefined ? null : Math.round(value / 1024 ** 3));

function configValue(value: string | number | undefined, key: string): string | undefined {
  return String(value ?? '')
    .split(',')
    .find((entry) => entry.startsWith(`${key}=`))
    ?.slice(key.length + 1);
}
function guestEnabled(config: PveConfig): boolean {
  return config.agent === 1 || config.agent === '1' || configValue(config.agent, 'enabled') === '1';
}
function isImportedBootDisk(value: PveConfig[string], storage: string, vmid: number | undefined): boolean {
  const volume = String(value ?? '').split(',')[0]!;
  if (!Number.isSafeInteger(vmid) || !volume.startsWith(`${storage}:`)) return false;
  // Proxmox allocates imported images as vm-<owner>-disk-N on block storage,
  // or <owner>/vm-<owner>-disk-N.<format> on directory storage.
  return new RegExp(`^(?:${vmid}/)?vm-${vmid}-disk-\\d+(?:\\.(?:raw|qcow2|vmdk))?$`).test(
    volume.slice(storage.length + 1)
  );
}
function diskKey(config: PveConfig): string | undefined {
  const disks = Object.keys(config).filter(
    (key) =>
      /^(scsi|virtio|sata|ide)\d+$/.test(key) &&
      !String(config[key]).includes('cloudinit') &&
      !String(config[key]).includes('media=cdrom')
  );
  const boot = configValue(config.boot, 'order')
    ?.split(';')
    .find((key) => disks.includes(key));
  if (boot) return boot;
  if (typeof config.bootdisk === 'string' && disks.includes(config.bootdisk)) return config.bootdisk;
  return disks.length === 1 ? disks[0] : undefined;
}
function templateReadiness(config: PveConfig): string | undefined {
  if (Number(config.template) !== 1) return 'This VM is not marked as a Proxmox template';
  if (config.ostype !== 'l26') return 'Template must use a Linux guest OS type';
  if (!guestEnabled(config)) return 'Enable QEMU Guest Agent in the template';
  if (!diskKey(config)) return 'Template needs one unambiguous boot disk';
  if (!String(config.net0 ?? '').startsWith('virtio=')) return 'Template net0 must use a virtio adapter';
  if (!Object.values(config).some((value) => String(value).includes('cloudinit')))
    return 'Add a cloud-init drive before provisioning';
  return undefined;
}

function rootFingerprint(value: string | undefined): string | undefined {
  const normalized = value?.replaceAll(':', '').toLowerCase();
  return normalized && /^[a-f0-9]{64}$/.test(normalized) ? normalized : undefined;
}

export class ProxmoxHostingAdapter implements HostingProviderAdapter {
  snapshots() {
    return new VmSnapshotAdapter(this.connection, this.http);
  }
  readonly provider = 'proxmox' as const;
  readonly firewall: ProxmoxFirewallAdapter;
  private discoveredIdentity?: { host: string; authority: string; clusterName: string };
  /** `kind:vmid` of VMs whose description a read on this instance found in the legacy form. */
  private readonly legacyDescriptions = new Set<string>();
  constructor(
    private readonly connection: HostingConnection,
    private readonly http: HostingHttp = new HostingHttpClient(connection)
  ) {
    this.firewall = new ProxmoxFirewallAdapter({
      request: this.request.bind(this),
      getResource: this.getResource.bind(this),
    });
  }

  private async request<T>(path: string, options?: HostingRequestOptions): Promise<T> {
    const result = await this.http.request<{ data: T }>(`/api2/json${path}`, options);
    if (!result || !('data' in result))
      throw new HostingProviderError(
        502,
        options?.method !== undefined && options.method !== 'GET',
        'Proxmox returned an invalid response'
      );
    return result.data;
  }

  private capabilities(kind: 'vm' | 'ct', qga: boolean) {
    return hostingCapabilities({
      create: kind === 'vm',
      start: true,
      shutdown: true,
      reboot: true,
      resize: true,
      delete: true,
      bootstrap: qga,
      recover: qga,
      guestIdentity: qga,
    });
  }

  private async resourceCapabilities(kind: 'vm' | 'ct', qga: boolean, vmid: number) {
    const capabilities = this.capabilities(kind, qga);
    const path = `/vms/${vmid}`;
    const permissions = await this.request<Record<string, Record<string, number>>>('/access/permissions', {
      query: { path },
    });
    const granted = permissions[path] ?? {};
    // Values indicate propagation, not whether the privilege is granted. A zero is still a grant.
    const has = (privilege: string) => Object.hasOwn(granted, privilege);
    const require = (action: keyof typeof capabilities, allowed: boolean, privilege: string) => {
      if (capabilities[action].available && !allowed)
        capabilities[action] = {
          available: false,
          reason: `Provider token lacks ${privilege} on ${path}`,
          reasonCode: 'permission_denied',
        };
    };
    for (const action of ['start', 'shutdown', 'reboot'] as const) require(action, has('VM.PowerMgmt'), 'VM.PowerMgmt');
    require('delete', has('VM.Allocate'), 'VM.Allocate');
    require('resize', ['VM.Config.CPU', 'VM.Config.Memory', 'VM.Config.Disk'].every(
      has
    ), 'VM.Config.CPU, VM.Config.Memory and VM.Config.Disk');
    // Older supported PVE releases used VM.Monitor for these QGA endpoints.
    const exec = has('VM.GuestAgent.Unrestricted') || has('VM.Monitor');
    require('bootstrap', exec, 'VM.GuestAgent.Unrestricted');
    require('recover', exec, 'VM.GuestAgent.Unrestricted');
    require('guestIdentity', exec || has('VM.GuestAgent.FileRead'), 'VM.GuestAgent.FileRead');
    if (kind === 'vm' && !qga) {
      for (const action of ['bootstrap', 'recover', 'guestIdentity'] as const)
        capabilities[action] = {
          available: false,
          reason: 'Waiting for QEMU Guest Agent to become reachable',
          reasonCode: 'temporarily_unavailable',
        };
    }
    capabilities.create = { available: false, reason: 'Provisioning is an account action, not a resource action' };
    return capabilities;
  }

  private async clusterIdentity(host: string): Promise<{ authority: string; clusterName: string }> {
    if (this.discoveredIdentity?.host === host) return this.discoveredIdentity;
    let certificates: PveCertificate[];
    try {
      certificates = await this.request<PveCertificate[]>(`/nodes/${part(host)}/certificates/info`);
    } catch (error) {
      if (error instanceof HostingProviderError || error instanceof AppError)
        throw new AppError(
          403,
          'HOSTING_CLUSTER_DISCOVERY_FAILED',
          'Cannot read the Proxmox internal node certificate. Check TLS trust and token audit access.'
        );
      throw error;
    }
    const leaf = certificates.find((entry) => entry.filename === 'pve-ssl.pem');
    const root = certificates.find((entry) => entry.filename === 'pve-root-ca.pem');
    const fingerprint = rootFingerprint(root?.fingerprint);
    if (!leaf?.pem || !root?.pem || !fingerprint)
      throw new AppError(
        409,
        'HOSTING_CLUSTER_DISCOVERY_FAILED',
        'Proxmox did not expose its internal cluster CA and pve-ssl.pem evidence; a stable cluster identity cannot be verified.'
      );
    let rootCertificate: X509Certificate;
    let leafCertificate: X509Certificate;
    try {
      rootCertificate = new X509Certificate(root.pem);
      leafCertificate = new X509Certificate(leaf.pem);
    } catch {
      throw new AppError(
        409,
        'HOSTING_CLUSTER_DISCOVERY_FAILED',
        'Proxmox returned invalid internal certificate material; a stable cluster identity cannot be verified.'
      );
    }
    if (
      !rootCertificate.ca ||
      leafCertificate.ca ||
      rootFingerprint(rootCertificate.fingerprint256) !== fingerprint ||
      !leafCertificate.verify(rootCertificate.publicKey)
    )
      throw new AppError(
        409,
        'HOSTING_CLUSTER_DISCOVERY_FAILED',
        'Proxmox internal pve-ssl.pem is not verified by the reported cluster CA.'
      );
    // pveproxy/public certificates are intentionally excluded: only pve-root-ca.pem and its pve-ssl.pem leaf establish authority.
    const identity = {
      host,
      authority: `proxmox:ca:${fingerprint}`,
      clusterName: root.subject ?? leaf.issuer ?? fingerprint,
    };
    this.discoveredIdentity = identity;
    return identity;
  }

  async discover(): Promise<HostingProxmoxDiscovery> {
    await this.request<{ version: string }>('/version');
    const resources = await this.request<PveResource[]>('/cluster/resources');
    const hosts = resources
      .filter((resource) => resource.type === 'node' && !!resource.node)
      .map((resource) => ({ id: resource.node, name: resource.node }))
      .filter((host, index, all) => all.findIndex((candidate) => candidate.id === host.id) === index)
      .sort((left, right) => left.name.localeCompare(right.name));
    const selectedHost =
      this.connection.settings.proxmoxHost ?? this.connection.settings.proxmox?.nodes[0] ?? hosts[0]?.id;
    if (!selectedHost)
      throw new AppError(
        409,
        'HOSTING_CLUSTER_DISCOVERY_FAILED',
        'Proxmox did not report a discoverable physical host'
      );
    const identity = await this.clusterIdentity(selectedHost);
    const templates: HostingProxmoxDiscovery['templates'] = [];
    for (const resource of resources) {
      if (resource.type !== 'qemu' || resource.template !== 1 || !resource.vmid) continue;
      let reason: string | undefined;
      try {
        const config = await this.request<PveConfig>(`/nodes/${part(resource.node)}/qemu/${resource.vmid}/config`);
        reason = templateReadiness(config);
      } catch (error) {
        if (!(error instanceof HostingProviderError)) throw error;
        reason = 'Cannot inspect this template configuration with the current Proxmox token';
      }
      templates.push({
        id: String(resource.vmid),
        name: resource.name ?? String(resource.vmid),
        host: resource.node,
        ready: !reason,
        reason,
        diskGb: gb(resource.maxdisk) ?? undefined,
      });
    }
    const hostDetails = await Promise.allSettled(
      hosts.map(async (host) => {
        const [storageRows, networkRows] = await Promise.all([
          this.request<PveStorage[]>(`/nodes/${part(host.id)}/storage`),
          this.request<PveNetwork[]>(`/nodes/${part(host.id)}/network`),
        ]);
        return { host, storageRows, networkRows };
      })
    );
    const details = hostDetails.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
    const storages = details.flatMap(({ host, storageRows }) =>
      storageRows
        .filter((storage) => storage.storage && storage.active !== 0)
        .map((storage) => ({
          id: storage.storage!,
          name: storage.storage!,
          host: host.id,
          content: (storage.content ?? '').split(','),
        }))
    );
    const bridges = details.flatMap(({ host, networkRows }) =>
      networkRows
        .filter((network) => network.iface && network.type === 'bridge' && network.active !== 0)
        .map((network) => ({ id: network.iface!, name: network.iface!, host: host.id }))
    );
    const usedIps = new Set<string>();
    if (this.connection.settings.proxmox?.network === 'static') {
      for (const resource of resources) {
        if (!resource.vmid || resource.template || !['qemu', 'lxc'].includes(resource.type)) continue;
        const config = await this.request<PveConfig>(
          `/nodes/${part(resource.node)}/${resource.type}/${resource.vmid}/config`
        );
        for (const [key, value] of Object.entries(config)) {
          if (!/^ipconfig\d+$/.test(key) && !/^net\d+$/.test(key)) continue;
          const ip = normalizeIp(configValue(value, 'ip')?.split('/')[0]);
          if (ip) usedIps.add(ip);
        }
      }
    }
    return {
      hosts,
      templates: templates.sort((left, right) => left.name.localeCompare(right.name)),
      storages,
      bridges,
      clusterName: identity.clusterName,
      usedVmids: resources
        .filter((resource) => ['qemu', 'lxc'].includes(resource.type) && Number.isInteger(resource.vmid))
        .map((resource) => resource.vmid!)
        .sort((left, right) => left - right),
      usedIps: [...usedIps].sort(),
    };
  }

  async test(): Promise<HostingAccount> {
    const discovery = await this.discover();
    const identityHost =
      this.connection.settings.proxmoxHost ?? this.connection.settings.proxmox?.nodes[0] ?? discovery.hosts[0]?.id;
    if (!identityHost) throw new AppError(409, 'HOSTING_CLUSTER_DISCOVERY_FAILED', 'Select a Proxmox physical host');
    const identity = await this.clusterIdentity(identityHost);
    const capabilities = this.capabilities('vm', false);
    if (!this.connection.settings.proxmox?.imageStorage && !this.connection.settings.proxmox?.cleanTemplate)
      capabilities.create = {
        available: false,
        reason: 'Select and verify a clean cloud-init template with QEMU Guest Agent',
      };
    return { authority: identity.authority, name: discovery.clusterName ?? identity.clusterName, capabilities };
  }

  async catalog(): Promise<HostingCatalog> {
    const all = await this.request<PveResource[]>('/cluster/resources');
    const settings = this.connection.settings.proxmox;
    const selectedHost = this.connection.settings.proxmoxHost ?? settings?.nodes[0];
    const hosts = all.filter((r) => r.type === 'node' && (!selectedHost || r.node === selectedHost));
    const templates = all.filter(
      (r) =>
        r.type === 'qemu' &&
        r.template === 1 &&
        settings &&
        r.vmid === settings.templateId &&
        r.node === settings.templateNode
    );
    const images: HostingCatalog['images'] =
      settings?.imageStorage && settings.seedStorage
        ? HOSTING_CLOUD_IMAGES.map(({ id, name, architecture, operatingSystem, diskGb, supportedRoles }) => ({
            id,
            name,
            architecture,
            operatingSystem,
            diskGb,
            supportedRoles,
            locations: hosts.map((host) => host.node),
          }))
        : [];
    for (const template of templates) {
      const config = await this.request<PveConfig>(`/nodes/${part(template.node)}/qemu/${template.vmid}/config`);
      if (templateReadiness(config)) continue;
      images.push({
        id: String(template.vmid),
        name: template.name ?? String(template.vmid),
        locations: hosts.map((host) => host.node),
        diskGb: gb(template.maxdisk) ?? undefined,
      });
    }
    const capacity: NonNullable<HostingCatalog['capacity']> = [];
    for (const host of hosts) {
      const storage =
        settings && host.status === 'online'
          ? await this.request<{ total?: number; used?: number; active?: number }>(
              `/nodes/${part(host.node)}/storage/${part(settings.storage)}/status`
            )
          : undefined;
      capacity.push({
        id: host.node,
        name: settings ? `${host.node} · ${settings.storage}` : host.node,
        online: host.status === 'online' && (!settings || storage?.active === 1),
        memoryTotalMb: mb(host.maxmem),
        memoryUsedMb: mb(host.mem),
        diskTotalGb: gb(storage?.total),
        diskUsedGb: gb(storage?.used),
      });
    }
    return {
      locations: hosts.map((r) => ({ id: r.node, name: r.node })),
      sizes: [{ id: 'custom', name: 'Custom resources' }],
      images,
      capacity,
    };
  }

  private base(resource: Pick<HostingResourceSnapshot, 'kind' | 'location' | 'remoteId'>) {
    return `/nodes/${part(resource.location)}/${resource.kind === 'ct' ? 'lxc' : 'qemu'}/${part(resource.remoteId)}`;
  }

  private async snapshot(row: PveResource): Promise<HostingResourceSnapshot> {
    if (!row.vmid || !['qemu', 'lxc'].includes(row.type))
      throw new HostingProviderError(502, false, 'Invalid Proxmox resource identity');
    const kind = row.type === 'lxc' ? 'ct' : 'vm';
    const base = `/nodes/${part(row.node)}/${row.type}/${row.vmid}`;
    const config = await this.request<PveConfig>(`${base}/config`);
    const addresses: HostingAddress[] = [];
    const macNetworks = new Map<string, string>();
    for (const [key, value] of Object.entries(config)) {
      if (!/^net\d+$/.test(key)) continue;
      const mac =
        kind === 'ct'
          ? configValue(value, 'hwaddr')
          : String(value ?? '')
              .split(',')[0]
              ?.split('=')[1];
      const network = configValue(value, 'bridge');
      if (mac && network) macNetworks.set(mac.toLowerCase(), network);
      for (const field of ['ip', 'ip6']) {
        const ip = normalizeIp(configValue(value, field)?.split('/')[0]);
        if (ip && !isAlwaysBlockedOutboundIp(ip)) addresses.push({ ip, mac, network, direct: true });
      }
    }
    const qga = kind === 'vm' && guestEnabled(config);
    let guestReachable = false;
    if (row.status === 'running') {
      try {
        if (kind === 'ct') {
          const interfaces = await this.request<CtInterface[]>(`${base}/interfaces`);
          for (const iface of interfaces)
            for (const address of [iface.inet, iface.inet6]) {
              const ip = normalizeIp(address?.split('/')[0]);
              if (ip && !isAlwaysBlockedOutboundIp(ip))
                addresses.push({
                  ip,
                  mac: iface.hwaddr,
                  network: macNetworks.get(iface.hwaddr?.toLowerCase() ?? ''),
                  direct: true,
                });
            }
        } else if (qga) {
          const data = await this.request<{ result: PveInterface[] }>(`${base}/agent/network-get-interfaces`);
          guestReachable = true;
          for (const iface of data.result ?? [])
            for (const address of iface['ip-addresses'] ?? []) {
              const ip = normalizeIp(address['ip-address']);
              const mac = iface['hardware-address'];
              if (ip && !isAlwaysBlockedOutboundIp(ip))
                addresses.push({ ip, mac, network: macNetworks.get(mac?.toLowerCase() ?? ''), direct: true });
            }
        }
      } catch (error) {
        // Unavailable guest evidence must not remove an otherwise visible VM.
        if (!(error instanceof HostingProviderError)) throw error;
      }
    }
    const smbiosUuid = configValue(config.smbios1, 'uuid');
    const ctime = configValue(config.meta, 'ctime');
    const rootDisk = config.rootfs ?? config[diskKey(config) ?? ''];
    const mac = [...macNetworks.keys()].sort().join(',');
    const incarnation = smbiosUuid
      ? `smbios:${smbiosUuid}`
      : ctime
        ? `ctime:${ctime}`
        : rootDisk && mac
          ? `disk:${String(rootDisk).split(',')[0]}:mac:${mac}`
          : null;
    const description = String(config.description ?? '');
    const current = DESCRIPTION_MARKER.exec(description)?.[1];
    const legacy = current ? undefined : LEGACY_DESCRIPTION_MARKER.exec(description)?.[1];
    const marker = current ?? legacy;
    if (legacy) this.legacyDescriptions.add(`${kind}:${row.vmid}`);
    else this.legacyDescriptions.delete(`${kind}:${row.vmid}`);
    return {
      remoteId: String(row.vmid),
      kind,
      name: row.name ?? String(row.vmid),
      location: row.node,
      powerState: row.status === 'running' ? 'running' : row.status === 'stopped' ? 'stopped' : 'unknown',
      cpu: (row.maxcpu ?? Number(config.cores)) || null,
      memoryMb: mb(row.maxmem),
      diskGb: gb(row.maxdisk),
      sizeId: 'custom',
      imageId: undefined,
      addresses: addresses.filter(
        (address, index) =>
          addresses.findIndex((entry) => entry.ip === address.ip && entry.mac === address.mac) === index
      ),
      incarnation,
      marker,
      providerUrl: `${this.connection.baseUrl}/#v1:0:=${row.type}%2F${row.vmid}`,
      capabilities: await this.resourceCapabilities(kind, qga && guestReachable, row.vmid),
      observedAt: new Date().toISOString(),
    };
  }

  async listResources(): Promise<HostingInventory> {
    const rows = await this.request<PveResource[]>('/cluster/resources', { query: { type: 'vm' } });
    const resources: HostingResourceSnapshot[] = [];
    for (const row of rows) {
      if (row.template || !['qemu', 'lxc'].includes(row.type)) continue;
      const selectedHost = this.connection.settings.proxmoxHost ?? this.connection.settings.proxmox?.nodes[0];
      if (selectedHost && row.node !== selectedHost) continue;
      resources.push(await this.snapshot(row));
    }
    return { resources, complete: true, observedAt: new Date().toISOString() };
  }

  async getResource(remoteId: string): Promise<HostingResourceSnapshot | null> {
    const rows = await this.request<PveResource[]>('/cluster/resources', { query: { type: 'vm' } });
    const row = rows.find((r) => String(r.vmid) === remoteId && !r.template && ['qemu', 'lxc'].includes(r.type));
    return row ? this.snapshot(row) : null;
  }

  private task(upid: string, resourceId: string): HostingProviderOperation {
    if (typeof upid !== 'string' || !upid.startsWith('UPID:')) return { id: null, resourceId, status: 'unknown' };
    return { id: upid, resourceId, status: 'running' };
  }

  async create(input: HostingCreateRequest): Promise<HostingProviderOperation> {
    const settings = input.proxmox;
    if (settings?.imageStorage && settings.seedStorage) {
      hostingCloudImage(input.image, input.role);
      if (
        !settings.nodes.includes(input.location) ||
        !Number.isInteger(input.vmid) ||
        !/^gw-[a-f0-9-]{36}$/.test(input.marker)
      )
        throw new AppError(400, 'HOSTING_PROFILE_INVALID', 'Choose the configured Proxmox host and VMID pool');
      await this.validateImagePlacement(input);
      const confirmed = await this.request<string>('/cluster/nextid', { query: { vmid: input.vmid } });
      if (String(confirmed) !== String(input.vmid))
        throw new AppError(409, 'HOSTING_VMID_IN_USE', 'The accepted Proxmox VMID is now in use');
      // Record a VM identity before any lengthy image operation. Uncertain creation is reconciled by marker.
      return this.task(
        await this.request<string>(`/nodes/${part(input.location)}/qemu`, {
          method: 'POST',
          body: {
            vmid: input.vmid,
            name: input.name,
            pool: settings.pool,
            description: description(input.marker),
            ostype: 'l26',
            smbios1: `uuid=${input.marker.slice(3)}`,
            cores: input.cpu,
            memory: input.memoryMb,
            scsihw: 'virtio-scsi-pci',
            net0: [
              'virtio',
              `bridge=${settings.bridge}`,
              ...(settings.vlan ? [`tag=${settings.vlan}`] : []),
              ...(settings.mtu ? [`mtu=${settings.mtu}`] : []),
              'firewall=1',
            ].join(','),
            serial0: 'socket',
            vga: 'serial0',
            agent: 'enabled=1',
          },
        }),
        String(input.vmid)
      );
    }
    if (
      !settings?.cleanTemplate ||
      !settings.nodes.includes(input.location) ||
      input.image !== String(settings.templateId) ||
      !Number.isInteger(input.vmid)
    ) {
      throw new AppError(
        400,
        'HOSTING_TEMPLATE_NOT_READY',
        'Select the configured clean Proxmox template and allowed host'
      );
    }
    const config = await this.request<PveConfig>(
      `/nodes/${part(settings.templateNode!)}/qemu/${settings.templateId}/config`
    );
    if (templateReadiness(config)) {
      throw new AppError(400, 'HOSTING_TEMPLATE_NOT_READY', 'Template requires cloud-init and QEMU Guest Agent');
    }
    let vmid: string;
    try {
      vmid = await this.request<string>('/cluster/nextid', { query: { vmid: input.vmid } });
    } catch (error) {
      if (error instanceof HostingProviderError && error.providerStatus === 400)
        throw new AppError(409, 'HOSTING_VMID_IN_USE', 'The accepted Proxmox VMID is now in use; no clone was created');
      throw error;
    }
    if (String(vmid) !== String(input.vmid))
      throw new HostingProviderError(502, false, 'Proxmox did not confirm the reserved VM ID');
    const upid = await this.request<string>(
      `/nodes/${part(settings.templateNode!)}/qemu/${settings.templateId}/clone`,
      {
        method: 'POST',
        body: {
          newid: Number(vmid),
          name: input.name,
          full: 1,
          target: input.location,
          storage: settings.storage,
          pool: settings.pool,
          description: description(input.marker),
        },
      }
    );
    return this.task(upid, String(vmid));
  }

  async validateCreate(input: HostingCreateRequest) {
    if (input.proxmox?.imageStorage && input.proxmox.seedStorage) {
      await assertProxmoxSeedRuntime();
      await this.validateImagePlacement(input);
    }
  }

  private async validateImagePlacement(input: HostingCreateRequest) {
    const profile = input.proxmox!;
    const storages = await this.request<PveStorage[]>(`/nodes/${part(input.location)}/storage`);
    const permissions = await this.request<Record<string, Record<string, number>>>('/access/permissions');
    const require = (path: string, privilege: string) => {
      if (!Object.hasOwn(permissions[path] ?? {}, privilege))
        throw new AppError(
          403,
          'HOSTING_PROVIDER_PERMISSION_REQUIRED',
          `Proxmox token needs ${privilege} on ${path}; no VM was created`
        );
    };
    for (const [storage, content] of [
      [profile.storage, 'images'],
      [profile.imageStorage!, 'import'],
      [profile.seedStorage!, 'iso'],
    ]) {
      if (
        !storages.some(
          (item) => item.storage === storage && item.active !== 0 && item.content?.split(',').includes(content!)
        )
      )
        throw new AppError(
          409,
          'HOSTING_STORAGE_UNAVAILABLE',
          `Storage ${storage} must be active and support ${content} content on the selected host`
        );
      require(`/storage/${storage}`, content === 'images' ? 'Datastore.AllocateSpace' : 'Datastore.AllocateTemplate');
      if (content !== 'images') require(`/storage/${storage}`, 'Datastore.Allocate');
    }
    const root = permissions['/'] ?? {};
    require(`/storage/${profile.seedStorage}`, 'Datastore.Allocate');
    if (!(Object.hasOwn(root, 'Sys.Audit') && Object.hasOwn(root, 'Sys.Modify')))
      require(`/nodes/${input.location}`, 'Sys.AccessNetwork');
    for (const privilege of [
      'VM.Allocate',
      'VM.Config.CPU',
      'VM.Config.Memory',
      'VM.Config.Disk',
      'VM.Config.Network',
      'VM.Config.Options',
      'VM.Config.CDROM',
      'VM.PowerMgmt',
    ])
      if (!profile.pool || !Object.hasOwn(permissions[`/pool/${profile.pool}`] ?? {}, privilege))
        require(`/vms/${input.vmid}`, privilege);
  }

  async prepare(resource: HostingResourceSnapshot, input: HostingCreateRequest): Promise<HostingProviderOperation> {
    const settings = input.proxmox;
    if (settings?.imageStorage && settings.seedStorage) return this.prepareImage(resource, input);
    if (!settings || resource.kind !== 'vm')
      throw new AppError(400, 'HOSTING_TEMPLATE_NOT_READY', 'Proxmox VM placement is not configured');
    const base = this.base(resource);
    if (resource.powerState === 'running') {
      if (
        resource.cpu !== (input.cpu ?? 2) ||
        resource.memoryMb !== (input.memoryMb ?? 2048) ||
        (input.diskGb !== undefined && resource.diskGb !== input.diskGb)
      ) {
        throw new AppError(
          409,
          'HOSTING_VM_MUST_STOP',
          'The running VM does not match the requested resources; shut it down before configuring'
        );
      }
      return { id: null, resourceId: resource.remoteId, status: 'succeeded' };
    }
    const config = await this.request<PveConfig>(`${base}/config`);
    const disk = diskKey(config);
    if (input.diskGb && !disk)
      throw new AppError(400, 'HOSTING_DISK_UNKNOWN', 'Cannot unambiguously identify the template boot disk');
    if (input.diskGb && resource.diskGb !== null && input.diskGb < resource.diskGb)
      throw new AppError(400, 'HOSTING_DISK_SHRINK_UNSUPPORTED', 'Cannot shrink the template disk');
    const mac = String(config.net0 ?? '').split(',')[0];
    if (!mac.startsWith('virtio='))
      throw new AppError(400, 'HOSTING_TEMPLATE_NOT_READY', 'Template net0 must use a virtio network device');
    const net0 = [
      ...String(config.net0)
        .split(',')
        .filter((value) => !['bridge', 'tag', 'mtu', 'firewall'].some((key) => value.startsWith(`${key}=`))),
      `bridge=${settings.bridge}`,
      ...(settings.vlan === undefined ? [] : settings.vlan === null ? [] : [`tag=${settings.vlan}`]),
      ...(settings.mtu === undefined ? [] : [`mtu=${settings.mtu}`]),
      'firewall=1',
    ].join(',');
    if (!['firewall', 'network'].includes(input.preparationStage ?? '')) {
      await input.beforePreparation?.('firewall');
      await this.disableInitialFirewall(resource);
      return this.completedPreparation(resource, 'firewall');
    }
    await this.assertInitialFirewallOff(resource);
    if (input.preparationStage === 'firewall') {
      await input.beforePreparation?.('network');
      await this.request<null>(`${base}/config`, {
        method: 'PUT',
        body: {
          cores: input.cpu ?? settings.defaultCpu ?? 2,
          memory: input.memoryMb ?? settings.defaultMemoryMb ?? 2048,
          ...Object.fromEntries(
            Object.entries(config)
              .filter(([key]) => /^net\d+$/.test(key) && key !== 'net0')
              .map(([key, value]) => [key, this.firewallNic(value)])
          ),
          net0,
          ipconfig0: input.ipConfig ?? 'ip=dhcp',
          agent: 'enabled=1',
          ...(settings.dnsServers ? { nameserver: settings.dnsServers.join(' ') } : {}),
          ...(settings.searchDomain ? { searchdomain: settings.searchDomain } : {}),
          ...(typeof config.digest === 'string' ? { digest: config.digest } : {}),
        },
      });
      return this.completedPreparation(resource, 'network');
    }
    this.assertPreparedNics(config);
    await input.beforePreparation?.('start');
    if (input.diskGb) {
      const existing = resource.diskGb;
      if (existing === null || input.diskGb > existing)
        await this.request<null>(`${base}/resize`, { method: 'PUT', body: { disk, size: `${input.diskGb}G` } });
    }
    return {
      ...this.task(await this.request<string>(`${base}/status/start`, { method: 'POST', body: {} }), resource.remoteId),
      preparationStage: 'start',
    };
  }

  private completedPreparation(
    resource: HostingResourceSnapshot,
    preparationStage: NonNullable<HostingCreateRequest['preparationStage']>
  ): HostingProviderOperation {
    return { id: null, resourceId: resource.remoteId, status: 'succeeded', preparationStage };
  }

  private assertPreparedNics(config: PveConfig): void {
    const networks = Object.entries(config).filter(([key]) => /^net\d+$/.test(key));
    if (!networks.length || networks.some(([, value]) => configValue(value, 'firewall') !== '1'))
      throw new AppError(
        409,
        'HOSTING_INITIAL_FIREWALL_UNVERIFIED',
        'Proxmox did not prepare the VM network firewall flags; the VM was not started'
      );
  }

  private async assertInitialFirewallOff(resource: HostingResourceSnapshot): Promise<void> {
    if (resource.powerState !== 'stopped')
      throw new AppError(409, 'HOSTING_VM_MUST_STOP', 'Initial firewall preparation requires a stopped VM');
    const verified = await this.request<PveConfig>(`${this.base(resource)}/firewall/options`);
    if (Number(verified.enable ?? 0) !== 0)
      throw new AppError(
        409,
        'HOSTING_INITIAL_FIREWALL_UNVERIFIED',
        'Proxmox did not disable the initial VM firewall; the VM was not started'
      );
  }

  private firewallNic(value: PveConfig[string]): string {
    return [
      ...String(value)
        .split(',')
        .filter((option) => !option.startsWith('firewall=')),
      'firewall=1',
    ].join(',');
  }

  /** Provisioning only: prepare NICs without activating inherited guest filtering. */
  private async disableInitialFirewall(resource: HostingResourceSnapshot): Promise<void> {
    if (resource.powerState !== 'stopped')
      throw new AppError(409, 'HOSTING_VM_MUST_STOP', 'Initial firewall preparation requires a stopped VM');
    const path = `${this.base(resource)}/firewall/options`;
    const options = await this.request<PveConfig>(path);
    await this.request<null>(path, {
      method: 'PUT',
      body: { enable: 0, ...(typeof options.digest === 'string' ? { digest: options.digest } : {}) },
    });
    await this.assertInitialFirewallOff(resource);
  }

  private async prepareImage(
    resource: HostingResourceSnapshot,
    input: HostingCreateRequest
  ): Promise<HostingProviderOperation> {
    const profile = input.proxmox!;
    const image = hostingCloudImage(input.image, input.role);
    if (
      resource.remoteId !== String(input.vmid) ||
      resource.location !== input.location ||
      resource.marker !== input.marker
    )
      throw new AppError(
        409,
        'HOSTING_RESOURCE_IDENTITY_CONFLICT',
        'Bootstrap target no longer belongs to this operation'
      );
    const base = this.base(resource);
    const config = await this.request<PveConfig>(`${base}/config`);
    if (config.lock) throw new AppError(409, 'HOSTING_VM_LOCKED', 'Proxmox is still preparing this VM');
    // Scratch imports belong to one operation. A checksum-looking shared filename is not verification.
    const filenames = imageFilenames(image, input.marker);
    const filename = filenames[0]!;
    const contents = async (storage: string) =>
      this.request<Array<{ volid: string }>>(`/nodes/${part(input.location)}/storage/${part(storage)}/content`);
    // An operation started by an older release keeps the media names it already wrote.
    const existing = async (storage: string, volumes: string[]) => {
      const items = await contents(storage);
      return volumes.find((volume) => items.some((item) => item.volid === volume));
    };
    const stageTask = (id: string, preparationStage: HostingProviderOperation['preparationStage']) => ({
      ...this.task(id, resource.remoteId),
      preparationStage,
    });
    const importedVolume = await existing(
      profile.imageStorage!,
      filenames.map((name) => `${profile.imageStorage}:import/${name}`)
    );
    const imported = importedVolume !== undefined;
    const imageVolume = importedVolume ?? `${profile.imageStorage}:import/${filename}`;
    const seedFilename = seedFilenames(input.marker)[0]!;
    if (!input.preparationStage) {
      if (imported)
        throw new AppError(
          409,
          'HOSTING_IMAGE_UNVERIFIED',
          'An image exists without a confirmed download task; refusing to import or overwrite it'
        );
      await input.beforePreparation?.('image');
      return stageTask(
        await this.request<string>(
          `/nodes/${part(input.location)}/storage/${part(profile.imageStorage!)}/download-url`,
          {
            method: 'POST',
            body: {
              content: 'import',
              url: image.url,
              filename,
              checksum: image.checksum,
              'checksum-algorithm': image.checksumAlgorithm,
              'verify-certificates': 1,
            },
          }
        ),
        'image'
      );
    }
    if (!imported)
      throw new AppError(
        409,
        'HOSTING_IMAGE_MISSING',
        'The verified operation image is missing; no replacement was downloaded'
      );
    const seededVolume = await existing(
      profile.seedStorage!,
      seedFilenames(input.marker).map((name) => `${profile.seedStorage}:iso/${name}`)
    );
    const seeded = seededVolume !== undefined;
    const seedVolume = seededVolume ?? `${profile.seedStorage}:iso/${seedFilename}`;
    if (input.preparationStage === 'image') {
      if (seeded)
        throw new AppError(409, 'HOSTING_SEED_UNVERIFIED', 'Bootstrap media exists without a confirmed upload task');
      const mac = String(config.net0 ?? '')
        .split(',')[0]
        ?.replace(/^virtio=/, '');
      const data = await buildProxmoxSeed(input, mac);
      await input.beforePreparation?.('seed');
      return stageTask(
        await this.request<string>(`/nodes/${part(input.location)}/storage/${part(profile.seedStorage!)}/upload`, {
          method: 'POST',
          seedIso: { filename: seedFilename, data },
        }),
        'seed'
      );
    }
    if (!seeded) throw new AppError(409, 'HOSTING_SEED_MISSING', 'The confirmed bootstrap medium is missing');
    if (input.preparationStage === 'seed') {
      if (config.scsi0)
        throw new AppError(409, 'HOSTING_DISK_UNVERIFIED', 'The VM already has a disk without a confirmed import task');
      // POST config is asynchronous (unlike PUT). Persist its UPID before the next preparation step.
      await input.beforePreparation?.('disk');
      return stageTask(
        await this.request<string>(`${base}/config`, {
          method: 'POST',
          body: {
            scsi0: `${profile.storage}:0,import-from=${imageVolume}`,
            ide2: `${seedVolume},media=cdrom`,
          },
        }),
        'disk'
      );
    }
    if (
      !String(config.ide2).startsWith(`${seedVolume},`) ||
      !isImportedBootDisk(config.scsi0, profile.storage, input.vmid)
    )
      throw new AppError(
        409,
        'HOSTING_RESOURCE_IDENTITY_CONFLICT',
        'VM disks do not match the accepted bootstrap configuration'
      );
    if (!input.diskGb || input.diskGb < image.diskGb)
      throw new AppError(400, 'HOSTING_DISK_SHRINK_UNSUPPORTED', `Disk must be at least ${image.diskGb} GiB`);
    if (input.preparationStage === 'disk') {
      // Adding a CD drive can overwrite a boot option in the same Proxmox request.
      // Configure boot separately, retaining its task for read-only recovery after a lost response.
      await input.beforePreparation?.('boot');
      return stageTask(
        await this.request<string>(`${base}/config`, { method: 'POST', body: { boot: 'order=scsi0' } }),
        'boot'
      );
    }
    if (
      !['boot', 'firewall', 'network'].includes(input.preparationStage ?? '') ||
      configValue(config.boot, 'order') !== 'scsi0'
    )
      throw new AppError(
        409,
        'HOSTING_BOOT_ORDER_UNVERIFIED',
        'Proxmox did not confirm boot from the system disk; the VM was not started'
      );
    if (input.preparationStage === 'boot') {
      await input.beforePreparation?.('firewall');
      await this.disableInitialFirewall(resource);
      return this.completedPreparation(resource, 'firewall');
    }
    await this.assertInitialFirewallOff(resource);
    // Older in-flight creations may predate the NIC default. Only prepare this stopped, owned VM.
    const networks = Object.fromEntries(
      Object.entries(config)
        .filter(([key, value]) => /^net\d+$/.test(key) && configValue(value, 'firewall') !== '1')
        .map(([key, value]) => [key, this.firewallNic(value)])
    );
    if (input.preparationStage === 'firewall') {
      await input.beforePreparation?.('network');
      if (Object.keys(networks).length) {
        await this.request<null>(`${base}/config`, {
          method: 'PUT',
          body: { ...networks, ...(typeof config.digest === 'string' ? { digest: config.digest } : {}) },
        });
      }
      this.assertPreparedNics(await this.request<PveConfig>(`${base}/config`));
      return this.completedPreparation(resource, 'network');
    }
    this.assertPreparedNics(config);
    await input.beforePreparation?.('start');
    if (resource.diskGb === null || resource.diskGb < input.diskGb)
      await this.request<null>(`${base}/resize`, { method: 'PUT', body: { disk: 'scsi0', size: `${input.diskGb}G` } });
    return stageTask(await this.request<string>(`${base}/status/start`, { method: 'POST', body: {} }), 'start');
  }

  /** Read-only recovery of a lost task response; never replays the underlying mutation. */
  async reconcilePreparation(
    resource: HostingResourceSnapshot,
    input: HostingCreateRequest,
    stage: NonNullable<HostingCreateRequest['preparationStage']>,
    since: number
  ): Promise<HostingProviderOperation | null> {
    if (
      resource.remoteId !== String(input.vmid) ||
      resource.location !== input.location ||
      resource.marker !== input.marker
    )
      throw new AppError(409, 'HOSTING_RESOURCE_IDENTITY_CONFLICT', 'Preparation target changed');
    if (!Number.isFinite(since)) return null;
    if (stage === 'firewall' || stage === 'network') {
      if (resource.powerState !== 'stopped') return null;
      const config = await this.request<PveConfig>(`${this.base(resource)}/config`);
      if (config.lock) return null;
      if (
        input.proxmox?.imageStorage &&
        (configValue(config.boot, 'order') !== 'scsi0' ||
          !seedFilenames(input.marker)
            .map((name) => `${input.proxmox!.seedStorage}:iso/${name}`)
            .includes(String(config.ide2).split(',')[0]!) ||
          !isImportedBootDisk(config.scsi0, input.proxmox.storage, input.vmid))
      )
        return null;
      const options = await this.request<PveConfig>(`${this.base(resource)}/firewall/options`);
      if (Number(options.enable ?? 0) !== 0) return null;
      if (stage === 'network') {
        try {
          this.assertPreparedNics(config);
        } catch {
          return null;
        }
        if (
          !input.proxmox?.imageStorage &&
          (Number(config.cores) !== (input.cpu ?? input.proxmox?.defaultCpu ?? 2) ||
            Number(config.memory) !== (input.memoryMb ?? input.proxmox?.defaultMemoryMb ?? 2048) ||
            configValue(config.net0, 'bridge') !== input.proxmox?.bridge ||
            config.ipconfig0 !== (input.ipConfig ?? 'ip=dhcp') ||
            !guestEnabled(config))
        )
          return null;
      }
      return this.completedPreparation(resource, stage);
    }
    if (stage === 'boot' || (stage === 'start' && resource.powerState === 'running')) {
      const config = await this.request<PveConfig>(`${this.base(resource)}/config`);
      const seeds = seedFilenames(input.marker).map((name) => `${input.proxmox!.seedStorage}:iso/${name}`);
      if (
        !config.lock &&
        configValue(config.boot, 'order') === 'scsi0' &&
        seeds.includes(String(config.ide2).split(',')[0]!) &&
        isImportedBootDisk(config.scsi0, input.proxmox!.storage, input.vmid) &&
        resource.cpu === input.cpu &&
        resource.memoryMb === input.memoryMb &&
        (stage === 'boot' || resource.diskGb === input.diskGb)
      )
        return { id: null, resourceId: resource.remoteId, status: 'succeeded', preparationStage: stage };
      // Boot configuration has no disk import side effects; only the observed final state proves it completed.
      if (stage === 'boot') return null;
    }
    const type = { image: 'download', seed: 'imgcopy', disk: 'qmconfig', start: 'qmstart' }[stage];
    const tasks = await this.request<Array<{ upid: string; id?: string; starttime: number }>>(
      `/nodes/${part(input.location)}/tasks`,
      {
        query: { source: 'all', typefilter: type, since: Math.floor(since), limit: 100 },
      }
    );
    const filenames =
      stage === 'image'
        ? imageFilenames(hostingCloudImage(input.image, input.role), input.marker)
        : seedFilenames(input.marker);
    const matches: string[] = [];
    for (const task of tasks) {
      if (task.upid.split(':')[7] !== this.connection.settings.tokenId) continue;
      if (stage === 'image' && filenames.includes(task.id ?? '')) matches.push(task.upid);
      else if ((stage === 'disk' || stage === 'start') && task.id === String(input.vmid)) matches.push(task.upid);
      else if (stage === 'seed') {
        // Upload tasks have no VMID. Their bounded log records the exact target filename, never file contents.
        const log = await this.request<Array<{ t: string }>>(
          `/nodes/${part(input.location)}/tasks/${part(task.upid)}/log`,
          { query: { start: 0, limit: 30 } }
        );
        if (
          log.some(
            (line) =>
              line.t.startsWith('target file: ') && filenames.some((filename) => line.t.endsWith(`/${filename}`))
          )
        )
          matches.push(task.upid);
      }
    }
    return matches.length === 1 ? { ...this.task(matches[0]!, resource.remoteId), preparationStage: stage } : null;
  }

  async cleanupBootstrap(resource: HostingResourceSnapshot, input: HostingCreateRequest): Promise<void> {
    if (!input.proxmox?.seedStorage) return;
    if (
      resource.remoteId !== String(input.vmid) ||
      resource.marker !== input.marker ||
      !/^gw-[a-f0-9-]{36}$/.test(input.marker)
    )
      throw new AppError(409, 'HOSTING_RESOURCE_IDENTITY_CONFLICT', 'Bootstrap cleanup target changed');
    const seedStorage = input.proxmox.seedStorage;
    const volumes = seedFilenames(input.marker).map((name) => `${seedStorage}:iso/${name}`);
    const base = this.base(resource);
    const config = await this.request<PveConfig>(`${base}/config`);
    if (volumes.includes(String(config.ide2 ?? '').split(',')[0]!))
      await this.request<null>(`${base}/config`, { method: 'PUT', body: { ide2: 'none,media=cdrom' } });
    const content = await this.request<Array<{ volid: string }>>(
      `/nodes/${part(resource.location)}/storage/${part(seedStorage)}/content`
    );
    for (const volume of volumes)
      if (content.some((entry) => entry.volid === volume))
        await this.request<null>(
          `/nodes/${part(resource.location)}/storage/${part(seedStorage)}/content/${part(volume)}`,
          { method: 'DELETE' }
        );
    const image = hostingCloudImage(input.image, input.role);
    const imageVolumes = imageFilenames(image, input.marker).map(
      (name) => `${input.proxmox!.imageStorage}:import/${name}`
    );
    const images = await this.request<Array<{ volid: string }>>(
      `/nodes/${part(resource.location)}/storage/${part(input.proxmox.imageStorage!)}/content`
    );
    for (const imageVolume of imageVolumes)
      if (images.some((entry) => entry.volid === imageVolume))
        await this.request<null>(
          `/nodes/${part(resource.location)}/storage/${part(input.proxmox.imageStorage!)}/content/${part(imageVolume)}`,
          { method: 'DELETE' }
        );
  }

  /**
   * Rewrites a description an older release wrote ("Gateway hosting <marker>") to the current form.
   * Description only, compare-and-set on the config digest; any other text in the description is kept.
   */
  async rewriteLegacyMarker(resource: HostingResourceSnapshot): Promise<boolean> {
    const key = `${resource.kind}:${resource.remoteId}`;
    if (!resource.marker || !this.legacyDescriptions.has(key)) return false;
    this.legacyDescriptions.delete(key);
    const base = this.base(resource);
    const config = await this.request<PveConfig>(`${base}/config`);
    const current = String(config.description ?? '');
    const legacy = LEGACY_DESCRIPTION_MARKER.exec(current);
    if (config.lock || DESCRIPTION_MARKER.test(current) || !legacy || legacy[1] !== resource.marker) return false;
    await this.request<null>(`${base}/config`, {
      method: 'PUT',
      body: {
        description: current.replace(legacy[0], description(resource.marker)),
        ...(typeof config.digest === 'string' ? { digest: config.digest } : {}),
      },
    });
    return true;
  }

  async action(
    resource: HostingResourceSnapshot,
    input: HostingActionRequest,
    progress?: { stage?: string; checkpoint(stage: string): Promise<void> }
  ): Promise<HostingProviderOperation> {
    const base = this.base(resource);
    if (input.action === 'recover')
      throw new AppError(400, 'HOSTING_RECOVERY_SCRIPT_REQUIRED', 'Use the role-specific recovery operation');
    if (input.action === 'resize') {
      if (resource.powerState !== 'stopped')
        throw new AppError(409, 'HOSTING_VM_MUST_STOP', 'Shut down the VM before resizing');
      if (input.diskGb !== undefined && (resource.diskGb === null || input.diskGb < resource.diskGb))
        throw new AppError(400, 'HOSTING_DISK_SHRINK_UNSUPPORTED', 'Disk size must be known and cannot decrease');
      const config = await this.request<PveConfig>(`${base}/config`);
      const disk = resource.kind === 'ct' ? 'rootfs' : diskKey(config);
      if (input.diskGb !== undefined && !disk)
        throw new AppError(400, 'HOSTING_DISK_UNKNOWN', 'Cannot unambiguously identify the boot disk');
      // A disk request without a receipt is never repeated. The worker can still
      // finish it by reading the exact requested dimensions on the next pass.
      if (progress?.stage === 'disk_dispatching') return { id: null, resourceId: resource.remoteId, status: 'unknown' };
      const changes = {
        ...(input.cpu !== undefined && input.cpu !== resource.cpu ? { cores: input.cpu } : {}),
        ...(input.memoryMb !== undefined && input.memoryMb !== resource.memoryMb ? { memory: input.memoryMb } : {}),
      };
      if (Object.keys(changes).length) {
        await progress?.checkpoint('config_dispatching');
        try {
          await this.request<null>(`${base}/config`, { method: 'PUT', body: changes });
        } catch (error) {
          if (error instanceof HostingProviderError && !error.outcomeUnknown)
            throw new AppError(
              409,
              'HOSTING_RESIZE_REJECTED',
              'Proxmox rejected CPU/RAM changes; no disk resize was sent'
            );
          throw error;
        }
      }
      await progress?.checkpoint('config_applied');
      if (input.diskGb !== undefined && input.diskGb !== resource.diskGb) {
        await progress?.checkpoint('disk_dispatching');
        try {
          await this.request<null>(`${base}/resize`, { method: 'PUT', body: { disk, size: `${input.diskGb}G` } });
        } catch (error) {
          if (error instanceof HostingProviderError && !error.outcomeUnknown)
            throw new AppError(
              409,
              'HOSTING_RESIZE_REJECTED',
              'Proxmox rejected disk growth after CPU/RAM changes; review the current VM configuration before retrying'
            );
          throw error;
        }
      }
      return { id: null, resourceId: resource.remoteId, status: 'succeeded' };
    }
    if (input.action === 'delete') {
      if (resource.powerState !== 'stopped')
        throw new AppError(409, 'HOSTING_VM_MUST_STOP', 'Shut down the VM before deleting it');
      return this.task(await this.request<string>(base, { method: 'DELETE' }), resource.remoteId);
    }
    const action = input.action === 'start' ? 'start' : input.action;
    return this.task(
      await this.request<string>(`${base}/status/${action}`, { method: 'POST', body: {} }),
      resource.remoteId
    );
  }

  async operation(id: string, resourceId?: string): Promise<HostingProviderOperation> {
    if (id.startsWith('guest:')) {
      const [, node, vmid, pid] = id.split(':');
      if (!node || !/^\d+$/.test(vmid ?? '') || !/^\d+$/.test(pid ?? ''))
        throw new AppError(400, 'HOSTING_TASK_INVALID', 'Invalid guest task');
      const result = await this.request<{ exited?: number; exitcode?: number }>(
        `/nodes/${part(node)}/qemu/${vmid}/agent/exec-status`,
        { query: { pid } }
      );
      return {
        id,
        resourceId: vmid,
        status: !result.exited ? 'running' : result.exitcode === 0 ? 'succeeded' : 'failed',
        error:
          result.exited && result.exitcode !== 0 ? 'Guest operation failed; check the node diagnostics' : undefined,
      };
    }
    const node = id.split(':')[1];
    if (!id.startsWith('UPID:') || !node) throw new AppError(400, 'HOSTING_TASK_INVALID', 'Invalid Proxmox task');
    const status = await this.request<{ status: string; exitstatus?: string }>(
      `/nodes/${part(node)}/tasks/${part(id)}/status`
    );
    return {
      id,
      resourceId,
      status:
        status.status === 'running'
          ? 'running'
          : status.status !== 'stopped'
            ? 'unknown'
            : status.exitstatus === 'OK'
              ? 'succeeded'
              : 'failed',
      error:
        status.status === 'stopped' && status.exitstatus !== 'OK'
          ? 'Proxmox task failed; inspect its task log'
          : undefined,
    };
  }

  async guestIdentity(resource: HostingResourceSnapshot): Promise<string | null> {
    if (resource.kind !== 'vm' || !resource.capabilities.guestIdentity.available || resource.powerState !== 'running')
      return null;
    // legacy-name: /var/lib/gateway/host-identity of guests installed before 2.12.1 — remove once every node reports none
    for (const file of ['/var/lib/opfield/host-identity', '/var/lib/gateway/host-identity']) {
      try {
        const data = await this.request<{ content: string }>(`${this.base(resource)}/agent/file-read`, {
          // Proxmox VE 9.1 accepts only `file`; count/decode were introduced in later API revisions.
          query: { file },
        });
        const value = data.content?.trim();
        if (value && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) return value;
      } catch (error) {
        if (!(error instanceof HostingProviderError)) throw error;
      }
    }
    return null;
  }

  async bootstrap(resource: HostingResourceSnapshot, script: string): Promise<HostingProviderOperation> {
    if (resource.kind !== 'vm' || !resource.capabilities.bootstrap.available)
      throw new AppError(409, 'HOSTING_GUEST_AGENT_REQUIRED', 'QEMU Guest Agent is required');
    if (Buffer.byteLength(script) > 65536)
      throw new AppError(400, 'HOSTING_BOOTSTRAP_TOO_LARGE', 'Bootstrap script is too large');
    const data = await this.request<{ pid: number }>(`${this.base(resource)}/agent/exec`, {
      method: 'POST',
      body: { command: ['/bin/bash', '-s'], 'input-data': script },
    });
    if (!Number.isInteger(data.pid)) return { id: null, resourceId: resource.remoteId, status: 'unknown' };
    return {
      id: `guest:${resource.location}:${resource.remoteId}:${data.pid}`,
      resourceId: resource.remoteId,
      status: 'running',
    };
  }
}

import { VmSnapshotAdapter } from './vm-snapshots.js';
