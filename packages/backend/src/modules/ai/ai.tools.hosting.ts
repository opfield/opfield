import { HOSTING_PROVIDERS } from '@/modules/hosting/hosting-provider.types.js';
import type { AIToolDefinition } from './ai.types.js';

const text = (description: string) => ({ type: 'string', description });
const count = (description: string) => ({ type: 'number', description });

const priceSchema = {
  type: 'object',
  description:
    'provision, and resize on cloud providers: the catalog price the user confirmed, sizes[].locationPrices[location] or sizes[].price. Required whenever the catalog shows a price; Proxmox has none.',
  properties: {
    amount: text('Decimal string exactly as in the catalog, for example "12.50".'),
    currency: text('Three-letter currency code as in the catalog, for example "EUR".'),
  },
  required: ['amount', 'currency'],
};

const firewallConfigSchema = {
  type: 'object',
  description: 'node_firewall_update: the complete firewall configuration (it replaces the current one).',
  properties: {
    enabled: { type: 'boolean' },
    inboundPolicy: { type: 'string', enum: ['allow', 'deny'] },
    outboundPolicy: { type: 'string', enum: ['allow', 'deny'] },
    rules: {
      type: 'array',
      description: 'At most 40 rules, evaluated in order.',
      items: {
        type: 'object',
        properties: {
          id: text('A UUID unique within the configuration (generate one for a new rule).'),
          direction: { type: 'string', enum: ['in', 'out'] },
          action: { type: 'string', enum: ['allow', 'deny'] },
          protocol: { type: 'string', enum: ['tcp', 'udp', 'icmp'] },
          ports: text('"all", one port such as "443", or a range such as "8000-8100"; ICMP takes "all".'),
          addresses: { type: 'array', items: { type: 'string' }, description: '1 to 16 IPv4/IPv6 addresses or CIDRs.' },
          description: text('Up to 120 characters; may be empty.'),
        },
        required: ['id', 'direction', 'action', 'protocol', 'ports', 'addresses', 'description'],
      },
    },
  },
  required: ['enabled', 'inboundPolicy', 'outboundPolicy', 'rules'],
};

/**
 * The fields of every operation body in one object: each operation takes only its own fields and refuses
 * unknown ones, exactly like the matching REST body.
 */
