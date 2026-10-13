import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { HostingFirewallConfig } from '../hosting-firewall.types.js';
import type { HostingHttp, HostingRequestOptions } from '../hosting-http.js';
import { HOSTING_CLOUD_IMAGES } from '../hosting-images.js';
import {
  type HostingConnection,
  type HostingCreateRequest,
  type HostingResourceSnapshot,
  hostingCapabilities,
} from '../hosting-provider.types.js';
import { CloudBlastApi } from './cloudblast-api.js';
import { CloudBlastFirewallAdapter } from './cloudblast-firewall.js';
import { DigitalOceanFirewallAdapter } from './digitalocean-firewall.js';
import { HetznerHostingAdapter } from './hetzner.js';
import { ProxmoxHostingAdapter } from './proxmox.js';
import { ProxmoxFirewallAdapter } from './proxmox-firewall.js';

type Call = { method: string; path: string; body?: unknown };
type Handler = (method: string, path: string, options: HostingRequestOptions) => unknown;

const MARKER = 'gw-0b0c1d2e-3f40-4a5b-8c6d-7e8f9a0b1c2d';
const sha = (value: string) => createHash('sha256').update(value).digest('hex');

function fake(handler: Handler) {
  const calls: Call[] = [];
  const request = async <T>(path: string, options: HostingRequestOptions = {}): Promise<T> => {
    const method = options.method ?? 'GET';
    calls.push({ method, path, body: options.body });
    const result = handler(method, path, options);
    if (result === undefined) throw new Error(`Unexpected ${method} ${path}`);
    return result as T;
  };
  const http: HostingHttp = { request };
  const writes = () => calls.filter((call) => call.method !== 'GET');
  return { http, request, calls, writes };
}

function connection(
  provider: HostingConnection['provider'],
  extra: Partial<HostingConnection['settings']> = {}
): HostingConnection {
  return {
    provider,
    baseUrl: 'https://provider.example',
    token: 'secret',
    settings: {
      kind: 'hosting',
      autoSyncEnabled: false,
      autoSyncIntervalSeconds: 300,
      resourceIds: [],
      adoptionNodeIds: [],
      adoptionEnabled: false,
      tokenId: 'root@pam!opfield',
      ...extra,
    },
  };
}

function snapshot(remoteId: string, extra: Partial<HostingResourceSnapshot> = {}): HostingResourceSnapshot {
  return {
    remoteId,
    kind: 'vm',
    name: 'vm',
    location: 'pve1',
    powerState: 'stopped',
    cpu: 2,
    memoryMb: 2048,
    diskGb: 20,
    addresses: [],
    incarnation: 'incarnation-1',
    capabilities: hostingCapabilities({}),
    observedAt: new Date().toISOString(),
    ...extra,
  };
}

const allowOut: HostingFirewallConfig = { enabled: true, inboundPolicy: 'deny', outboundPolicy: 'allow', rules: [] };

