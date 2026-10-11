import { createHash, createPrivateKey, createPublicKey, X509Certificate } from 'node:crypto';
import { and, asc, eq, inArray, isNull, like, lte } from 'drizzle-orm';
import type { DrizzleClient, DrizzleExecutor } from '@/db/client.js';
import {
  certificateAuthorities,
  certificates,
  nginxCertificateAssets,
  nginxCertificateReplicas,
  nginxProxyHostDeployments,
  nodes,
  proxyHosts,
  sslCertificates,
} from '@/db/schema/index.js';
import { createChildLogger } from '@/lib/logger.js';
import { AppError } from '@/middleware/error-handler.js';
import { loadCertificateIssuerChainPem, loadIssuerChainPem } from '@/modules/pki/issuer-chain.js';
// proxy-host-lock has no imports of its own, so this adds no import cycle.
import { withProxyHostLock } from '@/modules/proxy/proxy-host-lock.js';
import type { CryptoService } from '@/services/crypto.service.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type { NginxConfigGenerator } from '@/services/nginx-config-generator.service.js';
import { nginxConfigRejection } from '@/services/nginx-config-rejection.js';
import type { NodeDispatchService } from '@/services/node-dispatch.service.js';

const logger = createChildLogger('NginxCertificateDistribution');

export const NGINX_CERTIFICATE_DISTRIBUTION_CAPABILITY = 'nginx_certificate_distribution_v2';
export const NGINX_CERTIFICATE_REPLICA_GRACE_MS = 24 * 60 * 60 * 1000;
/** First automatic retry of a failed replica push; doubles per failure. */
export const NGINX_CERTIFICATE_REPAIR_BASE_DELAY_MS = 5 * 60 * 1000;
export const NGINX_CERTIFICATE_REPAIR_MAX_DELAY_MS = 6 * 60 * 60 * 1000;
/** Prefix of the certificate status message for a renewal that did not reach every proxy host. */
export const SSL_DISTRIBUTION_ERROR_PREFIX = 'Distribution incomplete: ';
const LEGACY_DAEMON_REPLICA_MESSAGE =
  'The Nginx daemon must support TLS certificate distribution v2 before this TLS configuration can change';

export type CertificateReference = {
  type: 'ssl' | 'internal';
  id: string;
};

export type CertificatePaths = {
  sslCertPath: string | null;
  sslKeyPath: string | null;
  sslChainPath: string | null;
};

/** How a host apply reaches the node (reconnect resync: deferred reload, the bundle the node already runs kept). */
export type HostApplyOptions = {
  /** The node loads the change with the reload of its batch instead of at once. */
  deferReload?: boolean;
  /**
   * The node is re-sent a route it may already run: when its active deployment is this exact bundle and the
   * replica is ready on that version, only the config is sent (no key material, no new replica generation). The
   * full bundle follows when the node rejects that, e.g. because it lost the certificate files.
   */
  reuseActiveBundle?: boolean;
  /**
   * The route's maintenance state, for a node that keeps maintenance flags (see ProxyMaintenanceFlag in the proto);
   * undefined leaves the node's flag as it is.
   */
  maintenance?: boolean;
};

export type PreparedTlsCertificate = CertificatePaths & {
  assetId: string;
  nodeId: string;
  daemonCertId: string;
  version: string;
  fingerprint: string;
  certificatePem: Buffer;
  keyPem: Buffer;
  chainPem: Buffer;
};

type ProxyHostRow = typeof proxyHosts.$inferSelect;
type AssetRow = typeof nginxCertificateAssets.$inferSelect;

type DistributionStatus = {
  status: 'not_deployed' | 'ready' | 'pending' | 'failed' | 'daemon_update_required';
  replicaCount: number;
  readyReplicaCount: number;
  lastVerifiedAt: Date | null;
  error: string | null;
  replicas: Array<{
    nodeId: string;
    nodeName: string;
    nodeSlug: string | null;
    status: 'ready' | 'pending' | 'failed' | 'daemon_update_required';
    lastVerifiedAt: Date | null;
    error: string | null;
  }>;
};

type ReplicaRow = typeof nginxCertificateReplicas.$inferSelect;
type ReplicaChanges = Partial<typeof nginxCertificateReplicas.$inferInsert> & {
  incrementGeneration?: boolean;
  incrementRepairAttempts?: boolean;
};
type ReplicaNode = Pick<typeof nodes.$inferSelect, 'id' | 'hostname' | 'displayName' | 'slug'>;

function daemonCertId(reference: CertificateReference): string {
  return reference.type === 'internal' ? `internal-${reference.id}` : reference.id;
}

function referenceForHost(
  host: Pick<ProxyHostRow, 'sslEnabled' | 'sslCertificateId' | 'internalCertificateId'>
): CertificateReference | null {
  if (!host.sslEnabled) return null;
  if (host.sslCertificateId) return { type: 'ssl', id: host.sslCertificateId };
  if (host.internalCertificateId) return { type: 'internal', id: host.internalCertificateId };
  return null;
}

function fingerprintFor(certificatePem: string, keyPem: string, chainPem: string | null): string {
  const fullchainPem = chainPem
    ? `${certificatePem}${certificatePem.endsWith('\n') ? '' : '\n'}${chainPem}`
    : certificatePem;
  return createHash('sha256')
    .update(fullchainPem)
    .update('\u0000')
    .update(keyPem)
    .update('\u0000')
    .update(chainPem ?? '')
    .digest('hex');
}

