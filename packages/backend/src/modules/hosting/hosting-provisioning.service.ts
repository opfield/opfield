import bcrypt from 'bcryptjs';
import { and, eq, ne, sql } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import {
  hostingNodeBindings,
  hostingOperations,
  hostingResources,
  integrationConnectors,
  nodeFolders,
  nodes,
} from '@/db/schema/index.js';
import { grantCreatedResourcePermissions } from '@/lib/created-resource-permissions.js';
import { hasScopeForCreation } from '@/lib/permissions.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import type { AuthService } from '@/modules/auth/auth.service.js';
import type { ExternalSshService } from '@/modules/integrations/external-ssh.service.js';
import { isSshOperationCancelled } from '@/modules/integrations/external-ssh-transport.js';
import { createNodeEnrollmentToken, nodeEnrollmentTokenExpiresAt } from '@/modules/nodes/node-enrollment-token.js';
import { CreateNodeSchema } from '@/modules/nodes/nodes.schemas.js';
import type { NodesService } from '@/modules/nodes/nodes.service.js';
import type { CryptoService } from '@/services/crypto.service.js';
import type { NodeDispatchService } from '@/services/node-dispatch.service.js';
import { DEFAULT_RELAY_SERVICE_PORT } from '@/services/relay-service-endpoint.js';
import type { ResourceSnapshotStore } from '@/services/resource-snapshot.store.js';
import type { User } from '@/types.js';
import { type HostingProvisionInput, HostingProvisionSchema } from './hosting.schemas.js';
import {
  buildHostingBootstrap,
  hostingInstallFailureMessage,
  parseHostingInstallResult,
  validateHostingOpfieldAddress,
} from './hosting-bootstrap.js';
import type { HostingConnectorRow, HostingConnectorsService } from './hosting-connectors.service.js';
import { compareHostingDecimal } from './hosting-decimal.js';
import { HostingProviderError } from './hosting-http.js';
import { applyHostingImagePolicy, hostingImageRoles } from './hosting-image-policy.js';
import { type CachedHostingCatalog, HOSTING_CATALOG_SNAPSHOT } from './hosting-inventory.service.js';
import { withKnownLocation } from './hosting-location.js';
import {
  type HostingOperationRow,
  type HostingOperationsService,
  publicHostingOperation,
  transientTaskRetry,
} from './hosting-operations.service.js';
import { assertHostingScope } from './hosting-permissions.js';
import type {
  HostingCatalog,
  HostingCreateRequest,
  HostingProviderAdapter,
  HostingProxmoxDiscovery,
  HostingResourceSnapshot,
} from './hosting-provider.types.js';
import { isHostedNodeReady } from './hosting-readiness.js';
import {
  RELAY_PORT_PROBE_TIMEOUT_MS,
  relayEndpoint,
  relayPortUnreachableMessage,
  tcpAnswers,
} from './hosting-relay-port.js';
import {
  createSshInstallKey,
  HostingSshInstaller,
  initialSshInstallState,
  installFailure,
  rotateSshInstallToken,
  SSH_INSTALL_TOKEN_TTL_MS,
  type SshInstallKey,
  sshInstallState,
} from './hosting-ssh-install.js';
import { allocateProxmoxPool } from './proxmox-allocation.js';
import { reserveProxmoxQuota } from './proxmox-quota.js';

type BootstrapPayload = { script: string; create: HostingCreateRequest; ssh?: SshInstallKey };
const BOOTSTRAP_TTL_MS = 60 * 60 * 1000;
const CREDIT_REJECTED_MESSAGE =
  'HOSTKEY rejected account credit payment. Pay this order invoice in HOSTKEY; Opfield will continue automatically once it is paid. No replacement VM will be ordered.';

function acceptedProvisionInput(request: Record<string, unknown>): HostingProvisionInput {
  const { vmid: _vmid, proxmoxProfile: _profile, ...input } = request;
  return HostingProvisionSchema.parse(input);
}

export function assertHostingQuote(input: HostingProvisionInput, catalog: HostingCatalog, ownInfrastructure: boolean) {
  if (input.existingResourceId) return;
  const size = catalog.sizes.find((option) => option.id === input.size);
  const image = catalog.images.find((option) => option.id === input.image);
  if (
    !size ||
    !image ||
    !catalog.locations.some((option) => option.id === input.location) ||
    (size.locations?.length && !size.locations.includes(input.location)) ||
    (image.locations?.length && !image.locations.includes(input.location)) ||
    (image.compatibleSizes !== undefined && !image.compatibleSizes.includes(input.size))
  )
    throw new AppError(409, 'HOSTING_CONFIGURATION_UNAVAILABLE', 'Selected region, size or image is unavailable');
  if (image.architecture && size.architecture && image.architecture !== size.architecture)
    throw new AppError(409, 'HOSTING_ARCHITECTURE_MISMATCH', 'Image and server architecture must match');
  if (!hostingImageRoles(image, ownInfrastructure ? 'proxmox' : 'digitalocean').includes(input.role))
    throw new AppError(
      400,
      'HOSTING_IMAGE_UNSUPPORTED',
      'This operating system does not support the selected node role'
    );
  const quote = size.locationPrices?.[input.location] ?? size.price;
  if (!ownInfrastructure && !quote)
    throw new AppError(409, 'HOSTING_PRICE_UNAVAILABLE', 'The provider did not return a price; no VM was ordered');
  if (
    quote &&
    (!input.confirmedPrice ||
      quote.currency !== input.confirmedPrice.currency ||
      compareHostingDecimal(quote.amount, input.confirmedPrice.amount) !== 0)
  )
    throw new AppError(409, 'HOSTING_PRICE_CHANGED', 'Review the current price before creating the VM');
}

// The one-time enrollment token expires 30 minutes after dispatch; past that plus a margin, nothing can finish.
const SSH_INSTALL_OUTCOME_TIMEOUT_MS = SSH_INSTALL_TOKEN_TTL_MS + 5 * 60 * 1000;

export class HostingProvisioningService {
  constructor(
    private readonly db: DrizzleClient,
    private readonly connectors: HostingConnectorsService,
    private readonly operations: HostingOperationsService,
    private readonly nodeService: NodesService,
    private readonly crypto: CryptoService,
    private readonly auth: Pick<AuthService, 'getUserById'>,
    private readonly dispatch: Pick<NodeDispatchService, 'isNodeConnected'>,
    private readonly audit: Pick<AuditService, 'log'>,
    private readonly ssh: Pick<
      ExternalSshService,
      'executeForHosting' | 'readHostKeyForHosting' | 'executeWithKeyForHosting'
    >,
    private readonly snapshots?: ResourceSnapshotStore
  ) {
    this.sshInstall = new HostingSshInstaller({ operations, ssh, audit });
  }
  private readonly sshInstall: HostingSshInstaller;

  async catalog(connectorId: string, user: User) {
    const connector = await this.connectors.get(connectorId, user, true);
    const snapshot = await this.snapshots?.get<CachedHostingCatalog>(HOSTING_CATALOG_SNAPSHOT, connectorId);
    if (!snapshot?.observedAt || snapshot.data.configurationRevision !== connector.updatedAt.toISOString())
      throw new AppError(
        503,
        'HOSTING_CATALOG_NOT_READY',
        'The hosting catalog is not ready yet. Background synchronization will refresh it.'
      );
    // Re-apply policy on reads so old Redis snapshots cannot advertise previously admitted images.
    return applyHostingImagePolicy(snapshot.data.catalog, connector.provider as HostingProviderAdapter['provider']);
  }