describe('Proxmox VM description marker', () => {
  function proxmox(description: string) {
    const config: Record<string, unknown> = {
      description,
      smbios1: `uuid=${MARKER.slice(3)}`,
      net0: 'virtio=AA:BB:CC:DD:EE:01,bridge=vmbr0',
      digest: 'config-digest',
    };
    const api = fake((method, path, options) => {
      if (path === '/api2/json/cluster/resources')
        return { data: [{ id: 'qemu/100', vmid: 100, node: 'pve1', type: 'qemu', name: 'vm', status: 'stopped' }] };
      if (path === '/api2/json/nodes/pve1/qemu/100/config') {
        if (method === 'PUT') Object.assign(config, options.body);
        return { data: method === 'GET' ? config : null };
      }
      if (path === '/api2/json/access/permissions') return { data: {} };
      return undefined;
    });
    return { adapter: new ProxmoxHostingAdapter(connection('proxmox'), api.http), api, config };
  }

  it('recognizes the current and the legacy description', async () => {
    expect((await proxmox(`Opfield hosting ${MARKER}`).adapter.getResource('100'))?.marker).toBe(MARKER);
    expect((await proxmox(`Gateway hosting ${MARKER}`).adapter.getResource('100'))?.marker).toBe(MARKER);
  });

  it('rewrites a legacy description in place and keeps the rest of it', async () => {
    const { adapter, api, config } = proxmox(`Gateway hosting ${MARKER}\nOperator note`);
    const resource = (await adapter.getResource('100'))!;
    expect(await adapter.rewriteLegacyMarker(resource)).toBe(true);
    expect(api.writes()).toEqual([
      {
        method: 'PUT',
        path: '/api2/json/nodes/pve1/qemu/100/config',
        body: { description: `Opfield hosting ${MARKER}\nOperator note`, digest: 'config-digest' },
      },
    ]);
    expect(config.description).toBe(`Opfield hosting ${MARKER}\nOperator note`);
    expect((await adapter.getResource('100'))?.marker).toBe(MARKER);
    expect(await adapter.rewriteLegacyMarker(resource)).toBe(false);
  });

  it('leaves a current description alone', async () => {
    const { adapter, api } = proxmox(`Opfield hosting ${MARKER}`);
    expect(await adapter.rewriteLegacyMarker((await adapter.getResource('100'))!)).toBe(false);
    expect(api.writes()).toEqual([]);
  });

  it('writes the current description on create', async () => {
    const profile = {
      nodes: ['pve1'],
      templateId: 9000,
      templateNode: 'pve1',
      cleanTemplate: true,
      storage: 'local-lvm',
      bridge: 'vmbr0',
      network: 'dhcp' as const,
    };
    const api = fake((_method, path) => {
      if (path === '/api2/json/nodes/pve1/qemu/9000/config')
        return {
          data: {
            template: 1,
            ostype: 'l26',
            agent: '1',
            scsi0: 'local-lvm:base-9000-disk-0,size=10G',
            ide2: 'local-lvm:cloudinit,media=cdrom',
            net0: 'virtio=AA:BB:CC:DD:EE:02,bridge=vmbr0',
          },
        };
      if (path === '/api2/json/cluster/nextid') return { data: '101' };
      if (path === '/api2/json/nodes/pve1/qemu/9000/clone') return { data: 'UPID:pve1:1:2:3:qmclone:9000:root@pam:' };
      return undefined;
    });
    const adapter = new ProxmoxHostingAdapter(connection('proxmox', { proxmox: profile }), api.http);
    await adapter.create({
      name: 'node',
      location: 'pve1',
      size: 'custom',
      image: '9000',
      marker: MARKER,
      userData: '',
      vmid: 101,
      proxmox: profile,
    });
    expect(api.writes()[0]?.body).toMatchObject({ description: `Opfield hosting ${MARKER}` });
  });

  it('cleans bootstrap media an operation started before the rename', async () => {
    const image = HOSTING_CLOUD_IMAGES[0]!;
    const seed = `isos:iso/gateway-seed-${MARKER}.iso`;
    const imported = `images:import/gateway-${image.id}-${image.checksum.slice(0, 16)}-${MARKER}.qcow2`;
    const api = fake((method, path) => {
      if (path === '/api2/json/nodes/pve1/qemu/100/config')
        return { data: method === 'GET' ? { ide2: `${seed},media=cdrom` } : null };
      if (path === '/api2/json/nodes/pve1/storage/isos/content') return { data: [{ volid: seed }] };
      if (path === '/api2/json/nodes/pve1/storage/images/content') return { data: [{ volid: imported }] };
      if (method === 'DELETE') return { data: null };
      return undefined;
    });
    const profile = {
      nodes: ['pve1'],
      storage: 'local-lvm',
      imageStorage: 'images',
      seedStorage: 'isos',
      bridge: 'vmbr0',
      network: 'dhcp' as const,
    };
    const request: HostingCreateRequest = {
      name: 'node',
      location: 'pve1',
      size: 'custom',
      image: image.id,
      marker: MARKER,
      userData: '',
      vmid: 100,
      proxmox: profile,
    };
    await new ProxmoxHostingAdapter(connection('proxmox', { proxmox: profile }), api.http).cleanupBootstrap(
      snapshot('100', { marker: MARKER }),
      request
    );
    expect(api.writes().map(({ method, path }) => `${method} ${path}`)).toEqual([
      'PUT /api2/json/nodes/pve1/qemu/100/config',
      `DELETE /api2/json/nodes/pve1/storage/isos/content/${encodeURIComponent(seed)}`,
      `DELETE /api2/json/nodes/pve1/storage/images/content/${encodeURIComponent(imported)}`,
    ]);
  });
});