const inputSchema = {
  type: 'object',
  description:
    'Request body of the operation, validated like the matching REST body (unknown fields are refused). Each field says which operations take it. Read read_opfield_documentation topic hosting for the full workflow.',
  properties: {
    connectorId: text(
      'provision: hosting account UUID from connector_list (inside input; a top-level connectorId must name the same account). connector_discover: an existing Proxmox connector to rediscover.'
    ),
    idempotencyKey: text(
      'provision, operation_retry_install, resource_action, snapshot_action: a new random UUID per intent. Repeat an identical call with the same key after a timeout; it never runs twice.'
    ),
    name: text(
      'provision: VM and node host name (letters, digits, hyphens; at most 63). snapshot_action snapshot_create: snapshot name. connector_*: connector name.'
    ),
    displayName: text('provision: optional node display name.'),
    role: {
      type: 'string',
      enum: ['nginx', 'docker', 'builder', 'databases', 'storage', 'monitoring', 'relay'],
      description: 'provision: node role installed on the VM; the catalog image supportedRoles must include it.',
    },
    location: text(
      'provision: catalog locations[].id; Proxmox: the connector host (settings.proxmoxHost); existingResourceId: the VM location.'
    ),
    size: text(
      'provision: catalog sizes[].id ("custom" on Proxmox, "existing" with existingResourceId). resource_action resize on cloud providers: the new size id.'
    ),
    image: text('provision: catalog images[].id ("existing" with existingResourceId).'),
    cpu: count('provision on Proxmox (default 2) and resource_action resize on Proxmox: vCPUs.'),
    memoryMb: count('provision on Proxmox (default 2048) and resource_action resize on Proxmox: memory in MiB.'),
    diskGb: count(
      'provision on Proxmox (default 20, at least the image diskGb) and resource_action resize on Proxmox: disk in GiB; disks only grow.'
    ),
    folderId: text('provision: node folder UUID for the new node; needs nodes:create there.'),
    ipAddress: text(
      'provision on Proxmox with a static IP pool: an address from the pool; omitted takes the next free one.'
    ),
    relayAddress: text('provision with role relay: the address participating hosts use to reach the relay.'),
    confirmedPrice: priceSchema,
    existingResourceId: text(
      'provision: install the node on this existing unbound VM (an id from adoption_candidates resources) instead of ordering one.'
    ),
    sshConnectorId: text(
      'provision with existingResourceId, operation_retry_install: trusted external SSH connector to the VM when it has no Guest Agent channel (needs integrations:ssh:use).'
    ),
    action: {
      type: 'string',
      enum: [
        'start',
        'shutdown',
        'reboot',
        'resize',
        'delete',
        'recover',
        'snapshot_create',
        'snapshot_delete',
        'snapshot_restore',
      ],
      description:
        'resource_action: start, shutdown, reboot, resize, delete, or recover (restart the node daemon). snapshot_action: snapshot_create, snapshot_delete, or snapshot_restore.',
    },
    expectedIncarnation: text(
      'resource_action, snapshot_action: the VM incarnation from node_get or resources; a changed VM is refused with HOSTING_RESOURCE_IDENTITY_CONFLICT.'
    ),
    confirmed: {
      type: 'boolean',
      description: 'resource_action, snapshot_action: must be true, after the user confirmed the action.',
    },
    reason: text('resource_action: optional reason recorded with the action.'),
    includeRam: {
      type: 'boolean',
      description: 'snapshot_action snapshot_create: include RAM (running Proxmox VMs only).',
    },
    snapshotId: text('snapshot_action delete or restore: the snapshot id from snapshots_list.'),
    snapshotFingerprint: text('snapshot_action delete or restore: the snapshot fingerprint from snapshots_list.'),
    snapshotEntityId: text(
      'snapshot_action delete or restore: the Opfield snapshot entity UUID, instead of id and fingerprint.'
    ),
    config: firewallConfigSchema,
    expectedRevision: count('node_firewall_update: revision from node_firewall_get.'),
    expectedFingerprint: text('node_firewall_update: observation.fingerprint from node_firewall_get.'),
    acknowledgeConnectivityRisk: {
      type: 'boolean',
      description:
        'node_firewall_update: must be true to apply an enabled firewall (new connections may be interrupted).',
    },
    resourceId: text('adopt: unbound VM UUID from adoption_candidates resources.'),
    nodeId: text('adopt: Opfield node UUID from adoption_candidates nodes.'),
    provider: {
      type: 'string',
      enum: [...HOSTING_PROVIDERS],
      description: 'connector_create, connector_update, connector_preview, connector_discover (proxmox only).',
    },
    baseUrl: text(
      'connector_*: the provider official HTTPS API origin, or the Proxmox HTTPS origin such as https://pve.example.com:8006.'
    ),
    token: text(
      'connector_*: provider API token, only when the user gave it in this request; never repeat it. connector_update without token keeps the saved one.'
    ),
    enabled: { type: 'boolean', description: 'connector_*: default true (connector_discover requires true).' },
    tlsMode: {
      type: 'string',
      enum: ['system', 'ca', 'pin'],
      description:
        'connector_discover: Proxmox TLS trust (system, private CA in settings.caCertificate, or settings.certificateFingerprint pin).',
    },
    settings: {
      type: 'object',
      description:
        'connector_*: autoSyncEnabled, autoSyncIntervalSeconds (60-86400), adoptionEnabled, adoptionNodeIds, resourceIds, defaultLocation, defaultSize, defaultImage. Proxmox: tokenId (user@realm!name), proxmoxHost (required on create), caCertificate or certificateFingerprint, and for VM creation proxmox { nodes: [proxmoxHost], storage, imageStorage, seedStorage, bridge, vmidRange, network dhcp|static (static: subnet, gateway, ipRange), pool, vlan, dnsServers, searchDomain, mtu, firewall, maxCpu, maxMemoryMb, maxDiskGb }.',
    },
  },
};