  async create(input: HostingProvisionInput, user: User) {
    assertHostingScope(user.scopes, 'hosting:resources:create', input.connectorId);
    await this.assertNodeCreationDestination(user.scopes, input.folderId);
    const replay = await this.operations.findIntent({
      connectorId: input.connectorId,
      actorId: user.id,
      action: input.existingResourceId ? 'install' : 'create',
      idempotencyKey: input.idempotencyKey,
      request: { ...input },
    });
    if (replay) return this.operations.get(replay.id, user);
    const connector = await this.connectors.get(input.connectorId, user, true);
    const settings = this.connectors.settings(connector);
    const adapter = this.connectors.adapter(connector);
    // Reject insufficient DO permissions before reserving a node or durable order.
    // The adapter checks again at dispatch in case scopes changed in the meantime.
    if (connector.provider === 'digitalocean' && !input.existingResourceId) {
      const account = await adapter.test();
      if (!account.capabilities.create.available)
        throw new HostingProviderError(
          403,
          false,
          account.capabilities.create.reason ?? 'DigitalOcean VM creation is unavailable'
        );
    }
    let acceptedInput: HostingProvisionInput = input;
    let proxmoxDiscovery: HostingProxmoxDiscovery | undefined;
    const targets = await this.nodeService.getOpfieldEnrollmentTargets();
    const opfieldAddress =
      connector.provider === 'proxmox' ? targets.local?.address || targets.public.address : targets.public.address;
    if (!opfieldAddress)
      throw new AppError(
        409,
        'HOSTING_OPFIELD_NOT_READY',
        'Configure a reachable Opfield enrollment endpoint before creating a VM'
      );
    validateHostingOpfieldAddress(opfieldAddress, connector.provider === 'proxmox');
    const catalog = await adapter.catalog();
    assertHostingQuote(input, catalog, connector.provider === 'proxmox');
    if (connector.provider === 'proxmox' && !input.existingResourceId) {
      const profile = settings.proxmox;
      if (!profile?.imageStorage || !profile.seedStorage)
        throw new AppError(
          409,
          'HOSTING_IMAGE_STORAGE_REQUIRED',
          'Configure image and bootstrap storage in the Proxmox connector'
        );
      if (!profile.vmidRange)
        throw new AppError(409, 'HOSTING_POOL_REQUIRED', 'Configure a Proxmox VMID range before creating a VM');
      if (!adapter.discover)
        throw new AppError(409, 'HOSTING_DISCOVERY_UNSUPPORTED', 'Proxmox setup discovery is unavailable');
      proxmoxDiscovery = await adapter.discover();
      if (settings.proxmoxHost && input.location !== settings.proxmoxHost)
        throw new AppError(
          400,
          'HOSTING_PROXMOX_HOST_REQUIRED',
          'Create the VM on this connector’s selected physical host'
        );
      acceptedInput = {
        ...input,
        cpu: input.cpu ?? 2,
        memoryMb: input.memoryMb ?? 2048,
        diskGb: input.diskGb ?? 20,
      };
      const capacity = catalog.capacity?.find((host) => host.id === input.location);
      if (!capacity?.online) throw new AppError(409, 'HOSTING_TARGET_OFFLINE', 'Selected Proxmox host is unavailable');
      const image = catalog.images.find((option) => option.id === input.image);
      if (image?.diskGb && acceptedInput.diskGb! < image.diskGb)
        throw new AppError(
          400,
          'HOSTING_DISK_SHRINK_UNSUPPORTED',
          `Disk must be at least ${image.diskGb} GiB for this operating system`
        );
      if (
        capacity.diskTotalGb !== null &&
        capacity.diskUsedGb !== null &&
        acceptedInput.diskGb! > capacity.diskTotalGb - capacity.diskUsedGb
      )
        throw new AppError(
          409,
          'HOSTING_CAPACITY_UNAVAILABLE',
          'The selected Proxmox storage has insufficient free capacity'
        );
      if (
        capacity.memoryTotalMb !== null &&
        capacity.memoryUsedMb !== null &&
        acceptedInput.memoryMb! > capacity.memoryTotalMb - capacity.memoryUsedMb
      )
        throw new AppError(
          409,
          'HOSTING_CAPACITY_UNAVAILABLE',
          'The selected host does not have enough available memory'
        );
    }
    let existing: typeof hostingResources.$inferSelect | undefined;
    if (input.existingResourceId) {
      [existing] = await this.db
        .select()
        .from(hostingResources)
        .where(and(eq(hostingResources.id, input.existingResourceId), eq(hostingResources.connectorId, connector.id)))
        .limit(1);
      if (!existing || existing.origin !== 'discovered' || existing.managedHostIdentity || existing.missingSince)
        throw new AppError(
          409,
          'HOSTING_RESOURCE_NOT_INSTALLABLE',
          'Only an unbound discovered VM can be installed explicitly'
        );
      assertHostingScope(user.scopes, 'hosting:resources:recover', existing.id);
      if (connector.provider === 'proxmox') {
        // Installing an existing VM reserves its observed allocation, never caller-supplied sizes.
        acceptedInput = {
          ...input,
          cpu: existing.snapshot.cpu ?? undefined,
          memoryMb: existing.snapshot.memoryMb ?? undefined,
          diskGb: existing.snapshot.diskGb ?? undefined,
        };
      }
      if (!existing.snapshot.capabilities.bootstrap.available && !input.sshConnectorId)
        throw new AppError(
          409,
          'HOSTING_INSTALL_TRANSPORT_REQUIRED',
          'Select a trusted SSH connection or use a VM with Guest Agent'
        );
      if (input.sshConnectorId) assertHostingScope(user.scopes, 'integrations:ssh:use');
    }
    const relayAddress = input.role === 'relay' ? input.relayAddress : undefined;
    const relayServicePort = relayAddress ? input.relayServicePort : undefined;
    const nodeInput = CreateNodeSchema.parse({
      type: input.role,
      hostname: input.name,
      displayName: input.displayName ?? input.name,
      folderId: input.folderId ?? null,
      ...(relayAddress ? { serviceAddresses: [relayAddress] } : {}),
      ...(relayServicePort ? { servicePort: relayServicePort } : {}),
    });
    const reserved = await this.operations.reserve(
      {
        connectorId: connector.id,
        resourceId: existing?.id,
        actorId: user.id,
        action: existing ? 'install' : 'create',
        idempotencyKey: input.idempotencyKey,
        request: { ...acceptedInput },
        intent: { ...input },
      },
      async (tx, operationId) => {
        if (existing && connector.provider === 'proxmox')
          await reserveProxmoxQuota(tx, connector.id, existing.snapshot, existing.id);
        let acceptedRequest: HostingProvisionInput & { vmid?: number } = acceptedInput;
        let ipConfig = 'ip=dhcp';
        let proxmoxProfile: HostingCreateRequest['proxmox'];
        if (!existing && connector.provider === 'proxmox') {
          const profile = settings.proxmox!;
          await reserveProxmoxQuota(tx, connector.id, acceptedInput);
          if (!settings.proxmoxAllocationAuthority)
            throw new AppError(
              409,
              'HOSTING_LEGACY_RECONCILIATION_REQUIRED',
              'Test or reconfigure this Proxmox integration before allocating from a shared cluster pool'
            );
          const allocation = await allocateProxmoxPool(tx, {
            allocationAuthority: settings.proxmoxAllocationAuthority,
            profile,
            usedVmids: proxmoxDiscovery!.usedVmids,
            usedIps: proxmoxDiscovery!.usedIps,
            requestedIp: acceptedInput.ipAddress,
          });
          acceptedRequest = {
            ...acceptedInput,
            vmid: allocation.vmid,
            ...(allocation.ipAddress ? { ipAddress: allocation.ipAddress } : {}),
          };
          proxmoxProfile = {
            ...profile,
            nodes: [...profile.nodes],
            dnsServers: profile.dnsServers ? [...profile.dnsServers] : undefined,
          };
          if (allocation.ipAddress) {
            const prefix = profile.subnet!.split('/')[1];
            ipConfig = `ip=${allocation.ipAddress}/${prefix},gw=${profile.gateway}`;
          }
        }
        // Providers without user data install over SSH with a one-time key and a short-lived token.
        const sshKey =
          connector.provider === 'cloudblast' && !existing ? createSshInstallKey(`gw-${operationId}`) : undefined;
        const created = sshKey
          ? await this.nodeService.create(nodeInput, user.id, tx, { enrollmentTokenTtlMs: SSH_INSTALL_TOKEN_TTL_MS })
          : await this.nodeService.create(nodeInput, user.id, tx);
        const script = buildHostingBootstrap({
          // CloudBlast's SSH comes up while cloud-init still runs apt; Proxmox guests seeded from image storage
          // are installed after the fact.
          waitForCloudInit: connector.provider === 'proxmox' ? !proxmoxProfile?.imageStorage : true,
          role: acceptedRequest.role,
          opfieldAddress,
          token: created.enrollmentToken,
          certificateFingerprint: created.opfieldCertSha256,
          relayAddress,
          relayServicePort,
          requireCleanHost: !existing,
          operationMarker: `gw-${operationId}`,
          // Cloud-init runs this installer unobserved; Opfield reads its result through the guest agent.
          reportResult: connector.provider === 'proxmox' && !existing && Boolean(proxmoxProfile?.imageStorage),
        });
        const payload: BootstrapPayload = {
          script,
          create: {
            name: acceptedRequest.name,
            role: acceptedRequest.role,
            location: acceptedRequest.location,
            size: acceptedRequest.size,
            image: acceptedRequest.image,
            marker: `gw-${operationId}`,
            userData: script,
            cpu: acceptedRequest.cpu,
            memoryMb: acceptedRequest.memoryMb,
            diskGb: acceptedRequest.diskGb,
            ipConfig,
            vmid: acceptedRequest.vmid,
            proxmox: proxmoxProfile,
            ...(sshKey ? { sshPublicKey: sshKey.publicKey } : {}),
          },
          ...(sshKey ? { ssh: sshKey } : {}),
        };
        return {
          request: {
            ...acceptedRequest,
            ...(proxmoxProfile ? { proxmoxProfile } : {}),
          } as unknown as Record<string, unknown>,
          nodeId: created.node.id,
          encryptedBootstrap: JSON.stringify(this.crypto.encryptString(JSON.stringify(payload))),
          bootstrapExpiresAt: new Date(Date.now() + BOOTSTRAP_TTL_MS),
          ...(sshKey ? { result: { sshInstall: initialSshInstallState() } } : {}),
        };
      }
    );
    if (reserved.created && reserved.operation.nodeId)
      await this.nodeService.announceCreated(
        { id: reserved.operation.nodeId, hostname: input.name, type: input.role },
        user.id
      );
    if (reserved.created)
      await this.audit.log({
        userId: user.id,
        action: 'hosting.operation.requested',
        resourceType: 'hosting-operation',
        resourceId: reserved.operation.id,
        details: { action: reserved.operation.action, connectorId: connector.id },
      });
    this.connectors.changed(connector.id);
    return publicHostingOperation(reserved.operation);
  }