describe('Proxmox firewall comments', () => {
  const ownerKey = 'resource-1';
  const token = sha(`${ownerKey}:100`).slice(0, 12);
  const group = `gwfw${sha(JSON.stringify({ ownerKey, remoteId: '100', desired: allowOut })).slice(0, 10)}abcd`;
  const base = '/nodes/pve1/qemu/100';

  function cluster(brand: 'Gateway' | 'Opfield') {
    const state = {
      groups: [{ group, comment: `${brand} firewall ${token}`, digest: 'cluster-1' }],
      groupRules: ['tcp', 'udp', 'icmp', 'ipv6-icmp'].map((proto, pos) => ({
        pos,
        type: 'out',
        action: 'ACCEPT',
        proto,
        comment: `${brand} firewall ${token} default-out-${proto}`,
        enable: 1,
        digest: 'cluster-1',
      })),
      vmRules: [
        {
          pos: 0,
          type: 'group',
          action: group,
          comment: `${brand} firewall ${token} binding`,
          enable: 1,
          digest: 'vm-1',
        },
      ],
    };
    const api = fake((method, path, options) => {
      const body = (options.body ?? {}) as Record<string, string>;
      if (path === '/cluster/firewall/options') return { enable: 1 };
      if (path === `${base}/config`) return { net0: 'virtio=AA:BB:CC:DD:EE:01,bridge=vmbr0,firewall=1' };
      if (path === `${base}/firewall/options`)
        return { enable: 1, policy_in: 'DROP', policy_out: 'DROP', dhcp: 0, ndp: 0, radv: 1 };
      if (path === '/access/permissions') return { '/vms/100': { 'VM.Config.Network': 1 }, '/': { 'Sys.Modify': 1 } };
      if (path === '/cluster/firewall/groups') {
        if (method === 'POST') {
          const target = state.groups.find((item) => item.group === body.rename)!;
          target.comment = body.comment!;
          return null;
        }
        return state.groups;
      }
      if (path === `/cluster/firewall/groups/${group}`) return state.groupRules;
      if (path === `${base}/firewall/rules`) return state.vmRules;
      const groupRule = /^\/cluster\/firewall\/groups\/[^/]+\/(\d+)$/.exec(path);
      const vmRule = new RegExp(`^${base}/firewall/rules/(\\d+)$`).exec(path);
      if (method === 'PUT' && (groupRule || vmRule)) {
        const rules = groupRule ? state.groupRules : state.vmRules;
        rules[Number((groupRule ?? vmRule)![1])]!.comment = body.comment!;
        return null;
      }
      return undefined;
    });
    const adapter = new ProxmoxFirewallAdapter({
      request: api.request,
      getResource: async () => snapshot('100'),
    });
    return { adapter, api, state };
  }

  it('treats legacy comments as owned and rewrites only the comments', async () => {
    const { adapter, api, state } = cluster('Gateway');
    const before = await adapter.read(snapshot('100'), ownerKey, allowOut);
    expect(before).toMatchObject({ enabled: true, matches: true, blockers: [] });

    expect(await adapter.migrateLegacyNames(snapshot('100'), ownerKey)).toBe(true);
    expect(api.writes().find((call) => call.path === '/cluster/firewall/groups')?.body).toEqual({
      group,
      rename: group,
      comment: `Opfield firewall ${token}`,
      digest: 'cluster-1',
    });
    expect(state.groups[0]!.comment).toBe(`Opfield firewall ${token}`);
    expect(state.groupRules.map((rule) => rule.comment)).toEqual(
      ['tcp', 'udp', 'icmp', 'ipv6-icmp'].map((proto) => `Opfield firewall ${token} default-out-${proto}`)
    );
    expect(state.groupRules.every((rule) => rule.action === 'ACCEPT' && rule.enable === 1)).toBe(true);
    expect(state.vmRules[0]).toMatchObject({ action: group, enable: 1, comment: `Opfield firewall ${token} binding` });
    expect(api.writes().every((call) => call.method === 'PUT' || call.path === '/cluster/firewall/groups')).toBe(true);

    expect(await adapter.read(snapshot('100'), ownerKey, allowOut)).toMatchObject({ enabled: true, matches: true });
    expect(await adapter.migrateLegacyNames(snapshot('100'), ownerKey)).toBe(false);
  });

  it('does not write when comments are current', async () => {
    const { adapter, api } = cluster('Opfield');
    expect(await adapter.read(snapshot('100'), ownerKey, allowOut)).toMatchObject({ matches: true });
    expect(await adapter.migrateLegacyNames(snapshot('100'), ownerKey)).toBe(false);
    expect(api.writes()).toEqual([]);
  });
});