export const HOSTING_AI_TOOLS: AIToolDefinition[] = [
  {
    name: 'manage_hosting',
    description:
      'Create servers as Opfield nodes at hosting providers (HOSTKEY, DigitalOcean, Hetzner Cloud, CloudBlast, Proxmox VE with one connector per physical host) and manage those VMs, with the same checks as the hosting API (each operation enforces its own integrations:hosting:*, hosting:*, and node scopes). Read read_opfield_documentation topic hosting first. Accounts: connector_list, connector_get, connector_configuration, connector_preview (test a create body without saving), connector_discover (Proxmox hosts, storages, bridges), connector_create, connector_update (full body), connector_delete, connector_test, connector_sync (refreshes inventory and the catalog), catalog (locations, sizes, images, prices; Proxmox capacity), resources, adoption_candidates, adopt (input {resourceId, nodeId}), operations_list, account_summary (balance and costs; needs hosting:billing:view). Ordering: provision (input {connectorId, idempotencyKey, name, role, location, size, image, confirmedPrice for paid providers, ...}; connectorId goes inside input), then operation_get until phase ready or failed, operation_reconcile, operation_retry_install (input {idempotencyKey, sshConnectorId?}; for a failed installation on an existing VM, never order a second VM). Nodes: node_bindings, node_get (resourceId, incarnation, powerState, available actions), node_firewall_get, node_firewall_update (input {config, expectedRevision, expectedFingerprint, acknowledgeConnectivityRisk}). VMs: resource_action (input {action: start|shutdown|reboot|resize|delete|recover, idempotencyKey, expectedIncarnation, confirmed: true, ...}), snapshots_list, snapshot_folders, snapshot_action (input {action: snapshot_create|snapshot_delete|snapshot_restore, idempotencyKey, expectedIncarnation, confirmed: true, ...}), snapshot_folder_action (folderOperation create|rename|delete|reorder-folders|move-resources|reorder-resources, folderId, input). Account top-up is not available (payment actions were removed from the API).',
    parameters: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: [
            'connector_list',
            'connector_get',
            'connector_configuration',
            'connector_preview',
            'connector_discover',
            'connector_create',
            'connector_update',
            'connector_delete',
            'connector_test',
            'connector_sync',
            'catalog',
            'resources',
            'adoption_candidates',
            'adopt',
            'operations_list',
            'account_summary',
            'node_bindings',
            'node_get',
            'node_firewall_get',
            'node_firewall_update',
            'provision',
            'operation_get',
            'operation_reconcile',
            'operation_retry_install',
            'resource_action',
            'snapshots_list',
            'snapshot_folders',
            'snapshot_action',
            'snapshot_folder_action',
          ],
        },
        connectorId: {
          type: 'string',
          description:
            'Hosting account (connector) UUID for the connector_*, catalog, resources, adoption_candidates, adopt, operations_list, and account_summary operations. provision takes it inside input.',
        },
        nodeId: { type: 'string', description: 'Opfield node UUID bound to a hosting VM' },
        operationId: { type: 'string', description: 'Hosting operation UUID' },
        resourceId: { type: 'string', description: 'Hosting VM (resource) UUID' },
        folderId: { type: 'string', description: 'Snapshot folder UUID for snapshot_folder_action' },
        folderOperation: {
          type: 'string',
          enum: ['create', 'rename', 'delete', 'reorder-folders', 'move-resources', 'reorder-resources'],
        },
        input: inputSchema,
      },
      required: ['operation'],
      additionalProperties: false,
    },
    destructive: true,
    category: 'Hosting',
    requiredScope: 'integrations:hosting:view',
    invalidateStores: ['integrations', 'nodes'],
  },
];