  private payload(row: HostingOperationRow): BootstrapPayload {
    if (!row.encryptedBootstrap)
      throw new AppError(409, 'HOSTING_BOOTSTRAP_EXPIRED', 'Bootstrap credentials are no longer available');
    return JSON.parse(this.crypto.decryptString(JSON.parse(row.encryptedBootstrap))) as BootstrapPayload;
  }

  async retryInstall(id: string, input: { idempotencyKey: string; sshConnectorId?: string }, user: User) {
    await this.operations.get(id, user);
    const [original] = await this.db.select().from(hostingOperations).where(eq(hostingOperations.id, id));
    if (
      !original ||
      !['create', 'install'].includes(original.action) ||
      original.phase !== 'failed' ||
      !original.connectorId ||
      !original.resourceId ||
      !original.nodeId
    )
      throw new AppError(
        409,
        'HOSTING_INSTALL_NOT_RETRYABLE',
        'Only a failed installation on a known existing VM can be retried'
      );
    assertHostingScope(user.scopes, 'hosting:resources:recover', original.resourceId);
    assertHostingScope(user.scopes, 'nodes:manage', original.nodeId);
    const previous = acceptedProvisionInput(original.request);
    const request: HostingProvisionInput = {
      ...previous,
      existingResourceId: original.resourceId,
      idempotencyKey: input.idempotencyKey,
      sshConnectorId: input.sshConnectorId ?? previous.sshConnectorId,
    };
    const replay = await this.operations.findIntent({
      connectorId: original.connectorId,
      actorId: user.id,
      action: 'install',
      idempotencyKey: input.idempotencyKey,
      request: { ...request },
    });
    if (replay) return this.operations.get(replay.id, user);
    const connector = await this.connectors.get(original.connectorId, user, true);
    const [resource] = await this.db
      .select()
      .from(hostingResources)
      .where(eq(hostingResources.id, original.resourceId));
    if (
      !resource ||
      resource.missingSince ||
      resource.managedHostIdentity ||
      !resource.incarnation ||
      resource.incarnation !== resource.snapshot.incarnation ||
      resource.connectorId !== connector.id
    )
      throw new AppError(
        409,
        'HOSTING_RESOURCE_IDENTITY_CONFLICT',
        'The original installation resource is no longer available'
      );
    if (!resource.snapshot.capabilities.bootstrap.available && !input.sshConnectorId)
      throw new AppError(
        409,
        'HOSTING_INSTALL_TRANSPORT_REQUIRED',
        'Select a trusted SSH connection for this existing VM'
      );
    if (resource.snapshot.powerState !== 'running')
      throw new AppError(409, 'HOSTING_VM_STOPPED', 'Start the existing VM before retrying its installation');
    if (input.sshConnectorId) assertHostingScope(user.scopes, 'integrations:ssh:use');
    const targets = await this.nodeService.getOpfieldEnrollmentTargets();
    const opfieldAddress =
      connector.provider === 'proxmox' ? targets.local?.address || targets.public.address : targets.public.address;
    if (!opfieldAddress)
      throw new AppError(409, 'HOSTING_OPFIELD_NOT_READY', 'Configure a reachable Opfield enrollment endpoint');
    validateHostingOpfieldAddress(opfieldAddress, connector.provider === 'proxmox');
    const certificateFingerprint = await this.nodeService.getOpfieldEnrollmentCertificateFingerprint();
    const marker =
      typeof original.result?.bootstrapMarker === 'string' ? original.result.bootstrapMarker : `gw-${original.id}`;
    const reserved = await this.operations.reserve(
      {
        connectorId: connector.id,
        resourceId: resource.id,
        actorId: user.id,
        action: 'install',
        idempotencyKey: input.idempotencyKey,
        request: { ...request },
      },
      async (tx) => {
        const [pending] = await tx.select().from(nodes).where(eq(nodes.id, original.nodeId!)).for('update');
        if (!pending || pending.status !== 'pending' || pending.certificateFingerprint || pending.hostIdentityId)
          throw new AppError(
            409,
            'HOSTING_NODE_ALREADY_ENROLLED',
            'This node is already enrolled; use daemon recovery instead of reinstalling'
          );
        const token = createNodeEnrollmentToken();
        await tx
          .update(nodes)
          .set({
            enrollmentTokenHash: await bcrypt.hash(token.token, 10),
            enrollmentTokenSelector: token.selector,
            enrollmentTokenExpiresAt: nodeEnrollmentTokenExpiresAt(),
          })
          .where(eq(nodes.id, pending.id));
        const script = buildHostingBootstrap({
          waitForCloudInit: true,
          role: previous.role,
          opfieldAddress,
          certificateFingerprint,
          token: token.token,
          relayAddress: previous.relayAddress,
          relayServicePort: previous.role === 'relay' ? previous.relayServicePort : undefined,
          operationMarker: marker,
          expectedOperationMarker: marker,
        });
        const payload: BootstrapPayload = { script, create: { ...previous, marker, userData: script } };
        return {
          nodeId: pending.id,
          encryptedBootstrap: JSON.stringify(this.crypto.encryptString(JSON.stringify(payload))),
          bootstrapExpiresAt: new Date(Date.now() + BOOTSTRAP_TTL_MS),
          result: { retryOf: original.id, bootstrapMarker: marker },
        };
      }
    );
    if (reserved.created)
      await this.audit.log({
        userId: user.id,
        action: 'hosting.install.retry',
        resourceType: 'hosting-operation',
        resourceId: reserved.operation.id,
        details: { previousOperationId: id, resourceId: resource.id, nodeId: original.nodeId },
      });
    this.connectors.changed(connector.id);
    return publicHostingOperation(reserved.operation);
  }

  private async actor(row: HostingOperationRow, connector: HostingConnectorRow): Promise<User> {
    const actor = row.actorId ? await this.auth.getUserById(row.actorId) : null;
    if (!actor || actor.isBlocked || actor.isDeleted)
      throw new AppError(403, 'HOSTING_ACTOR_REVOKED', 'The operation owner no longer has access');
    assertHostingScope(actor.scopes, 'integrations:hosting:view', connector.id);
    return actor;
  }