describe('DigitalOcean firewall name', () => {
  const ownerKey = 'resource-1';
  const hash = sha(`${ownerKey}:123`).slice(0, 20);
  const everywhere = { addresses: ['0.0.0.0/0', '::/0'] };

  function account(name: string | null) {
    const firewalls =
      name === null
        ? []
        : [
            {
              id: 'fw-1',
              name,
              droplet_ids: [123],
              tags: [],
              inbound_rules: [],
              outbound_rules: [
                { protocol: 'tcp', ports: '0', destinations: everywhere },
                { protocol: 'udp', ports: '0', destinations: everywhere },
                { protocol: 'icmp', destinations: everywhere },
              ],
              status: 'succeeded',
              pending_changes: [],
            },
          ];
    const api = fake((method, path, options) => {
      if (path === '/v2/firewalls') {
        if (method === 'POST') return {};
        return { firewalls, links: {} };
      }
      if (path === '/v2/droplets/123/firewalls') return { firewalls };
      if (path === '/v2/firewalls/fw-1' && method === 'PUT') {
        firewalls[0]!.name = (options.body as { name: string }).name;
        return {};
      }
      return undefined;
    });
    const adapter = new DigitalOceanFirewallAdapter({ request: api.request, getResource: async () => snapshot('123') });
    return { adapter, api, firewalls };
  }

  it('owns a legacy-named firewall and renames it with the same rules and droplet', async () => {
    const { adapter, api, firewalls } = account(`gateway-fw-${hash}`);
    expect(await adapter.read(snapshot('123'), ownerKey, allowOut)).toMatchObject({
      enabled: true,
      matches: true,
      remoteId: 'fw-1',
      blockers: [],
    });
    expect(await adapter.migrateLegacyNames(snapshot('123'), ownerKey)).toBe(true);
    expect(api.writes()).toEqual([
      {
        method: 'PUT',
        path: '/v2/firewalls/fw-1',
        body: {
          name: `opfield-fw-${hash}`,
          droplet_ids: [123],
          tags: [],
          inbound_rules: [],
          outbound_rules: ['tcp', 'udp', 'icmp'].map((protocol) => ({
            action: 'allow',
            protocol,
            ports: '0',
            destinations: everywhere,
          })),
        },
      },
    ]);
    expect(firewalls[0]!.name).toBe(`opfield-fw-${hash}`);
    expect(await adapter.read(snapshot('123'), ownerKey, allowOut)).toMatchObject({ enabled: true, matches: true });
    expect(await adapter.migrateLegacyNames(snapshot('123'), ownerKey)).toBe(false);
  });

  it('creates new firewalls under the current name', async () => {
    const { adapter, api } = account(null);
    const observation = await adapter.read(snapshot('123'), ownerKey, allowOut);
    await adapter.apply(snapshot('123'), ownerKey, allowOut, observation);
    expect(api.writes()[0]).toMatchObject({
      method: 'POST',
      path: '/v2/firewalls',
      body: { name: `opfield-fw-${hash}` },
    });
  });
});