function deploymentGenerationFor(
  hostId: string,
  nodeId: string,
  configContent: string,
  certificateVersion: string
): string {
  return createHash('sha256')
    .update(hostId)
    .update('\u0000')
    .update(nodeId)
    .update('\u0000')
    .update(configContent)
    .update('\u0000')
    .update(certificateVersion)
    .digest('hex');
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, '[redacted PEM]')
    .replace(/\/(?:etc|var|tmp|home|opt|usr|run|srv)(?:\/[^\s,:;"')\]]+)+/g, '[redacted path]')
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 500);
}

function nodeHasDistributionCapability(capabilities: unknown): boolean {
  const value = capabilities as Record<string, unknown> | null | undefined;
  const reported = value?.capabilities;
  return Array.isArray(reported) && reported.includes(NGINX_CERTIFICATE_DISTRIBUTION_CAPABILITY);
}

function repairDelayMs(repairAttempts: number): number {
  return Math.min(
    NGINX_CERTIFICATE_REPAIR_BASE_DELAY_MS * 2 ** Math.max(0, Math.min(repairAttempts, 16)),
    NGINX_CERTIFICATE_REPAIR_MAX_DELAY_MS
  );
}

/** A failed/pending replica is retried only after its backoff elapsed. */
/** A legacy replica that received an older version than the canonical Gateway asset. */
function isLegacyReplicaOutdated(
  replica: Pick<ReplicaRow, 'appliedVersion' | 'desiredVersion'>,
  asset: Pick<AssetRow, 'state' | 'version'>
): boolean {
  if (replica.desiredVersion && replica.desiredVersion !== replica.appliedVersion) return true;
  return !!(
    asset.state === 'ready' &&
    asset.version &&
    replica.appliedVersion &&
    replica.appliedVersion !== asset.version
  );
}

function isRepairDue(replica: Pick<ReplicaRow, 'repairAttempts' | 'updatedAt'>, now = Date.now()): boolean {
  return now - replica.updatedAt.getTime() >= repairDelayMs(replica.repairAttempts ?? 0);
}

function stableNodeOrder(nodeIds: Array<string | null | undefined>): string[] {
  return [...new Set(nodeIds.filter((id): id is string => Boolean(id)))].sort();
}

function deployedReplicasOnly<T extends Pick<ReplicaRow, 'cleanupAfter' | 'status'>>(replicas: T[]): T[] {
  return replicas.filter((replica) => replica.cleanupAfter === null && replica.status !== 'cleanup_pending');
}

/**
 * Owns the Gateway-side canonical asset and all node-local replica lifecycle.
 * No caller receives private material; it is used only to form a bounded daemon
 * command over the existing mTLS control stream.
 */
export class NginxCertificateDistributionService {
  private eventBus?: EventBusService;
  private legacyHostConfigReapplier?: (hostId: string) => Promise<void>;

  constructor(
    private readonly db: DrizzleClient,
    private readonly cryptoService: CryptoService,
    private readonly configGenerator: NginxConfigGenerator,
    private readonly nodeDispatch: NodeDispatchService
  ) {}

  setEventBus(eventBus: EventBusService) {
    this.eventBus = eventBus;
  }

  /** Re-renders a host config (and so reloads nginx) after a legacy certificate push. */
  setLegacyHostConfigReapplier(reapplier: (hostId: string) => Promise<void>) {
    this.legacyHostConfigReapplier = reapplier;
  }

  /**
   * Delivers Gateway material to a daemon without TLS distribution v2 using
   * the legacy deployCert command, which writes the fixed legacy paths the
   * host config already references, then re-applies the host config(s) so
   * nginx reloads. Returns `not_legacy` when the node has the v2 capability
   * (its reconnect reconciliation delivers bundles). A failure is recorded on
   * the replica, which periodic reconciliation retries, and is thrown.
   */
  async deployLegacyCertificateForHost(
    host: Pick<ProxyHostRow, 'id' | 'sslEnabled' | 'sslCertificateId' | 'internalCertificateId' | 'nodeId'>,
    options: { reapplyHostIds?: string[] } = {}
  ): Promise<'delivered' | 'not_legacy'> {
    const reference = referenceForHost(host);
    if (!reference) return 'not_legacy';
    const nodeId = await this.nodeDispatch.resolveNodeId(host.nodeId);
    const node = await this.getNode(nodeId);
    if (!node || node.type !== 'nginx' || nodeHasDistributionCapability(node.capabilities)) return 'not_legacy';

    const material = await this.loadGatewayMaterial(reference);
    const version = fingerprintFor(material.certificatePem, material.keyPem, material.chainPem);
    const asset = (await this.findAsset(reference)) ?? (await this.upsertGatewayAsset(reference));
    try {
      if (node.status !== 'online' || !this.nodeDispatch.isNodeConnected(nodeId)) {
        throw new Error('The Nginx node is offline; the certificate is delivered after it reconnects');
      }
      // The legacy daemon writes privkey.pem and then restricts it to 0600;
      // the command carries no mode, so the file mode is daemon-controlled.
      const result = await this.nodeDispatch.deployCertificate(
        nodeId,
        daemonCertId(reference),
        Buffer.from(material.certificatePem),
        Buffer.from(material.keyPem),
        material.chainPem ? Buffer.from(material.chainPem) : undefined
      );
      if (!result.success) throw new Error(result.error || 'Legacy certificate deploy failed');
      // nginx keeps serving the previous files until the config is reloaded.
      if (!this.legacyHostConfigReapplier) {
        throw new Error('The host configuration could not be re-applied to reload nginx');
      }
      for (const hostId of options.reapplyHostIds ?? [host.id]) {
        await this.legacyHostConfigReapplier(hostId);
      }
    } catch (error) {
      await this.markReplicaById(asset.id, nodeId, {
        status: 'failed',
        desiredVersion: version,
        cleanupAfter: null,
        lastError: safeError(error),
      });
      this.emitReferenceChanged(reference);
      throw new AppError(
        502,
        'NGINX_TLS_LEGACY_DEPLOY_FAILED',
        `The certificate could not be delivered to the legacy Nginx daemon: ${safeError(error)}`
      );
    }
    await this.markReplicaById(asset.id, nodeId, {
      status: 'daemon_update_required',
      desiredVersion: version,
      appliedVersion: version,
      observedFingerprint: version,
      cleanupAfter: null,
      lastError: LEGACY_DAEMON_REPLICA_MESSAGE,
      lastVerifiedAt: new Date(),
    });
    this.emitReferenceChanged(reference);
    return 'delivered';
  }

  referenceForHost(host: Pick<ProxyHostRow, 'sslEnabled' | 'sslCertificateId' | 'internalCertificateId'>) {
    return referenceForHost(host);
  }

  async supportsNode(nodeId: string | null): Promise<boolean> {
    const resolvedNodeId = await this.nodeDispatch.resolveNodeId(nodeId);
    const node = await this.getNode(resolvedNodeId);
    return !!(node?.type === 'nginx' && node.status === 'online' && nodeHasDistributionCapability(node.capabilities));
  }

  /**
   * Render-time lookup. It never contacts a daemon or promotes a legacy
   * source, so opening a detail page cannot mutate the TLS fleet.
   */
  async peekPathsForHost(
    host: Pick<ProxyHostRow, 'sslEnabled' | 'sslCertificateId' | 'internalCertificateId'>
  ): Promise<CertificatePaths> {
    const reference = referenceForHost(host);
    if (!reference) return this.emptyPaths();
    const asset = await this.findAsset(reference);
    if (asset?.state === 'ready' && asset.version) {
      return this.versionedPaths(daemonCertId(reference), !!this.decryptAsset(asset).chainPem);
    }
    return this.legacyPathsForHost(host);
  }

  /** Legacy path lookup used only to preserve existing hosts on an old daemon. */
  async legacyPathsForHost(
    host: Pick<ProxyHostRow, 'sslEnabled' | 'sslCertificateId' | 'internalCertificateId'>
  ): Promise<CertificatePaths> {
    const reference = referenceForHost(host);
    if (!reference) return this.emptyPaths();
    if (reference.type === 'internal') return this.legacyPaths(daemonCertId(reference), false);
    const certificate = await this.db.query.sslCertificates.findFirst({
      where: eq(sslCertificates.id, reference.id),
      columns: { chainPem: true },
    });
    return this.legacyPaths(daemonCertId(reference), !!certificate?.chainPem);
  }

  /** Ensure canonical material and an eligible node before a TLS config is activated. */
  async prepareForHost(
    host: Pick<ProxyHostRow, 'sslEnabled' | 'sslCertificateId' | 'internalCertificateId' | 'nodeId'>
  ): Promise<PreparedTlsCertificate | null> {
    const reference = referenceForHost(host);
    if (!reference) return null;
    const targetNodeId = await this.nodeDispatch.resolveNodeId(host.nodeId);

    let asset = await this.findAsset(reference);
    if (!asset) {
      // Assets created after the migration snapshot are v2 and originate from
      // Gateway material, never a daemon export.
      asset = await this.upsertGatewayAsset(reference);
    }

    await this.assertNodeSupportsDistribution(targetNodeId, asset);
    if (asset.format === 'legacy' || asset.state !== 'ready' || !asset.encryptedMaterial || !asset.version) {
      asset = await this.importLegacyAsset(reference, asset, targetNodeId);
    }

    const material = this.decryptAsset(asset);
    return {
      ...this.versionedPaths(daemonCertId(reference), !!material.chainPem),
      assetId: asset.id,
      nodeId: targetNodeId,
      daemonCertId: daemonCertId(reference),
      version: material.version,
      fingerprint: material.fingerprint,
      certificatePem: Buffer.from(material.certificatePem),
      keyPem: Buffer.from(material.keyPem),
      chainPem: Buffer.from(material.chainPem ?? ''),
    };
  }

  /** Deploy a certificate for a daemon-owned Pages preview config without exposing private material. */
  async deployForPages(
    nodeId: string,
    certificateId: string
  ): Promise<{ certificateId: string; certificateVersion: string }> {
    const prepared = await this.prepareForHost({
      sslEnabled: true,
      sslCertificateId: certificateId,
      internalCertificateId: null,
      nodeId,
    });
    if (!prepared) throw new AppError(409, 'PAGES_CERTIFICATE_INVALID', 'Pages certificate is unavailable');
    try {
      const replicaGeneration = await this.markReplicaById(prepared.assetId, prepared.nodeId, {
        status: 'pending',
        desiredVersion: prepared.version,
        cleanupAfter: null,
        lastError: null,
        incrementGeneration: true,
      });
      await this.nodeDispatch.sendPagesCommand(prepared.nodeId, {
        pagesDeployCertificate: {
          certId: prepared.daemonCertId,
          certPem: prepared.certificatePem,
          keyPem: prepared.keyPem,
          chainPem: prepared.chainPem,
          version: prepared.version,
          replicaGeneration: String(replicaGeneration),
        },
      });
      await this.markReplicaById(prepared.assetId, prepared.nodeId, {
        status: 'ready',
        desiredVersion: prepared.version,
        appliedVersion: prepared.version,
        observedFingerprint: prepared.fingerprint,
        cleanupAfter: null,
        lastError: null,
        lastVerifiedAt: new Date(),
      });
      return { certificateId: prepared.daemonCertId, certificateVersion: prepared.version };
    } catch (error) {
      await this.markReplicaById(prepared.assetId, prepared.nodeId, {
        status: 'failed',
        lastError: safeError(error),
      });
      throw new AppError(500, 'PAGES_CERTIFICATE_DEPLOY_FAILED', 'Failed to deploy the Pages certificate');
    }
  }

  /** Atomically applies a TLS bundle and records only its confirmed deployment. */
  async applyHostBundle(
    host: Pick<ProxyHostRow, 'id' | 'nodeId'>,
    configContent: string,
    prepared: PreparedTlsCertificate,
    configOwnership = '',
    options: HostApplyOptions = {}
  ): Promise<void> {
    const targetNodeId = prepared.nodeId;
    const generation = deploymentGenerationFor(host.id, targetNodeId, configContent, prepared.version);
    if (options.reuseActiveBundle && (await this.bundleIsActive(host.id, targetNodeId, generation, prepared))) {
      const result = await this.nodeDispatch.applyConfig(
        targetNodeId,
        host.id,
        configContent,
        false,
        configOwnership,
        options.deferReload ?? false,
        options.maintenance
      );
      if (result.success) return;
      logger.info('The node rejected the config of its active TLS bundle; sending the full bundle', {
        hostId: host.id,
        nodeId: targetNodeId,
        error: safeError(result.error ?? ''),
      });
    }
    const previousActive = await this.db.query.nginxProxyHostDeployments.findMany({
      where: and(
        eq(nginxProxyHostDeployments.hostId, host.id),
        eq(nginxProxyHostDeployments.nodeId, targetNodeId),
        eq(nginxProxyHostDeployments.state, 'active')
      ),
      columns: { assetId: true },
    });

    const [candidate] = await this.db
      .insert(nginxProxyHostDeployments)
      .values({
        hostId: host.id,
        nodeId: targetNodeId,
        assetId: prepared.assetId,
        generation,
        configContent,
        state: 'candidate',
      })
      .onConflictDoUpdate({
        target: [nginxProxyHostDeployments.hostId, nginxProxyHostDeployments.generation],
        set: {
          configContent,
          assetId: prepared.assetId,
          nodeId: targetNodeId,
          state: 'candidate',
          lastError: null,
          updatedAt: new Date(),
        },
      })
      .returning();

    try {
      const replicaGeneration = await this.markReplicaById(prepared.assetId, targetNodeId, {
        status: 'pending',
        desiredVersion: prepared.version,
        cleanupAfter: null,
        lastError: null,
        incrementGeneration: true,
      });
      const result = await this.nodeDispatch.applyTlsBundle(targetNodeId, {
        hostId: host.id,
        configContent,
        generation,
        configOwnership,
        deferReload: options.deferReload ?? false,
        maintenance: options.maintenance,
        certificates: [
          {
            certId: prepared.daemonCertId,
            certPem: prepared.certificatePem,
            keyPem: prepared.keyPem,
            chainPem: prepared.chainPem,
            version: prepared.version,
            replicaGeneration: String(replicaGeneration),
          },
        ],
      });
      if (!result.success) throw new Error(result.error || 'Daemon TLS bundle apply failed');

      await this.db.transaction(async (tx) => {
        await tx
          .update(nginxProxyHostDeployments)
          .set({ state: 'superseded', updatedAt: new Date() })
          .where(
            and(
              eq(nginxProxyHostDeployments.hostId, host.id),
              eq(nginxProxyHostDeployments.nodeId, targetNodeId),
              eq(nginxProxyHostDeployments.state, 'active')
            )
          );
        await tx
          .update(nginxProxyHostDeployments)
          .set({ state: 'active', appliedAt: new Date(), lastError: null, updatedAt: new Date() })
          .where(eq(nginxProxyHostDeployments.id, candidate.id));
      });
      await this.markReplicaById(prepared.assetId, targetNodeId, {
        status: 'ready',
        desiredVersion: prepared.version,
        appliedVersion: prepared.version,
        observedFingerprint: prepared.fingerprint,
        cleanupAfter: null,
        lastError: null,
        lastVerifiedAt: new Date(),
      });
      for (const assetId of new Set(
        previousActive.map((deployment) => deployment.assetId).filter((assetId): assetId is string => Boolean(assetId))
      )) {
        await this.scheduleReplicaCleanupIfUnused(assetId, targetNodeId);
      }
      this.eventBus?.publish('proxy.host.changed', { id: host.id, action: 'tls_distribution_ready' });
    } catch (error) {
      await this.db
        .update(nginxProxyHostDeployments)
        .set({ state: 'failed', lastError: safeError(error), updatedAt: new Date() })
        .where(eq(nginxProxyHostDeployments.id, candidate.id));
      await this.markReplicaById(prepared.assetId, targetNodeId, {
        status: 'failed',
        lastError: safeError(error),
      });
      // The node rejecting the route's own config is the caller's error, the same as on an HTTP route.
      throw (
        nginxConfigRejection(error instanceof Error ? error.message : String(error), safeError(error)) ??
        new AppError(
          500,
          'NGINX_TLS_BUNDLE_FAILED',
          `Failed to safely activate the TLS proxy configuration: ${safeError(error)}`
        )
      );
    }
  }

  /** The node already runs this exact bundle as far as Gateway recorded it: the deployment and a ready replica. */
  private async bundleIsActive(
    hostId: string,
    nodeId: string,
    generation: string,
    prepared: PreparedTlsCertificate
  ): Promise<boolean> {
    const [deployment] = await this.db
      .select({ id: nginxProxyHostDeployments.id })
      .from(nginxProxyHostDeployments)
      .where(
        and(
          eq(nginxProxyHostDeployments.hostId, hostId),
          eq(nginxProxyHostDeployments.nodeId, nodeId),
          eq(nginxProxyHostDeployments.state, 'active'),
          eq(nginxProxyHostDeployments.generation, generation),
          eq(nginxProxyHostDeployments.assetId, prepared.assetId)
        )
      )
      .limit(1);
    if (!deployment) return false;
    const replica = await this.db.query.nginxCertificateReplicas.findFirst({
      where: and(
        eq(nginxCertificateReplicas.assetId, prepared.assetId),
        eq(nginxCertificateReplicas.nodeId, nodeId),
        eq(nginxCertificateReplicas.status, 'ready'),
        eq(nginxCertificateReplicas.appliedVersion, prepared.version),
        isNull(nginxCertificateReplicas.cleanupAfter)
      ),
      columns: { id: true },
    });
    return Boolean(replica);
  }

  /** Mark deployment inactive only after the caller has removed its config successfully. */
  async deactivateHost(hostId: string, nodeId: string | null): Promise<void> {
    const resolvedNodeId = await this.nodeDispatch.resolveNodeId(nodeId);
    const active = await this.db.query.nginxProxyHostDeployments.findMany({
      where: and(
        eq(nginxProxyHostDeployments.hostId, hostId),
        eq(nginxProxyHostDeployments.nodeId, resolvedNodeId),
        eq(nginxProxyHostDeployments.state, 'active')
      ),
    });
    if (active.length === 0) return;

    await this.db
      .update(nginxProxyHostDeployments)
      .set({ state: 'superseded', updatedAt: new Date() })
      .where(
        and(
          eq(nginxProxyHostDeployments.hostId, hostId),
          eq(nginxProxyHostDeployments.nodeId, resolvedNodeId),
          eq(nginxProxyHostDeployments.state, 'active')
        )
      );

    for (const assetId of new Set(
      active.map((deployment) => deployment.assetId).filter((assetId): assetId is string => Boolean(assetId))
    )) {
      await this.scheduleReplicaCleanupIfUnused(assetId, resolvedNodeId);
    }
  }

  /** Creates or refreshes v2 canonical material after an issuance/upload/renewal. */
  async upsertGatewayAsset(reference: CertificateReference): Promise<AssetRow> {
    const source = await this.loadGatewayMaterial(reference);
    const encrypted = this.encryptAssetMaterial(source);
    const fingerprint = fingerprintFor(source.certificatePem, source.keyPem, source.chainPem);
    const [asset] = await this.db
      .insert(nginxCertificateAssets)
      .values({
        referenceType: reference.type,
        referenceId: reference.id,
        format: 'v2',
        state: 'ready',
        encryptedMaterial: encrypted.encryptedPrivateKey,
        encryptedDek: encrypted.encryptedDek,
        dekIv: encrypted.dekIv,
        fingerprint,
        version: fingerprint,
        migrationError: null,
        migratedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [nginxCertificateAssets.referenceType, nginxCertificateAssets.referenceId],
        set: {
          format: 'v2',
          state: 'ready',
          encryptedMaterial: encrypted.encryptedPrivateKey,
          encryptedDek: encrypted.encryptedDek,
          dekIv: encrypted.dekIv,
          fingerprint,
          version: fingerprint,
          migrationError: null,
          migratedAt: new Date(),
          updatedAt: new Date(),
        },
      })
      .returning();

    this.emitReferenceChanged(reference);
    return asset;
  }

  async syncCertificate(reference: CertificateReference): Promise<{ synchronized: number }> {
    let asset = await this.findAsset(reference);
    if (!asset) {
      asset = await this.upsertGatewayAsset(reference);
    }
    if (asset.format === 'legacy' || asset.state !== 'ready' || !asset.encryptedMaterial || !asset.version) {
      const sourceNodeIds = await this.legacySourceNodeIds(reference);
      if (sourceNodeIds.length === 0) {
        throw new AppError(
          409,
          'NGINX_TLS_LEGACY_SOURCE_UNAVAILABLE',
          'No assigned Nginx node can provide the legacy certificate material'
        );
      }
      asset = await this.importLegacyAsset(reference, asset, sourceNodeIds[0]!);
    }
    this.emitReferenceChanged(reference);
    return { synchronized: 0 };
  }

  async getStatusForSslCertificate(certId: string): Promise<DistributionStatus> {
    return this.getStatusForReference({ type: 'ssl', id: certId });
  }

  async getStatusForHost(
    host: Pick<ProxyHostRow, 'sslEnabled' | 'sslCertificateId' | 'internalCertificateId' | 'nodeId'>
  ) {
    const reference = referenceForHost(host);
    if (!reference) return null;
    const status = await this.getStatusForReference(reference);
    if (!host.nodeId) return status;
    const asset = await this.findAsset(reference);
    if (!asset) return status;
    const replica = await this.db.query.nginxCertificateReplicas.findFirst({
      where: and(eq(nginxCertificateReplicas.assetId, asset.id), eq(nginxCertificateReplicas.nodeId, host.nodeId)),
    });
    return {
      ...status,
      status: replica ? this.uiStatus(replica.status) : status.status,
      lastVerifiedAt: replica?.lastVerifiedAt ?? status.lastVerifiedAt,
      error: replica ? replica.lastError : status.error,
    };
  }

  async getStatusesForSslCertificates(certIds: string[]): Promise<Map<string, DistributionStatus>> {
    const result = new Map<string, DistributionStatus>();
    if (certIds.length === 0) return result;
    const assets = await this.db.query.nginxCertificateAssets.findMany({
      where: and(eq(nginxCertificateAssets.referenceType, 'ssl'), inArray(nginxCertificateAssets.referenceId, certIds)),
    });
    const byReference = new Map(assets.map((asset) => [asset.referenceId, asset]));
    const replicas = assets.length
      ? await this.db.query.nginxCertificateReplicas.findMany({
          where: inArray(
            nginxCertificateReplicas.assetId,
            assets.map((asset) => asset.id)
          ),
        })
      : [];
    const replicaNodes = await this.getReplicaNodes(replicas);
    for (const certId of certIds) {
      const asset = byReference.get(certId);
      result.set(
        certId,
        this.aggregateStatus(
          asset,
          asset ? replicas.filter((replica) => replica.assetId === asset.id) : [],
          replicaNodes
        )
      );
    }
    return result;
  }

  /**
   * Runs on reconnect and periodically. Verifies ready replicas and retries
   * failed or stuck pending pushes that still back an active deployment,
   * with exponential backoff per replica. Legacy daemons get their failed
   * legacy pushes retried the same way.
   */
  async reconcileIntegrity(nodeId?: string, options: { reconnect?: boolean } = {}): Promise<void> {
    const targets = nodeId
      ? [nodeId]
      : (
          await this.db
            .select({ id: nodes.id })
            .from(nodes)
            .where(and(eq(nodes.type, 'nginx'), eq(nodes.status, 'online')))
        ).map((node) => node.id);

    for (const targetNodeId of targets) {
      const node = await this.getNode(targetNodeId);
      if (!node) continue;
      if (!nodeHasDistributionCapability(node.capabilities)) {
        if (node.type === 'nginx') {
          await this.retryLegacyReplicas(targetNodeId, { ignoreBackoff: options.reconnect === true });
        }
        continue;
      }
      const replicas = await this.db.query.nginxCertificateReplicas.findMany({
        where: and(
          eq(nginxCertificateReplicas.nodeId, targetNodeId),
          inArray(nginxCertificateReplicas.status, ['ready', 'failed', 'pending']),
          isNull(nginxCertificateReplicas.cleanupAfter)
        ),
      });
      if (replicas.length === 0) continue;
      const assets = await this.db.query.nginxCertificateAssets.findMany({
        where: inArray(
          nginxCertificateAssets.id,
          replicas.map((replica) => replica.assetId)
        ),
      });
      const assetsById = new Map(assets.map((asset) => [asset.id, asset]));

      // Failed pushes, and pending ones whose command can no longer be in
      // flight, are re-applied from the active deployment once due.
      for (const replica of replicas) {
        if (replica.status === 'ready' || !isRepairDue(replica)) continue;
        const asset = assetsById.get(replica.assetId);
        if (!asset?.fingerprint || !asset.version) continue;
        await this.repairReplica(asset, targetNodeId);
      }

      const readyReplicas = replicas.filter((replica) => replica.status === 'ready');
      if (readyReplicas.length === 0) continue;
      const readyAssets = [...new Set(readyReplicas.map((replica) => replica.assetId))]
        .map((assetId) => assetsById.get(assetId))
        .filter((asset): asset is AssetRow => Boolean(asset));
      try {
        const inventory = await this.nodeDispatch.inspectCertificates(
          targetNodeId,
          readyAssets.map((asset) => daemonCertId({ type: asset.referenceType, id: asset.referenceId }))
        );
        if (!inventory.success) throw new Error(inventory.error || 'Certificate inventory failed');
        const observed = this.parseInventory(inventory.data);
        for (const replica of readyReplicas) {
          const asset = assetsById.get(replica.assetId);
          if (!asset?.fingerprint || !asset.version) continue;
          const item = observed.get(daemonCertId({ type: asset.referenceType, id: asset.referenceId }));
          if (item?.present && item.fingerprint === asset.fingerprint && item.version === asset.version) {
            await this.markReplicaById(asset.id, targetNodeId, {
              observedFingerprint: item.fingerprint,
              lastVerifiedAt: new Date(),
              lastError: null,
            });
            continue;
          }
          await this.repairReplica(asset, targetNodeId);
        }
      } catch (error) {
        // Keep the last ready state for a node that disappeared between
        // selection and dispatch; the next reconnect or periodic pass runs
        // this path again.
        logger.debug('Skipping integrity reconciliation for unavailable node', {
          nodeId: targetNodeId,
          error: safeError(error),
        });
      }
    }
  }

  /**
   * Retry legacy pushes that failed or never ran (e.g. the node was offline at
   * renewal) and replicas whose delivered version is older than the canonical
   * asset. On reconnect the backoff is skipped: the node was simply unreachable.
   */
  private async retryLegacyReplicas(nodeId: string, options: { ignoreBackoff?: boolean } = {}): Promise<void> {
    const replicas = await this.db.query.nginxCertificateReplicas.findMany({
      where: and(
        eq(nginxCertificateReplicas.nodeId, nodeId),
        inArray(nginxCertificateReplicas.status, ['failed', 'pending', 'daemon_update_required']),
        isNull(nginxCertificateReplicas.cleanupAfter)
      ),
    });
    for (const replica of replicas) {
      if (!options.ignoreBackoff && !isRepairDue(replica)) continue;
      const asset = await this.db.query.nginxCertificateAssets.findFirst({
        where: eq(nginxCertificateAssets.id, replica.assetId),
      });
      if (!asset) continue;
      if (replica.status === 'daemon_update_required' && !isLegacyReplicaOutdated(replica, asset)) continue;
      const hosts = await this.db
        .select({
          id: proxyHosts.id,
          nodeId: proxyHosts.nodeId,
          sslEnabled: proxyHosts.sslEnabled,
          sslCertificateId: proxyHosts.sslCertificateId,
          internalCertificateId: proxyHosts.internalCertificateId,
        })
        .from(proxyHosts)
        .where(
          and(
            eq(proxyHosts.nodeId, nodeId),
            eq(proxyHosts.enabled, true),
            eq(proxyHosts.sslEnabled, true),
            asset.referenceType === 'ssl'
              ? eq(proxyHosts.sslCertificateId, asset.referenceId)
              : and(isNull(proxyHosts.sslCertificateId), eq(proxyHosts.internalCertificateId, asset.referenceId))
          )
        );
      if (hosts.length === 0) continue;
      try {
        await this.deployLegacyCertificateForHost(hosts[0]!, { reapplyHostIds: hosts.map((host) => host.id) });
      } catch (error) {
        await this.markReplicaById(asset.id, nodeId, { incrementRepairAttempts: true });
        logger.warn('Legacy TLS certificate delivery retry failed', {
          nodeId,
          assetId: asset.id,
          error: safeError(error),
        });
        continue;
      }
      await this.clearDistributionIncompleteIfSettled(asset);
    }
  }

  /**
   * An automatic retry delivered the certificate: once no replica of it is
   * still failed or pending, drop the certificate's "Distribution incomplete"
   * message. A renewal failure message is never touched.
   */
  private async clearDistributionIncompleteIfSettled(asset: Pick<AssetRow, 'id' | 'referenceType' | 'referenceId'>) {
    if (asset.referenceType !== 'ssl') return;
    try {
      const [unsettled] = await this.db
        .select({ id: nginxCertificateReplicas.id })
        .from(nginxCertificateReplicas)
        .where(
          and(
            eq(nginxCertificateReplicas.assetId, asset.id),
            inArray(nginxCertificateReplicas.status, ['failed', 'pending']),
            isNull(nginxCertificateReplicas.cleanupAfter)
          )
        )
        .limit(1);
      if (unsettled) return;
      const cleared = await this.db
        .update(sslCertificates)
        .set({ renewalError: null, updatedAt: new Date() })
        .where(
          and(
            eq(sslCertificates.id, asset.referenceId),
            like(sslCertificates.renewalError, `${SSL_DISTRIBUTION_ERROR_PREFIX}%`)
          )
        )
        .returning({ id: sslCertificates.id });
      if (cleared.length > 0) {
        this.eventBus?.publish('ssl.cert.changed', { id: asset.referenceId, action: 'updated' });
      }
    } catch (error) {
      logger.debug('Could not clear the certificate distribution status', {
        assetId: asset.id,
        error: safeError(error),
      });
    }
  }

  async cleanupDueReplicas(): Promise<void> {
    const due = await this.db.query.nginxCertificateReplicas.findMany({
      where: and(
        eq(nginxCertificateReplicas.status, 'cleanup_pending'),
        lte(nginxCertificateReplicas.cleanupAfter, new Date())
      ),
    });
    for (const replica of due) {
      const [active] = await this.db
        .select({ id: nginxProxyHostDeployments.id })
        .from(nginxProxyHostDeployments)
        .where(
          and(
            eq(nginxProxyHostDeployments.assetId, replica.assetId),
            eq(nginxProxyHostDeployments.nodeId, replica.nodeId),
            eq(nginxProxyHostDeployments.state, 'active')
          )
        )
        .limit(1);
      if (active) {
        await this.markReplicaById(replica.assetId, replica.nodeId, { status: 'ready', cleanupAfter: null });
        continue;
      }
      const asset = await this.db.query.nginxCertificateAssets.findFirst({
        where: eq(nginxCertificateAssets.id, replica.assetId),
      });
      if (!asset) continue;
      try {
        const result = await this.nodeDispatch.removeCertificateReplica(
          replica.nodeId,
          daemonCertId({ type: asset.referenceType, id: asset.referenceId }),
          replica.appliedVersion ?? '',
          String(replica.generation)
        );
        if (!result.success) throw new Error(result.error || 'Certificate replica removal failed');
        const removed = await this.db
          .delete(nginxCertificateReplicas)
          .where(
            and(
              eq(nginxCertificateReplicas.id, replica.id),
              eq(nginxCertificateReplicas.generation, replica.generation)
            )
          )
          .returning({ id: nginxCertificateReplicas.id });
        if (removed.length > 0) await this.removeOrphanedSslAsset(asset);
      } catch (error) {
        // A new active binding increments the replica generation while this
        // cleanup command is in flight. Never turn that newer state into a
        // failure merely because its stale tombstone was rejected.
        const current = await this.db.query.nginxCertificateReplicas.findFirst({
          where: eq(nginxCertificateReplicas.id, replica.id),
        });
        if (current?.generation !== replica.generation || current.status !== 'cleanup_pending') continue;
        await this.db
          .update(nginxCertificateReplicas)
          .set({ status: 'failed', lastError: safeError(error), updatedAt: new Date() })
          .where(
            and(
              eq(nginxCertificateReplicas.id, replica.id),
              eq(nginxCertificateReplicas.generation, replica.generation)
            )
          );
      }
    }
  }

  /**
   * Retire an SSL certificate's asset: replicas enter their cleanup grace
   * period, or the asset is dropped when nothing was deployed. Pass the
   * caller's transaction (certificate delete) so a rollback leaves the
   * surviving certificate's replicas untouched.
   */
  async removeSslCertificateAsset(certId: string, executor: DrizzleExecutor = this.db): Promise<void> {
    const asset = await this.findAsset({ type: 'ssl', id: certId }, executor);
    if (!asset) return;
    const replicas = await executor.query.nginxCertificateReplicas.findMany({
      where: eq(nginxCertificateReplicas.assetId, asset.id),
    });
    if (replicas.length === 0) {
      await executor.delete(nginxCertificateAssets).where(eq(nginxCertificateAssets.id, asset.id));
      return;
    }
    for (const replica of replicas) {
      await this.markReplicaById(
        asset.id,
        replica.nodeId,
        {
          status: 'cleanup_pending',
          cleanupAfter: new Date(Date.now() + NGINX_CERTIFICATE_REPLICA_GRACE_MS),
          incrementGeneration: true,
          lastError: null,
        },
        executor
      );
    }
  }

  /**
   * One entry per failed replica that an active route still needs, naming the certificate it carries
   * (`ssl` = SSL certificate id, `internal` = PKI certificate id), so callers can limit it to what a viewer
   * may see.
   */
  async listActiveRepairFailures(): Promise<Array<{ referenceType: 'ssl' | 'internal'; referenceId: string }>> {
    const failed = await this.db
      .select({
        assetId: nginxCertificateReplicas.assetId,
        nodeId: nginxCertificateReplicas.nodeId,
        referenceType: nginxCertificateAssets.referenceType,
        referenceId: nginxCertificateAssets.referenceId,
      })
      .from(nginxCertificateReplicas)
      .innerJoin(nginxCertificateAssets, eq(nginxCertificateAssets.id, nginxCertificateReplicas.assetId))
      .where(eq(nginxCertificateReplicas.status, 'failed'));
    const result: Array<{ referenceType: 'ssl' | 'internal'; referenceId: string }> = [];
    for (const replica of failed) {
      const [active] = await this.db
        .select({ id: nginxProxyHostDeployments.id })
        .from(nginxProxyHostDeployments)
        .where(
          and(
            eq(nginxProxyHostDeployments.assetId, replica.assetId),
            eq(nginxProxyHostDeployments.nodeId, replica.nodeId),
            eq(nginxProxyHostDeployments.state, 'active')
          )
        )
        .limit(1);
      if (active) result.push({ referenceType: replica.referenceType, referenceId: replica.referenceId });
    }
    return result;
  }

  private async repairReplica(asset: AssetRow, nodeId: string): Promise<void> {
    const candidate = await this.findActiveDeployment(asset.id, nodeId);
    if (!candidate) return;
    // Re-pushing configContent races a concurrent host apply unless it runs under
    // the same per-host lock; re-read the deployment once the lock is held.
    await withProxyHostLock(candidate.hostId, () => this.repairReplicaLocked(asset, nodeId, candidate.hostId));
  }

  private async findActiveDeployment(assetId: string, nodeId: string, hostId?: string) {
    const deployments = await this.db.query.nginxProxyHostDeployments.findMany({
      where: and(
        eq(nginxProxyHostDeployments.assetId, assetId),
        eq(nginxProxyHostDeployments.nodeId, nodeId),
        eq(nginxProxyHostDeployments.state, 'active'),
        hostId ? eq(nginxProxyHostDeployments.hostId, hostId) : undefined
      ),
      orderBy: [asc(nginxProxyHostDeployments.createdAt)],
      limit: 1,
    });
    return deployments[0];
  }

  private async repairReplicaLocked(asset: AssetRow, nodeId: string, hostId: string): Promise<void> {
    const deployment = await this.findActiveDeployment(asset.id, nodeId, hostId);
    if (!deployment) return;
    const replica = await this.db.query.nginxCertificateReplicas.findFirst({
      where: and(eq(nginxCertificateReplicas.assetId, asset.id), eq(nginxCertificateReplicas.nodeId, nodeId)),
    });
    if (!replica) return;
    const material = this.decryptAsset(asset);
    try {
      const result = await this.nodeDispatch.applyTlsBundle(nodeId, {
        hostId: deployment.hostId,
        configContent: deployment.configContent,
        generation: deployment.generation,
        certificates: [
          {
            certId: daemonCertId({ type: asset.referenceType, id: asset.referenceId }),
            certPem: Buffer.from(material.certificatePem),
            keyPem: Buffer.from(material.keyPem),
            chainPem: Buffer.from(material.chainPem ?? ''),
            version: material.version,
            replicaGeneration: String(replica.generation),
          },
        ],
      });
      if (!result.success) throw new Error(result.error || 'Certificate repair failed');
      await this.markReplicaById(asset.id, nodeId, {
        status: 'ready',
        desiredVersion: material.version,
        appliedVersion: material.version,
        observedFingerprint: material.fingerprint,
        lastVerifiedAt: new Date(),
        lastError: null,
      });
      this.eventBus?.publish('proxy.host.changed', { id: deployment.hostId, action: 'tls_distribution_repaired' });
    } catch (error) {
      await this.markReplicaById(asset.id, nodeId, {
        status: 'failed',
        lastError: safeError(error),
        incrementRepairAttempts: true,
      });
      this.eventBus?.publish('proxy.host.changed', { id: deployment.hostId, action: 'tls_distribution_failed' });
      return;
    }
    await this.clearDistributionIncompleteIfSettled(asset);
  }

  private async removeOrphanedSslAsset(asset: AssetRow): Promise<void> {
    if (asset.referenceType !== 'ssl') return;
    const [remainingReplica] = await this.db
      .select({ id: nginxCertificateReplicas.id })
      .from(nginxCertificateReplicas)
      .where(eq(nginxCertificateReplicas.assetId, asset.id))
      .limit(1);
    if (remainingReplica) return;
    const source = await this.db.query.sslCertificates.findFirst({
      where: eq(sslCertificates.id, asset.referenceId),
      columns: { id: true },
    });
    if (!source) {
      await this.db.delete(nginxCertificateAssets).where(eq(nginxCertificateAssets.id, asset.id));
    }
  }

  private async importLegacyAsset(
    reference: CertificateReference,
    asset: AssetRow,
    targetNodeId: string
  ): Promise<AssetRow> {
    const sourceNodeIds = await this.legacySourceNodeIds(reference, targetNodeId);
    let daemonUpdateRequired = true;
    let lastError = 'No eligible Nginx daemon is available to import the legacy certificate';

    for (const nodeId of sourceNodeIds) {
      const node = await this.getNode(nodeId);
      if (!node || !nodeHasDistributionCapability(node.capabilities)) continue;
      daemonUpdateRequired = false;
      try {
        const result = await this.nodeDispatch.exportLegacyCertificates(nodeId, [daemonCertId(reference)]);
        if (!result.success) throw new Error(result.error || 'Legacy certificate export failed');
        const candidate = this.parseLegacyExport(result.data, daemonCertId(reference));
        if (!candidate) throw new Error('Requested legacy certificate was not returned');
        this.validateCertificatePair(candidate.certificatePem, candidate.keyPem);
        const encrypted = this.encryptAssetMaterial(candidate);
        const fingerprint = fingerprintFor(candidate.certificatePem, candidate.keyPem, candidate.chainPem);
        const [migrated] = await this.db
          .update(nginxCertificateAssets)
          .set({
            format: 'v2',
            state: 'ready',
            encryptedMaterial: encrypted.encryptedPrivateKey,
            encryptedDek: encrypted.encryptedDek,
            dekIv: encrypted.dekIv,
            fingerprint,
            version: fingerprint,
            migrationError: null,
            migratedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(nginxCertificateAssets.id, asset.id))
          .returning();
        logger.info('Imported legacy TLS certificate into Gateway canonical storage', {
          assetId: asset.id,
          sourceNodeId: nodeId,
          referenceType: reference.type,
          referenceId: reference.id,
        });
        this.emitReferenceChanged(reference);
        return migrated!;
      } catch (error) {
        lastError = safeError(error);
      }
    }

    if (daemonUpdateRequired) {
      await this.markReplica(asset, targetNodeId, {
        status: 'daemon_update_required',
        lastError:
          'The Nginx daemon must support TLS certificate distribution v2 before this TLS configuration can change',
      });
      throw new AppError(
        409,
        'NGINX_TLS_DAEMON_UPDATE_REQUIRED',
        'Update the selected Nginx daemon before changing this TLS proxy host'
      );
    }

    await this.db
      .update(nginxCertificateAssets)
      .set({ state: 'migration_failed', migrationError: lastError, updatedAt: new Date() })
      .where(eq(nginxCertificateAssets.id, asset.id));
    await this.markReplica(asset, targetNodeId, { status: 'failed', lastError });
    throw new AppError(
      409,
      'NGINX_TLS_MIGRATION_FAILED',
      'Opfield could not import the existing TLS certificate safely'
    );
  }

  private async legacySourceNodeIds(reference: CertificateReference, targetNodeId?: string): Promise<string[]> {
    const rows = await this.db
      .select({ nodeId: proxyHosts.nodeId })
      .from(proxyHosts)
      .where(
        reference.type === 'ssl'
          ? eq(proxyHosts.sslCertificateId, reference.id)
          : eq(proxyHosts.internalCertificateId, reference.id)
      );
    return stableNodeOrder([...rows.map((row) => row.nodeId), targetNodeId]);
  }

  private async assertNodeSupportsDistribution(nodeId: string, asset: AssetRow): Promise<void> {
    const node = await this.getNode(nodeId);
    if (node?.type === 'nginx' && node.status === 'online' && nodeHasDistributionCapability(node.capabilities)) return;
    await this.markReplica(asset, nodeId, {
      status: 'daemon_update_required',
      lastError: 'The selected Nginx daemon does not support TLS certificate distribution v2',
    });
    throw new AppError(
      409,
      'NGINX_TLS_DAEMON_UPDATE_REQUIRED',
      'Update the selected Nginx daemon before changing this TLS proxy host'
    );
  }

  private async getNode(nodeId: string) {
    return this.db.query.nodes.findFirst({ where: eq(nodes.id, nodeId) });
  }

  private async findAsset(
    reference: CertificateReference,
    executor: DrizzleExecutor = this.db
  ): Promise<AssetRow | undefined> {
    return executor.query.nginxCertificateAssets.findFirst({
      where: and(
        eq(nginxCertificateAssets.referenceType, reference.type),
        eq(nginxCertificateAssets.referenceId, reference.id)
      ),
    });
  }

  private async loadGatewayMaterial(reference: CertificateReference): Promise<{
    certificatePem: string;
    keyPem: string;
    chainPem: string | null;
  }> {
    if (reference.type === 'ssl') {
      const cert = await this.db.query.sslCertificates.findFirst({ where: eq(sslCertificates.id, reference.id) });
      if (!cert?.certificatePem || !cert.privateKeyPem) {
        throw new AppError(
          409,
          'TLS_CERTIFICATE_MATERIAL_UNAVAILABLE',
          'Opfield does not have usable certificate material'
        );
      }
      const keyPem = cert.encryptedDek
        ? this.cryptoService.decryptPrivateKey({
            encryptedPrivateKey: cert.privateKeyPem,
            encryptedDek: cert.encryptedDek,
            dekIv: cert.dekIv || '',
          })
        : cert.privateKeyPem;
      this.validateCertificatePair(cert.certificatePem, keyPem);
      // A certificate linked from the internal PKI before its issuer chain was
      // stored still has to be served with its intermediate CAs.
      const chainPem =
        cert.chainPem ||
        (cert.type === 'internal' && cert.internalCertId
          ? await loadCertificateIssuerChainPem(this.db, cert.internalCertId)
          : null);
      return { certificatePem: cert.certificatePem, keyPem, chainPem };
    }

    const cert = await this.db.query.certificates.findFirst({ where: eq(certificates.id, reference.id) });
    if (!cert?.certificatePem || !cert.encryptedPrivateKey || !cert.encryptedDek) {
      throw new AppError(
        409,
        'TLS_CERTIFICATE_MATERIAL_UNAVAILABLE',
        'Opfield does not have usable certificate material'
      );
    }
    // Only an active TLS server leaf from a user CA may be put into service;
    // never decrypt a revoked, client or system-CA key for Nginx.
    const [issuer] = await this.db
      .select({ isSystem: certificateAuthorities.isSystem })
      .from(certificateAuthorities)
      .where(eq(certificateAuthorities.id, cert.caId))
      .limit(1);
    if (cert.status !== 'active' || cert.type !== 'tls-server' || !issuer || issuer.isSystem) {
      throw new AppError(
        409,
        'TLS_CERTIFICATE_NOT_DEPLOYABLE',
        'Only an active TLS server certificate from a non-system CA can be deployed to Nginx'
      );
    }
    const keyPem = this.cryptoService.decryptPrivateKey({
      encryptedPrivateKey: cert.encryptedPrivateKey,
      encryptedDek: cert.encryptedDek,
      dekIv: cert.dekIv || '',
    });
    this.validateCertificatePair(cert.certificatePem, keyPem);
    return { certificatePem: cert.certificatePem, keyPem, chainPem: await loadIssuerChainPem(this.db, cert.caId) };
  }

  /**
   * Refresh the canonical material of an internal PKI certificate that was
   * stored without its issuer chain (before chains were served). Returns true
   * when the asset changed, so the caller re-applies the hosts that use it.
   */
  async refreshMissingIssuerChain(reference: CertificateReference): Promise<boolean> {
    const asset = await this.findAsset(reference);
    if (!asset || asset.format !== 'v2' || asset.state !== 'ready' || !asset.encryptedMaterial || !asset.version) {
      return false;
    }
    if (this.decryptAsset(asset).chainPem) return false;
    const source = await this.loadGatewayMaterial(reference);
    if (!source.chainPem) return false;
    await this.upsertGatewayAsset(reference);
    return true;
  }

  private decryptAsset(asset: AssetRow): {
    certificatePem: string;
    keyPem: string;
    chainPem: string | null;
    fingerprint: string;
    version: string;
  } {
    if (!asset.encryptedMaterial || !asset.encryptedDek || !asset.version || !asset.fingerprint) {
      throw new AppError(
        409,
        'TLS_CERTIFICATE_MATERIAL_UNAVAILABLE',
        'Opfield does not have usable certificate material'
      );
    }
    try {
      const material = JSON.parse(
        this.cryptoService.decryptPrivateKey({
          encryptedPrivateKey: asset.encryptedMaterial,
          encryptedDek: asset.encryptedDek,
          dekIv: asset.dekIv || '',
        })
      ) as { certificatePem?: unknown; keyPem?: unknown; chainPem?: unknown };
      if (typeof material.certificatePem !== 'string' || typeof material.keyPem !== 'string') {
        throw new Error('Invalid encrypted certificate asset');
      }
      const chainPem = typeof material.chainPem === 'string' ? material.chainPem : null;
      this.validateCertificatePair(material.certificatePem, material.keyPem);
      return {
        certificatePem: material.certificatePem,
        keyPem: material.keyPem,
        chainPem,
        fingerprint: asset.fingerprint,
        version: asset.version,
      };
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(
        409,
        'TLS_CERTIFICATE_MATERIAL_INVALID',
        'Opfield could not decrypt the certificate asset safely'
      );
    }
  }

  private encryptAssetMaterial(material: { certificatePem: string; keyPem: string; chainPem: string | null }) {
    return this.cryptoService.encryptPrivateKey(JSON.stringify(material));
  }

  private validateCertificatePair(certificatePem: string, keyPem: string): void {
    try {
      const key = createPrivateKey(keyPem);
      const privatePublic = createPublicKey(key).export({ type: 'spki', format: 'der' });
      const certificatePublic = new X509Certificate(certificatePem).publicKey.export({ type: 'spki', format: 'der' });
      if (!Buffer.from(privatePublic).equals(Buffer.from(certificatePublic))) {
        throw new Error('certificate private key does not match');
      }
    } catch {
      throw new AppError(
        409,
        'TLS_CERTIFICATE_MATERIAL_INVALID',
        'Opfield could not validate the certificate private key'
      );
    }
  }

  private async markReplica(asset: AssetRow, nodeId: string, changes: ReplicaChanges): Promise<number> {
    return this.markReplicaById(asset.id, nodeId, changes);
  }

  private async scheduleReplicaCleanupIfUnused(assetId: string, nodeId: string): Promise<void> {
    const [remaining] = await this.db
      .select({ id: nginxProxyHostDeployments.id })
      .from(nginxProxyHostDeployments)
      .where(
        and(
          eq(nginxProxyHostDeployments.assetId, assetId),
          eq(nginxProxyHostDeployments.nodeId, nodeId),
          eq(nginxProxyHostDeployments.state, 'active')
        )
      )
      .limit(1);
    if (remaining) return;
    await this.markReplicaById(assetId, nodeId, {
      status: 'cleanup_pending',
      cleanupAfter: new Date(Date.now() + NGINX_CERTIFICATE_REPLICA_GRACE_MS),
      incrementGeneration: true,
    });
  }

  private async markReplicaById(
    assetId: string,
    nodeId: string,
    changes: ReplicaChanges,
    executor: DrizzleExecutor = this.db
  ): Promise<number> {
    const { incrementGeneration, incrementRepairAttempts, ...update } = changes;
    // A replica that becomes ready starts a fresh backoff sequence.
    if (update.status === 'ready' && update.repairAttempts === undefined) update.repairAttempts = 0;
    const existing = await executor.query.nginxCertificateReplicas.findFirst({
      where: and(eq(nginxCertificateReplicas.assetId, assetId), eq(nginxCertificateReplicas.nodeId, nodeId)),
    });
    if (!existing) {
      await executor.insert(nginxCertificateReplicas).values({
        assetId,
        nodeId,
        generation: incrementGeneration ? 1 : 0,
        ...update,
        ...(incrementRepairAttempts ? { repairAttempts: 1 } : {}),
      });
      return incrementGeneration ? 1 : 0;
    }
    const nextGeneration = incrementGeneration ? existing.generation + 1 : existing.generation;
    await executor
      .update(nginxCertificateReplicas)
      .set({
        ...update,
        ...(incrementGeneration ? { generation: nextGeneration } : {}),
        ...(incrementRepairAttempts ? { repairAttempts: (existing.repairAttempts ?? 0) + 1 } : {}),
        updatedAt: new Date(),
      })
      .where(eq(nginxCertificateReplicas.id, existing.id));
    return nextGeneration;
  }

  private async getStatusForReference(reference: CertificateReference): Promise<DistributionStatus> {
    const asset = await this.findAsset(reference);
    if (!asset) {
      return {
        status: 'not_deployed',
        replicaCount: 0,
        readyReplicaCount: 0,
        lastVerifiedAt: null,
        error: null,
        replicas: [],
      };
    }
    const replicas = await this.db.query.nginxCertificateReplicas.findMany({
      where: eq(nginxCertificateReplicas.assetId, asset.id),
    });
    return this.aggregateStatus(asset, replicas, await this.getReplicaNodes(replicas));
  }

  private aggregateStatus(
    asset: AssetRow | undefined,
    replicas: ReplicaRow[],
    replicaNodes: Map<string, ReplicaNode> = new Map()
  ): DistributionStatus {
    const deployedReplicas = deployedReplicasOnly(replicas);
    const sorted = [...deployedReplicas].sort(
      (left, right) => (right.lastVerifiedAt?.getTime() ?? 0) - (left.lastVerifiedAt?.getTime() ?? 0)
    );
    const firstError = sorted.find((replica) => replica.lastError)?.lastError ?? asset?.migrationError ?? null;
    const status = deployedReplicas.some((replica) => replica.status === 'failed')
      ? 'failed'
      : deployedReplicas.some((replica) => replica.status === 'daemon_update_required')
        ? 'daemon_update_required'
        : asset?.state === 'migration_failed'
          ? 'failed'
          : deployedReplicas.length === 0
            ? 'not_deployed'
            : deployedReplicas.every((replica) => replica.status === 'ready')
              ? 'ready'
              : 'pending';
    return {
      status,
      replicaCount: deployedReplicas.length,
      readyReplicaCount: deployedReplicas.filter((replica) => replica.status === 'ready').length,
      lastVerifiedAt: sorted[0]?.lastVerifiedAt ?? null,
      error: firstError,
      replicas: deployedReplicas.map((replica) => {
        const node = replicaNodes.get(replica.nodeId);
        return {
          nodeId: replica.nodeId,
          nodeName: node?.displayName || node?.hostname || replica.nodeId,
          nodeSlug: node?.slug ?? null,
          status: this.uiStatus(replica.status) as 'ready' | 'pending' | 'failed' | 'daemon_update_required',
          lastVerifiedAt: replica.lastVerifiedAt,
          error: replica.lastError,
        };
      }),
    };
  }

  private uiStatus(status: typeof nginxCertificateReplicas.$inferSelect.status): DistributionStatus['status'] {
    if (status === 'daemon_update_required') return 'daemon_update_required';
    if (status === 'failed') return 'failed';
    if (status === 'ready') return 'ready';
    if (status === 'cleanup_pending') return 'not_deployed';
    return 'pending';
  }

  private async getReplicaNodes(replicas: ReplicaRow[]): Promise<Map<string, ReplicaNode>> {
    const nodeIds = [...new Set(replicas.map((replica) => replica.nodeId))];
    if (nodeIds.length === 0) return new Map();
    const rows = await this.db.query.nodes.findMany({
      where: inArray(nodes.id, nodeIds),
      columns: { id: true, hostname: true, displayName: true, slug: true },
    });
    return new Map(rows.map((node) => [node.id, node]));
  }

  private parseLegacyExport(data: Buffer, certId: string) {
    try {
      const decoded = JSON.parse(data.toString('utf8')) as {
        certificates?: Array<{ certId?: string; certPem?: string; keyPem?: string; chainPem?: string }>;
      };
      const exported = decoded.certificates?.find((certificate) => certificate.certId === certId);
      if (!exported?.certPem || !exported.keyPem) return null;
      return {
        certificatePem: Buffer.from(exported.certPem, 'base64').toString('utf8'),
        keyPem: Buffer.from(exported.keyPem, 'base64').toString('utf8'),
        chainPem: exported.chainPem ? Buffer.from(exported.chainPem, 'base64').toString('utf8') : null,
      };
    } catch {
      return null;
    }
  }

  private parseInventory(data: Buffer) {
    const result = new Map<string, { present: boolean; version: string; fingerprint: string }>();
    try {
      const decoded = JSON.parse(data.toString('utf8')) as {
        certificates?: Array<{ certId?: string; present?: boolean; version?: string; fingerprint?: string }>;
      };
      for (const item of decoded.certificates ?? []) {
        if (item.certId) {
          result.set(item.certId, {
            present: item.present === true,
            version: item.version ?? '',
            fingerprint: item.fingerprint ?? '',
          });
        }
      }
    } catch {
      // A malformed inventory is treated as a failed integrity command by the
      // caller, never as a reason to delete or overwrite material blindly.
    }
    return result;
  }

  private emptyPaths(): CertificatePaths {
    return { sslCertPath: null, sslKeyPath: null, sslChainPath: null };
  }

  private legacyPaths(id: string, hasChain: boolean): CertificatePaths {
    const paths = this.configGenerator.getCertPaths(id);
    return { sslCertPath: paths.certPath, sslKeyPath: paths.keyPath, sslChainPath: hasChain ? paths.chainPath : null };
  }

  private versionedPaths(id: string, hasChain: boolean): CertificatePaths {
    const paths = this.configGenerator.getVersionedCertPaths(id);
    return { sslCertPath: paths.certPath, sslKeyPath: paths.keyPath, sslChainPath: hasChain ? paths.chainPath : null };
  }

  private emitReferenceChanged(reference: CertificateReference) {
    if (reference.type === 'ssl') {
      this.eventBus?.publish('ssl.cert.changed', { id: reference.id, action: 'distribution_updated' });
    }
  }
}

export const __testOnly = {
  deploymentGenerationFor,
  isLegacyReplicaOutdated,
  isRepairDue,
  repairDelayMs,
  fingerprintFor,
  nodeHasDistributionCapability,
  safeError,
  stableNodeOrder,
  deployedReplicasOnly,
};