  private async assertNodeCreationDestination(scopes: string[], folderId?: string | null) {
    if (!hasScopeForCreation(scopes, 'nodes:create', folderId))
      throw new AppError(403, 'HOSTING_ACCESS_DENIED', 'Node creation is not allowed in the destination folder');
    if (!folderId) return;
    const [folder] = await this.db
      .select({ id: nodeFolders.id })
      .from(nodeFolders)
      .where(eq(nodeFolders.id, folderId))
      .limit(1);
    if (!folder) throw new AppError(404, 'FOLDER_NOT_FOUND', 'Destination node folder was not found');
  }

  private async authorizeBootstrap(row: HostingOperationRow, connector: HostingConnectorRow, actor: User) {
    if (row.action === 'install' && row.result?.retryOf && row.resourceId && row.nodeId) {
      assertHostingScope(actor.scopes, 'hosting:resources:recover', row.resourceId);
      assertHostingScope(actor.scopes, 'nodes:manage', row.nodeId);
    } else {
      assertHostingScope(actor.scopes, 'hosting:resources:create', connector.id);
      const requestedFolder = typeof row.request?.folderId === 'string' ? row.request.folderId : null;
      await this.assertNodeCreationDestination(actor.scopes, requestedFolder);
      if (row.nodeId) {
        const [node] = await this.db
          .select({ folderId: nodes.folderId })
          .from(nodes)
          .where(eq(nodes.id, row.nodeId))
          .limit(1);
        if (!node) throw new AppError(404, 'NOT_FOUND', 'Reserved node was not found');
        await this.assertNodeCreationDestination(actor.scopes, node.folderId);
      }
      if (row.action === 'install' && row.resourceId)
        assertHostingScope(actor.scopes, 'hosting:resources:recover', row.resourceId);
    }
  }