describe('CloudBlast firewall comments', () => {
  it('writes the current description and rule comment', async () => {
    const remoteId = '6f1c2d3e-4a5b-4c6d-8e7f-9a0b1c2d3e4f';
    const api = fake((method, path) => {
      if (path === '/api/v2/security-groups') return { data: method === 'POST' ? { id: 7 } : [] };
      if (path.startsWith('/api/v2/security-groups/7/')) return { data: {} };
      return undefined;
    });
    const adapter = new CloudBlastFirewallAdapter(new CloudBlastApi(api.http), async () => snapshot(remoteId));
    const observation = await adapter.read(snapshot(remoteId), 'resource-1', allowOut);
    await adapter.apply(snapshot(remoteId), 'resource-1', allowOut, observation);
    const writes = api.writes();
    expect(writes[0]).toMatchObject({ path: '/api/v2/security-groups', body: { description: 'Managed by Opfield' } });
    const rules = writes.filter((call) => call.path === '/api/v2/security-groups/7/rules');
    expect(rules.length).toBeGreaterThan(0);
    expect(rules.every((call) => (call.body as { comment: string }).comment === 'Managed by Opfield')).toBe(true);
  });
});

describe('Hetzner marker label', () => {
  function hetzner(labels: Record<string, string>) {
    const server = {
      id: 42,
      name: 'vm',
      status: 'running',
      created: '2026-01-01T00:00:00Z',
      location: { name: 'fsn1' },
      server_type: null,
      image: null,
      public_net: null,
      private_net: [],
      labels,
    };
    const api = fake((method, path, options) => {
      if (path === '/v1/servers/42') {
        if (method === 'PUT') server.labels = (options.body as { labels: Record<string, string> }).labels;
        return { server };
      }
      if (path === '/v1/servers' && method === 'POST') return { server, action: null };
      return undefined;
    });
    return { adapter: new HetznerHostingAdapter(connection('hetzner'), api.http), api, server };
  }

  it('recognizes the legacy label and moves it to the current key, keeping other labels', async () => {
    const { adapter, api, server } = hetzner({ 'gateway-marker': MARKER, team: 'ops' });
    const resource = (await adapter.getResource('42'))!;
    expect(resource.marker).toBe(MARKER);
    expect(await adapter.rewriteLegacyMarker(resource)).toBe(true);
    expect(api.writes()).toEqual([
      { method: 'PUT', path: '/v1/servers/42', body: { labels: { team: 'ops', marker: MARKER } } },
    ]);
    expect(server.labels).toEqual({ team: 'ops', marker: MARKER });
    expect((await adapter.getResource('42'))?.marker).toBe(MARKER);
    expect(await adapter.rewriteLegacyMarker(resource)).toBe(false);
  });

  it('leaves the current label alone and writes it on create', async () => {
    const { adapter, api } = hetzner({ marker: MARKER });
    expect(await adapter.rewriteLegacyMarker((await adapter.getResource('42'))!)).toBe(false);
    expect(api.writes()).toEqual([]);
    await adapter.create({
      name: 'node',
      location: 'fsn1',
      size: 'cx22',
      image: 'ubuntu-24.04',
      marker: MARKER,
      userData: '#cloud-config',
    });
    expect(api.writes()[0]?.body).toMatchObject({ labels: { marker: MARKER } });
  });
});