  private async trackResource(
    row: HostingOperationRow,
    connector: HostingConnectorRow,
    snapshot: HostingResourceSnapshot
  ) {
    const authority = this.connectors.settings(connector).authority;
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('hosting-inventory'))`);
      const [currentConnector] = await tx
        .select()
        .from(integrationConnectors)
        .where(eq(integrationConnectors.id, connector.id))
        .for('update');
      if (!currentConnector?.enabled)
        throw new AppError(409, 'HOSTING_CONNECTOR_DISABLED', 'Hosting integration is disabled');
      const currentSettings = this.connectors.settings(currentConnector);
      if (currentSettings.resourceIds.length && !currentSettings.resourceIds.includes(snapshot.remoteId)) {
        // The create permission explicitly admits the newly purchased resource, not unrelated inventory.
        await tx
          .update(integrationConnectors)
          .set({ settings: { ...currentSettings, resourceIds: [...currentSettings.resourceIds, snapshot.remoteId] } })
          .where(eq(integrationConnectors.id, connector.id));
      }
      const [existing] = await tx
        .select()
        .from(hostingResources)
        .where(
          and(
            eq(hostingResources.provider, connector.provider as HostingProviderAdapter['provider']),
            eq(hostingResources.authority, authority),
            eq(hostingResources.remoteId, snapshot.remoteId),
            eq(hostingResources.kind, snapshot.kind),
            sql`${hostingResources.missingSince} IS NULL`
          )
        )
        .for('update');
      if (existing && (existing.managedHostIdentity || (existing.connectorId && existing.connectorId !== connector.id)))
        throw new AppError(
          409,
          'HOSTING_RESOURCE_IDENTITY_CONFLICT',
          'Created resource identity conflicts with an existing managed host'
        );
      // Providers that never report a location keep the one this VM was ordered in.
      const requested =
        row.action === 'create' && typeof row.request?.location === 'string' ? row.request.location : '';
      const located = withKnownLocation(snapshot, existing?.snapshot.location || requested);
      if (existing) {
        const [updated] = await tx
          .update(hostingResources)
          .set({
            origin: row.action === 'create' ? 'created' : 'discovered',
            snapshot: located,
            incarnation: snapshot.incarnation,
            observedAt: new Date(snapshot.observedAt),
            connectorId: connector.id,
          })
          .where(eq(hostingResources.id, existing.id))
          .returning();
        return updated;
      }
      const [created] = await tx
        .insert(hostingResources)
        .values({
          connectorId: connector.id,
          provider: connector.provider as HostingProviderAdapter['provider'],
          authority,
          remoteId: snapshot.remoteId,
          kind: snapshot.kind,
          origin: 'created',
          snapshot: located,
          incarnation: snapshot.incarnation,
          observedAt: new Date(snapshot.observedAt),
        })
        .returning();
      return created;
    });
  }

  private async enrolled(
    row: HostingOperationRow,
    connector: HostingConnectorRow,
    actor: User,
    adapter: HostingProviderAdapter
  ): Promise<boolean> {
    if (!row.nodeId || !row.resourceId || !this.dispatch.isNodeConnected(row.nodeId)) return false;
    const [node] = await this.db.select().from(nodes).where(eq(nodes.id, row.nodeId));
    if (
      !node ||
      node.status !== 'online' ||
      !node.hostIdentityId ||
      node.enrollmentTokenHash ||
      !node.certificateFingerprint
    )
      return false;
    if (!isHostedNodeReady(node, this.dispatch.isNodeConnected(node.id))) return false;
    if (!(await this.relayPortAnswers(row))) return false;
    await this.authorizeBootstrap(row, connector, actor);
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('hosting-inventory'))`);
      const [owned] = await tx.select().from(hostingOperations).where(eq(hostingOperations.id, row.id)).for('update');
      if (
        !owned ||
        owned.generation !== row.generation ||
        owned.leaseOwner !== row.leaseOwner ||
        !owned.leaseExpiresAt ||
        owned.leaseExpiresAt.getTime() <= Date.now()
      )
        throw new AppError(409, 'HOSTING_OPERATION_LEASE_LOST', 'Hosting operation ownership changed');
      const [resource] = await tx
        .select()
        .from(hostingResources)
        .where(eq(hostingResources.id, row.resourceId!))
        .for('update');
      if (
        !resource ||
        resource.incarnation !== resource.snapshot.incarnation ||
        resource.missingSince ||
        (resource.managedHostIdentity && resource.managedHostIdentity !== node.hostIdentityId)
      )
        throw new AppError(409, 'HOSTING_RESOURCE_IDENTITY_CONFLICT', 'VM identity changed during enrollment');
      if (row.action === 'install' && connector.provider === 'proxmox')
        await reserveProxmoxQuota(tx, connector.id, resource.snapshot, resource.id);
      const [binding] = await tx.select().from(hostingNodeBindings).where(eq(hostingNodeBindings.nodeId, node.id));
      if (binding && (binding.resourceId !== resource.id || binding.hostIdentityId !== node.hostIdentityId))
        throw new AppError(
          409,
          'HOSTING_RESOURCE_IDENTITY_CONFLICT',
          'Node is already bound to a different hosting resource'
        );
      await tx
        .update(hostingResources)
        .set({
          managedHostIdentity: node.hostIdentityId,
          origin: resource.origin === 'created' ? 'created' : row.action === 'install' ? 'adopted' : 'created',
        })
        .where(eq(hostingResources.id, resource.id));
      await tx
        .insert(hostingNodeBindings)
        .values({
          nodeId: node.id,
          resourceId: resource.id,
          hostIdentityId: node.hostIdentityId!,
          evidenceType: 'created_operation',
          evidenceDigest: row.requestHash,
          observedAt: new Date(),
        })
        .onConflictDoNothing({ target: hostingNodeBindings.nodeId });
    });
    if (row.action === 'create' && row.encryptedBootstrap && adapter.cleanupBootstrap) {
      const payload = this.payload(row);
      if (payload.create.proxmox?.seedStorage) {
        const [stored] = await this.db.select().from(hostingResources).where(eq(hostingResources.id, row.resourceId));
        const current = stored ? await adapter.getResource(stored.remoteId) : null;
        if (!current || current.incarnation !== stored.incarnation)
          throw new AppError(409, 'HOSTING_RESOURCE_IDENTITY_CONFLICT', 'Bootstrap cleanup resource changed');
        await adapter.cleanupBootstrap(current, payload.create);
      }
    }
    await this.sshInstall.finish(adapter, row, 'ready', { nodeId: node.id, resourceId: row.resourceId });
    return true;
  }

  /**
   * A relay enrolls over its outbound control connection even when its relay port is closed, and nodes then
   * cannot use it. The operation finishes only once the advertised address answers on the relay port; until
   * then it says what to open, and on expiry it fails with that reason.
   */
  private async relayPortAnswers(row: HostingOperationRow): Promise<boolean> {
    const request = acceptedProvisionInput(row.request);
    if (request.role !== 'relay' || !request.relayAddress) return true;
    const endpoint = relayEndpoint(request.relayAddress, request.relayServicePort ?? DEFAULT_RELAY_SERVICE_PORT);
    if (await tcpAnswers(endpoint.host, endpoint.port, RELAY_PORT_PROBE_TIMEOUT_MS)) {
      if (row.errorCode === 'HOSTING_RELAY_PORT_UNREACHABLE')
        await this.operations.update(row, { errorCode: null, errorMessage: null });
      return true;
    }
    if (row.errorCode !== 'HOSTING_RELAY_PORT_UNREACHABLE')
      await this.operations.update(row, {
        errorCode: 'HOSTING_RELAY_PORT_UNREACHABLE',
        errorMessage: relayPortUnreachableMessage(endpoint.label),
      });
    return false;
  }

  private cloudInitOwnsInstallation(row: HostingOperationRow, connector: HostingConnectorRow) {
    return (
      row.action === 'create' &&
      connector.provider !== 'cloudblast' &&
      (connector.provider !== 'proxmox' || Boolean(this.payload(row).create.proxmox?.imageStorage))
    );
  }

  private async enrollmentObserved(row: HostingOperationRow) {
    if (!row.nodeId) return false;
    if (this.dispatch.isNodeConnected(row.nodeId)) return true;
    const [node] = await this.db.select().from(nodes).where(eq(nodes.id, row.nodeId));
    return Boolean(node?.certificateFingerprint && !node.enrollmentTokenHash);
  }

  private async stepCreate(
    row: HostingOperationRow,
    connector: HostingConnectorRow,
    adapter: HostingProviderAdapter,
    actor: User,
    signal?: AbortSignal
  ) {
    // One-time SSH install keys: finish deferred outcomes and retry pending key cleanups first.
    const resumed = await this.sshInstall.resume(row, adapter, () =>
      row.encryptedBootstrap ? this.payload(row).ssh : undefined
    );
    row = resumed.row;
    if (resumed.done) return;
    const [node] = row.nodeId
      ? await this.db.select({ id: nodes.id }).from(nodes).where(eq(nodes.id, row.nodeId)).limit(1)
      : [];
    if (!node) {
      if (row.action === 'create' && !row.resourceId && row.dispatchStartedAt) {
        await this.operations.update(row, {
          phase: 'unknown',
          errorCode: 'HOSTING_NODE_MISSING',
          errorMessage:
            'The Opfield node was removed while the provider create outcome remains unconfirmed. No replacement VM will be ordered; inspect the provider and reconcile this operation.',
        });
        return;
      }
      await this.sshInstall.finish(
        adapter,
        row,
        'failed',
        row.resourceId ? { resourceId: row.resourceId } : undefined,
        {
          code: 'HOSTING_NODE_MISSING',
          message:
            'The Opfield node was removed before provisioning finished. No further provisioning will be attempted; check the provider VM before recovering or removing it.',
        }
      );
      return;
    }
    if (await this.enrolled(row, connector, actor, adapter)) return;
    if (row.bootstrapExpiresAt && row.bootstrapExpiresAt.getTime() < Date.now()) {
      if (row.nodeId)
        await this.db
          .update(nodes)
          .set({ enrollmentTokenHash: null, enrollmentTokenSelector: null })
          .where(and(eq(nodes.id, row.nodeId), eq(nodes.status, 'pending')));
      // Keep the paid resource visible and retain the write boundary even when installation expires.
      if (row.resourceId || (row.phase === 'pending' && !row.dispatchStartedAt)) {
        await this.sshInstall.finish(
          adapter,
          row,
          'failed',
          undefined,
          row.errorCode === 'HOSTING_RELAY_PORT_UNREACHABLE'
            ? { code: 'HOSTING_RELAY_PORT_UNREACHABLE', message: row.errorMessage ?? 'The relay port does not answer' }
            : {
                code: 'HOSTING_BOOTSTRAP_EXPIRED',
                message: 'Installation expired; retry installation on this VM without ordering a replacement',
              }
        );
        return;
      } else
        row = await this.operations.update(row, {
          phase: 'unknown',
          encryptedBootstrap: null,
          errorCode: 'HOSTING_BOOTSTRAP_EXPIRED',
          errorMessage: 'Creation outcome is unknown; no replacement VM will be ordered',
        });
    }
    if (row.phase === 'pending') {
      await this.authorizeBootstrap(row, connector, actor);
      if (row.action === 'install') {
        await this.operations.update(row, { phase: 'provisioning' });
        return;
      }
      const payload = this.payload(row);
      await adapter.validateCreate?.(payload.create);
      assertHostingQuote(
        acceptedProvisionInput(row.request),
        await adapter.catalog(),
        connector.provider === 'proxmox'
      );
      const dispatchCreate = async (excludedRemoteIds?: string[]) => {
        await this.operations.renew(row);
        row = await this.operations.dispatch(row, 'dispatching');
        const providerOperation = await adapter.create({
          ...payload.create,
          ...(excludedRemoteIds ? { excludedRemoteIds } : {}),
        });
        await this.operations.update(row, {
          phase: providerOperation.status === 'awaiting_payment' ? 'awaiting_payment' : 'provisioning',
          providerOperation,
          errorCode: null,
          errorMessage: null,
        });
      };
      if (connector.provider === 'proxmox') {
        const authority = this.connectors.settings(connector).authority;
        await this.db.transaction(async (tx) => {
          const lock = await tx.execute<{ acquired: boolean }>(
            sql`SELECT pg_try_advisory_xact_lock(hashtext(${`hosting-create:${authority}`})) AS acquired`
          );
          if (!lock.rows[0]?.acquired) return;
          const historical = await tx
            .select({ remoteId: hostingResources.remoteId })
            .from(hostingResources)
            .where(and(eq(hostingResources.provider, 'proxmox'), eq(hostingResources.authority, authority)));
          const prior = await tx
            .select({
              phase: hostingOperations.phase,
              dispatchStartedAt: hostingOperations.dispatchStartedAt,
              resourceId: hostingOperations.resourceId,
              providerOperation: hostingOperations.providerOperation,
            })
            .from(hostingOperations)
            .where(
              and(
                eq(hostingOperations.connectorId, connector.id),
                eq(hostingOperations.action, 'create'),
                ne(hostingOperations.id, row.id)
              )
            );
          // A timed-out clone may still be reserving its ID. Wait for its marker reconciliation.
          if (
            prior.some(
              (operation) =>
                operation.dispatchStartedAt &&
                !operation.resourceId &&
                !operation.providerOperation?.resourceId &&
                !['ready', 'failed'].includes(operation.phase)
            )
          )
            return;
          // A successful UPID response can precede inventory visibility. Its persisted remote ID
          // also remains reserved until the next runner tracks the canonical resource.
          await dispatchCreate([
            ...historical.map((resource) => resource.remoteId),
            ...prior.flatMap((operation) =>
              operation.providerOperation?.resourceId ? [operation.providerOperation.resourceId] : []
            ),
          ]);
        });
      } else await dispatchCreate();
      return;
    }
    if (
      connector.provider === 'hostkey' &&
      row.action === 'create' &&
      row.dispatchStartedAt &&
      !row.resourceId &&
      !row.providerOperation?.resourceId &&
      !row.providerOperation?.id &&
      !row.providerOperation?.invoiceId &&
      adapter.findOrderInvoice
    ) {
      const invoiceId = await adapter.findOrderInvoice(`gw-${row.id}`);
      if (invoiceId)
        row = await this.operations.update(row, {
          providerOperation: { ...row.providerOperation, id: null, invoiceId, status: 'awaiting_payment' },
          phase: 'awaiting_payment',
        });
    }
    if (
      connector.provider === 'hostkey' &&
      row.action === 'create' &&
      row.providerOperation?.status === 'awaiting_payment'
    ) {
      if (!row.providerOperation.invoiceId || !adapter.invoice) return;
      const invoiceId = row.providerOperation.invoiceId;
      const quote = acceptedProvisionInput(row.request).confirmedPrice;
      if (!quote)
        throw new AppError(
          409,
          'HOSTING_PRICE_UNAVAILABLE',
          'The accepted order has no confirmed price; invoice payment cannot be verified'
        );
      const readInvoice = () =>
        adapter.orderInvoice ? adapter.orderInvoice(invoiceId, `gw-${row.id}`, quote) : adapter.invoice!(invoiceId);
      let invoice = await readInvoice();
      if (['cancelled', 'canceled', 'refunded', 'collections'].includes(invoice.status)) {
        await this.sshInstall.finish(adapter, row, 'failed', undefined, {
          code: 'HOSTING_ORDER_INVOICE_CANCELLED',
          message:
            'HOSTKEY order invoice was cancelled or closed; no credit will be applied and no replacement VM will be ordered',
        });
        return;
      }
      if (invoice.status !== 'paid') {
        if (row.result?.creditPayment) {
          if ((row.result.creditPayment as Record<string, unknown>).status === 'rejected') {
            await this.operations.update(row, {
              phase: 'awaiting_payment',
              errorCode: 'HOSTING_CREDIT_PAYMENT_REJECTED',
              errorMessage: CREDIT_REJECTED_MESSAGE,
            });
            return;
          }
          await this.operations.update(row, {
            phase: 'awaiting_payment',
            errorCode: 'HOSTING_CREDIT_PAYMENT_PENDING',
            errorMessage:
              'Waiting for HOSTKEY to confirm the invoice payment; account credit will not be applied a second time',
          });
          return;
        }
        if (!row.encryptedBootstrap || !row.bootstrapExpiresAt || row.bootstrapExpiresAt.getTime() <= Date.now())
          return;
        if (!adapter.payOrderInvoice) return;
        try {
          await adapter.payOrderInvoice(invoiceId, `gw-${row.id}`, quote, async (payment) => {
            const currentConnector = await this.connectors.get(connector.id, undefined, true);
            if (currentConnector.updatedAt?.getTime() !== connector.updatedAt?.getTime())
              throw new AppError(409, 'HOSTING_CONNECTOR_CHANGED', 'Hosting connector changed before invoice payment');
            await this.authorizeBootstrap(row, currentConnector, await this.actor(row, currentConnector));
            await this.operations.renew(row);
            row = await this.operations.dispatchOrderCredit(row, currentConnector, payment);
          });
        } catch (error) {
          if (row.result?.creditPayment && error instanceof HostingProviderError && !error.outcomeUnknown) {
            row = await this.operations.update(row, {
              phase: 'awaiting_payment',
              errorCode: 'HOSTING_CREDIT_PAYMENT_REJECTED',
              errorMessage: CREDIT_REJECTED_MESSAGE,
              result: {
                ...row.result,
                creditPayment: { ...(row.result.creditPayment as Record<string, unknown>), status: 'rejected' },
              },
            });
            return;
          }
          throw error;
        }
        invoice = await readInvoice();
        if (invoice.status !== 'paid') return;
      }
      // WHMCS invoice item relids are service identifiers, not verified VM identifiers.
      // A paid invoice only authorizes reconciliation of this already-dispatched order.
      row = await this.operations.update(row, {
        providerOperation: { ...row.providerOperation, status: 'running' },
        ...(row.encryptedBootstrap ? { phase: 'provisioning', errorCode: null, errorMessage: null } : {}),
      });
    }
    let hostkeyCallbackPolled = false;
    if (connector.provider === 'hostkey' && row.action === 'create' && row.providerOperation?.id) {
      if (row.providerOperation.status === 'failed') {
        await this.sshInstall.finish(
          adapter,
          row,
          'failed',
          row.resourceId ? { resourceId: row.resourceId } : undefined,
          {
            code: 'HOSTING_PROVIDER_TASK_FAILED',
            message: row.providerOperation.error ?? 'Provider task failed; VM was not deleted',
          }
        );
        return;
      }
      if (row.providerOperation.status !== 'succeeded') {
        hostkeyCallbackPolled = true;
        const callback = await adapter.operation(row.providerOperation.id, row.providerOperation.resourceId);
        const providerOperation = {
          ...row.providerOperation,
          ...callback,
          ...(callback.resourceId === undefined ? { resourceId: row.providerOperation.resourceId } : {}),
        };
        if (callback.status === 'failed') {
          row = await this.operations.update(row, { providerOperation });
          await this.sshInstall.finish(
            adapter,
            row,
            'failed',
            row.resourceId ? { resourceId: row.resourceId } : undefined,
            {
              code: 'HOSTING_PROVIDER_TASK_FAILED',
              message: callback.error ?? 'Provider task failed; VM was not deleted',
            }
          );
          return;
        }
        row = await this.operations.update(row, {
          providerOperation,
          ...(row.encryptedBootstrap ? { phase: 'provisioning', errorCode: null, errorMessage: null } : {}),
        });
        if (callback.status !== 'succeeded') return;
      }
    }
    let resource: HostingResourceSnapshot | null = null;
    if (row.resourceId) {
      const [stored] = await this.db.select().from(hostingResources).where(eq(hostingResources.id, row.resourceId));
      if (stored) resource = await adapter.getResource(stored.remoteId);
      if (stored?.incarnation && resource?.incarnation !== stored.incarnation)
        throw new AppError(409, 'HOSTING_RESOURCE_IDENTITY_CONFLICT', 'Resource identity changed');
      if (stored && resource)
        await this.db
          .update(hostingResources)
          .set({
            snapshot: withKnownLocation(resource, stored.snapshot.location),
            observedAt: new Date(resource.observedAt),
          })
          .where(eq(hostingResources.id, stored.id));
    } else if (row.providerOperation?.resourceId) {
      try {
        resource = await adapter.getResource(row.providerOperation.resourceId);
      } catch (error) {
        // A successful HOSTKEY callback can precede VM inventory visibility. Keep its
        // callback and dispatch fence intact; the next tick will reconcile the same order.
        if (
          connector.provider === 'hostkey' &&
          row.action === 'create' &&
          row.providerOperation.status === 'succeeded' &&
          error instanceof HostingProviderError &&
          error.providerStatus === 404
        )
          return;
        throw error;
      }
    } else {
      const inventory = await adapter.listResources();
      if (!inventory.complete) return;
      const matches = inventory.resources.filter((resource) => resource.marker === `gw-${row.id}`);
      if (matches.length === 1) resource = matches[0];
      else {
        if (
          matches.length === 0 &&
          connector.provider === 'hostkey' &&
          row.action === 'create' &&
          (row.providerOperation?.status === 'running' || row.providerOperation?.status === 'succeeded')
        ) {
          // A successful complete read supersedes a previous inventory read error.
          // Waiting for this accepted order to appear is not a new create attempt.
          // Keep expired bootstrap and other uncertain-write diagnostics intact.
          if (row.encryptedBootstrap && row.phase === 'unknown' && row.errorCode === 'HOSTING_PROVIDER_ERROR') {
            await this.operations.update(row, {
              phase: 'provisioning',
              errorCode: null,
              errorMessage: null,
            });
          }
          return;
        }
        await this.operations.update(row, {
          phase: 'unknown',
          errorCode: row.errorCode ?? 'HOSTING_CREATE_OUTCOME_UNKNOWN',
          errorMessage:
            row.errorMessage ?? 'The provider request outcome is not confirmed. No second VM will be ordered.',
        });
        return;
      }
    }
    if (!resource) {
      // The provider create task itself failed and no VM exists: retry a lock timeout, otherwise fail with its error.
      if (
        connector.provider === 'proxmox' &&
        row.action === 'create' &&
        !row.resourceId &&
        row.providerOperation?.id &&
        !row.providerOperation.preparationStage
      ) {
        const task = await adapter.operation(row.providerOperation.id, row.providerOperation.resourceId);
        if (task.status !== 'failed') return;
        const retried = transientTaskRetry(row, task);
        if (retried) {
          await this.operations.update(row, { ...retried, phase: 'pending' });
          return;
        }
        // A failed create task with no VM reserved nothing at the provider: release its quota and VM ID.
        row = await this.operations.update(row, { dispatchStartedAt: null });
        await this.sshInstall.finish(adapter, row, 'failed', undefined, {
          code: 'HOSTING_PROVIDER_TASK_FAILED',
          message: `${task.error ?? 'Provider task failed'}. No VM was created.`,
        });
      }
      return;
    }
    if (!row.resourceId) {
      const tracked = await this.trackResource(row, connector, resource);
      if (row.action === 'create')
        await grantCreatedResourcePermissions(
          row.actorId,
          'hosting:resources',
          row.nodeId ? `node/${row.nodeId}` : tracked.id
        );
      row = await this.operations.update(row, {
        resourceId: tracked.id,
        phase: 'provisioning',
        ...(connector.provider === 'hostkey' && row.action === 'create'
          ? { providerOperation: null, dispatchStartedAt: null }
          : {}),
      });
    }
    if (!row.encryptedBootstrap) {
      await this.sshInstall.finish(adapter, row, 'failed', undefined, {
        code: 'HOSTING_BOOTSTRAP_EXPIRED',
        message:
          'The existing provider VM was recovered after installation expired. Retry installation without ordering another VM.',
      });
      return;
    }
    const stage = row.result?.dispatchStage;
    if (
      row.phase === 'unknown' &&
      row.errorCode === 'HOSTING_INSTALL_TRANSPORT_REQUIRED' &&
      stage === 'installing' &&
      !row.providerOperation?.id
    ) {
      // Older runners fenced before checking transport availability. This exact local
      // pre-dispatch error proves no installer was sent; it is safe to keep waiting for QGA.
      row = await this.operations.update(row, {
        phase: 'provisioning',
        dispatchStartedAt: null,
        errorCode: null,
        errorMessage: null,
      });
    }
    if (row.phase === 'unknown' && row.dispatchStartedAt) {
      const preparationDispatch = row.result?.preparationDispatch;
      if (
        !row.providerOperation?.id &&
        adapter.reconcilePreparation &&
        ['image', 'seed', 'disk', 'boot', 'firewall', 'network', 'start'].includes(String(preparationDispatch))
      ) {
        const recovered = await adapter.reconcilePreparation(
          resource,
          this.payload(row).create,
          preparationDispatch as NonNullable<HostingCreateRequest['preparationStage']>,
          Number(row.result?.preparationSince)
        );
        if (!recovered) return;
        row = await this.operations.update(
          row,
          recovered.status === 'succeeded'
            ? {
                phase: 'provisioning',
                providerOperation: null,
                dispatchStartedAt: null,
                result: { ...row.result, preparationStage: preparationDispatch },
              }
            : { phase: 'configuring', providerOperation: recovered }
        );
      }
      if (
        row.phase === 'unknown' &&
        !row.providerOperation?.id &&
        (stage === 'installing' || stage === 'configuring' || row.action === 'install')
      )
        return;
      // A known task can be polled, but an uncertain installer must never be dispatched again.
      if (stage === 'installing' || stage === 'configuring') row = await this.operations.update(row, { phase: stage });
    }
    if (
      row.providerOperation?.id &&
      !hostkeyCallbackPolled &&
      !(connector.provider === 'hostkey' && row.action === 'create')
    ) {
      const completedStage = row.providerOperation.preparationStage;
      const task = await adapter.operation(row.providerOperation.id, resource.remoteId);
      if (task.status === 'failed') {
        // A preparation step that timed out waiting for a host lock changed nothing: send the same step again.
        if (completedStage && row.action === 'create') {
          const retried = transientTaskRetry(row, task);
          if (retried) {
            await this.operations.update(row, { ...retried, phase: 'provisioning' });
            return;
          }
        }
        await this.sshInstall.finish(
          adapter,
          row,
          'failed',
          { resourceId: row.resourceId },
          { code: 'HOSTING_PROVIDER_TASK_FAILED', message: task.error ?? 'Provider task failed; VM was not deleted' }
        );
        return;
      }
      if (task.status !== 'succeeded') return;
      row = await this.operations.update(row, {
        providerOperation: null,
        dispatchStartedAt: null,
        ...(row.providerOperation.preparationStage
          ? { result: { ...row.result, preparationStage: row.providerOperation.preparationStage } }
          : {}),
      });
      if (completedStage === 'start') {
        await this.operations.update(row, { phase: 'provisioning' });
        return; // The snapshot predates task completion. Read fresh power state on the next tick.
      }
    }
    if (row.phase === 'configuring' && resource.powerState === 'running')
      row = await this.operations.update(row, { phase: 'provisioning', dispatchStartedAt: null });
    if (connector.provider === 'proxmox' && row.action === 'create' && resource.powerState !== 'running') {
      if (row.result?.preparationStage === 'start') return;
      if (!adapter.prepare)
        throw new AppError(409, 'HOSTING_BOOTSTRAP_UNSUPPORTED', 'Provider preparation is unavailable');
      if (row.phase === 'configuring' && row.dispatchStartedAt) {
        // The absolute config/start outcome is reconciled by current power state; never clone again.
        return;
      }
      await this.authorizeBootstrap(row, connector, actor);
      row = await this.operations.update(row, { dispatchStartedAt: null });
      row = await this.operations.dispatch(row, 'configuring');
      const task = await adapter.prepare(resource, {
        ...this.payload(row).create,
        preparationStage: row.result?.preparationStage as HostingCreateRequest['preparationStage'],
        beforePreparation: async (preparationDispatch) => {
          row = await this.operations.update(row, {
            result: { ...row.result, preparationDispatch, preparationSince: Math.floor(Date.now() / 1000) - 1 },
          });
        },
      });
      await this.operations.update(
        row,
        task.status === 'succeeded' && !task.id && task.preparationStage
          ? {
              providerOperation: null,
              dispatchStartedAt: null,
              phase: 'provisioning',
              result: { ...row.result, preparationStage: task.preparationStage },
            }
          : { providerOperation: task }
      );
      return;
    }
    if (row.phase === 'installing') {
      if (this.cloudInitOwnsInstallation(row, connector)) {
        if (await this.enrollmentObserved(row)) {
          await this.operations.update(row, { phase: 'enrolling' });
          return;
        }
        // An installer that failed ends the operation with its own error; one that never reports ends at the
        // bootstrap deadline (bootstrapExpiresAt, checked above on every pass).
        const content = adapter.installResult ? await adapter.installResult(resource) : null;
        const result = content ? parseHostingInstallResult(content) : null;
        if (result && result.marker === `gw-${row.id}` && result.exitCode !== 0) {
          if (row.nodeId)
            await this.db
              .update(nodes)
              .set({ enrollmentTokenHash: null, enrollmentTokenSelector: null })
              .where(and(eq(nodes.id, row.nodeId), eq(nodes.status, 'pending')));
          await this.sshInstall.finish(adapter, row, 'failed', undefined, {
            code: 'HOSTING_INSTALL_FAILED',
            message: hostingInstallFailureMessage(result),
          });
        }
        return;
      }
      // Installer completion is not proof that the daemon has contacted Opfield.
      if (!row.dispatchStartedAt && (await this.enrollmentObserved(row))) {
        await this.operations.update(row, { phase: 'enrolling' });
        return;
      }
      // A dispatched SSH install that runs in no session of this process lost it with an Opfield restart: the guest's
      // installer died with the session (SIGHUP) and never reports. Send it once more with the same one-time key;
      // the bootstrap's lock and clean-host checks stop a second copy. A second loss, or an old one whose enrollment
      // token expired, fails so it can be retried by hand.
      if (
        row.dispatchStartedAt &&
        connector.provider === 'cloudblast' &&
        row.action === 'create' &&
        !this.sshInstall.isInFlight(row.id) &&
        !(await this.enrollmentObserved(row))
      ) {
        const state = sshInstallState(row);
        const expired = Date.now() - row.dispatchStartedAt.getTime() > SSH_INSTALL_OUTCOME_TIMEOUT_MS;
        if (state && !state.redispatched && !expired && row.encryptedBootstrap) {
          await this.operations.update(row, {
            phase: 'provisioning',
            dispatchStartedAt: null,
            errorCode: 'HOSTING_SSH_INSTALL_WAITING',
            errorMessage: 'Installing again: Opfield restarted during the installation',
            result: { ...row.result, sshInstall: { ...state, redispatched: true } },
          });
          return;
        }
        await this.sshInstall.finish(adapter, row, 'failed', undefined, {
          code: 'HOSTING_INSTALL_OUTCOME_UNKNOWN',
          message:
            'The installation session ended without a result (Opfield restarted during it) and the node never enrolled. Retry installation on this VM.',
        });
      }
      return;
    }
    if (row.phase === 'enrolling') return;
    if (this.cloudInitOwnsInstallation(row, connector)) {
      if (resource.powerState !== 'running') return;
      // Cloud-init executes the role installer. Never also dispatch it through QGA.
      await this.operations.update(row, {
        phase: 'installing',
        dispatchStartedAt: null,
        errorCode: null,
        errorMessage: null,
      });
      return;
    }
    if (resource.powerState !== 'running') return;
    if (connector.provider === 'cloudblast' && row.action === 'create') {
      const payload = this.payload(row);
      if (!payload.ssh)
        throw new AppError(409, 'HOSTING_INSTALL_TRANSPORT_REQUIRED', 'The one-time SSH install key is unavailable');
      await this.authorizeBootstrap(row, connector, actor);
      await this.sshInstall.install(
        row,
        resource,
        payload.ssh,
        () => this.sshInstallScript(row, connector),
        adapter,
        signal
      );
      return;
    }
    const input = acceptedProvisionInput(row.request);
    const guestBootstrap = Boolean(adapter.bootstrap && resource.capabilities.bootstrap.available);
    if (!guestBootstrap && !input.sshConnectorId) {
      if (resource.capabilities.bootstrap.reasonCode === 'permission_denied')
        throw new AppError(
          403,
          'HOSTING_PROVIDER_PERMISSION_REQUIRED',
          resource.capabilities.bootstrap.reason ?? 'Provider token cannot execute the installer'
        );
      if (connector.provider === 'proxmox' && row.action === 'create') {
        // Power-on completes before the guest agent is ready. Wait within the existing
        // bootstrap deadline, without reserving an installer dispatch that never happened.
        await this.operations.update(row, {
          phase: 'provisioning',
          dispatchStartedAt: null,
          errorCode: 'HOSTING_GUEST_AGENT_PENDING',
          errorMessage: resource.capabilities.bootstrap.reason ?? 'Waiting for the guest installation channel',
        });
        return;
      }
      throw new AppError(409, 'HOSTING_INSTALL_TRANSPORT_REQUIRED', 'A trusted installation transport is required');
    }
    const payload = this.payload(row);
    await this.authorizeBootstrap(row, connector, actor);
    if (
      row.action === 'install' &&
      !row.result?.retryOf &&
      adapter.guestIdentity &&
      (await adapter.guestIdentity(resource))
    )
      throw new AppError(
        409,
        'HOSTING_EXISTING_DAEMON',
        'This VM already has Opfield identity; wait for automatic adoption'
      );
    row = await this.operations.update(row, { dispatchStartedAt: null, errorCode: null, errorMessage: null });
    row = await this.operations.dispatch(row, 'installing');
    if (adapter.bootstrap && resource.capabilities.bootstrap.available) {
      await this.operations.update(row, { providerOperation: await adapter.bootstrap(resource, payload.script) });
    } else {
      if (!input.sshConnectorId)
        throw new AppError(409, 'HOSTING_INSTALL_TRANSPORT_REQUIRED', 'A trusted installation transport is required');
      // Existing SSH service pins the host key; never return its command/secret echo to the browser.
      let result: { exitCode: number | null; stdout: string; stderr: string };
      try {
        result = await this.ssh.executeForHosting(
          actor,
          input.sshConnectorId,
          payload.script,
          resource.addresses.filter((address) => address.direct).map((address) => address.ip),
          signal
        );
      } catch (error) {
        // Opfield shutdown ended the session: the dispatched installer's outcome is unknown, as
        // after a crash, so the operation waits for enrollment or its bootstrap deadline.
        if (isSshOperationCancelled(error)) return;
        throw error;
      }
      if (result.exitCode !== 0) {
        await this.sshInstall.finish(adapter, row, 'failed', undefined, installFailure(result));
        return;
      }
      await this.operations.update(row, {
        phase: (await this.enrollmentObserved(row)) ? 'enrolling' : 'installing',
        dispatchStartedAt: null,
      });
    }
  }

  /** Built at SSH dispatch time so the embedded token is fresh (30 min) instead of the reservation token. */
  private async sshInstallScript(row: HostingOperationRow, connector: HostingConnectorRow): Promise<string> {
    const input = acceptedProvisionInput(row.request);
    const opfieldAddress = (await this.nodeService.getOpfieldEnrollmentTargets()).public.address;
    if (!opfieldAddress)
      throw new AppError(409, 'HOSTING_OPFIELD_NOT_READY', 'Configure a reachable Opfield enrollment endpoint');
    validateHostingOpfieldAddress(opfieldAddress, connector.provider === 'proxmox');
    return buildHostingBootstrap({
      // SSH comes up while cloud-init still runs apt on the new server.
      waitForCloudInit: true,
      role: input.role,
      opfieldAddress,
      certificateFingerprint: await this.nodeService.getOpfieldEnrollmentCertificateFingerprint(),
      token: await rotateSshInstallToken(this.db, row.nodeId!),
      relayAddress: input.role === 'relay' ? input.relayAddress : undefined,
      relayServicePort: input.role === 'relay' ? input.relayServicePort : undefined,
      requireCleanHost: true,
      operationMarker: `gw-${row.id}`,
    });
  }

  /** The signal aborts on Opfield shutdown: no further operation is claimed and an SSH installer session ends. */
  async reconcileDue(signal?: AbortSignal) {
    for (const due of await this.operations.due()) {
      if (signal?.aborted) return;
      if (due.action !== 'create' && due.action !== 'install') continue;
      const row = await this.operations.claim(due.id);
      if (!row) continue;
      try {
        if (!row.connectorId) continue;
        const connector = await this.connectors.get(row.connectorId, undefined, true);
        const actor = await this.actor(row, connector);
        await this.stepCreate(
          row,
          connector,
          this.connectors.adapter(
            row.action === 'create'
              ? { ...connector, settings: { ...this.connectors.settings(connector), resourceIds: [] } }
              : connector,
            () => this.operations.renew(row)
          ),
          actor,
          signal
        );
      } catch (error) {
        if (
          error instanceof AppError &&
          ['HOSTING_OPERATION_LEASE_LOST', 'HOSTING_DISPATCH_ALREADY_STARTED'].includes(error.code)
        )
          continue;
        const [current] = await this.db.select().from(hostingOperations).where(eq(hostingOperations.id, row.id));
        const unknown = error instanceof HostingProviderError && error.outcomeUnknown;
        // Only an explicit rejection of the initial create can release the paid-intent fence.
        // Timeouts, transport failures and errors in subsequent preparation stay uncertain.
        const rejectedCreate =
          row.action === 'create' &&
          row.phase === 'pending' &&
          current?.result?.dispatchStage === 'dispatching' &&
          !current.resourceId &&
          !current.providerOperation &&
          error instanceof HostingProviderError &&
          !unknown &&
          [400, 401, 403, 404, 405, 413, 415, 422, 429].includes(error.providerStatus);
        // A failed read-back before start is a confirmed preparation failure, not an uncertain VM start.
        const invalidBoot =
          error instanceof AppError &&
          ['HOSTING_BOOT_ORDER_UNVERIFIED', 'HOSTING_INITIAL_FIREWALL_UNVERIFIED'].includes(error.code);
        const phase = !invalidBoot && !rejectedCreate && (unknown || current?.dispatchStartedAt) ? 'unknown' : 'failed';
        try {
          const code = error instanceof AppError ? error.code : 'HOSTING_OPERATION_FAILED';
          const message =
            error instanceof AppError
              ? error.message
              : 'Hosting operation failed; no automatic replacement was ordered';
          if (phase === 'failed') {
            if (current?.nodeId)
              await this.db
                .update(nodes)
                .set({ enrollmentTokenHash: null, enrollmentTokenSelector: null })
                .where(and(eq(nodes.id, current.nodeId), eq(nodes.status, 'pending')));
            await this.sshInstall.finish(undefined, current ?? row, 'failed', undefined, { code, message });
          } else await this.operations.update(row, { phase, errorCode: code, errorMessage: message });
        } catch {
          /* Lost lease: the current owner reconciles. */
        }
      } finally {
        let phase = row.phase;
        try {
          const [current] = await this.db.select().from(hostingOperations).where(eq(hostingOperations.id, row.id));
          phase = current?.phase ?? phase;
        } finally {
          await this.operations.release(row, phase === 'unknown' ? 60_000 : 5000);
        }
      }
    }
  }
}
