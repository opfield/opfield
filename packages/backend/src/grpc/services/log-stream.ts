import type { ServerDuplexStream } from '@grpc/grpc-js';
import { and, eq } from 'drizzle-orm';
import { nodes, proxyHosts } from '@/db/schema/index.js';
import { createChildLogger } from '@/lib/logger.js';
import { logRelay, NGINX_LOG_SUBSCRIBE_ACK_EVENT } from '@/modules/monitoring/log-relay.service.js';
import type { LogStreamControl, LogStreamMessage } from '../generated/types.js';
import { extractDaemonCertificateIdentity, normalizeCertificateSerial } from '../interceptors/auth.js';
import { matchEnrolledNodeCertificate } from '../node-certificate.js';
import type { GrpcServerDeps } from '../server.js';

const logger = createChildLogger('GrpcLogStream');
const MAX_HOST_OWNERSHIP_CACHE_SIZE = 512;
const HOST_OWNERSHIP_CACHE_TTL_MS = 5_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type HostOwnershipCacheEntry = {
  allowed: boolean;
  expiresAt: number;
};

export function createLogStreamHandlers(deps: GrpcServerDeps) {
  return {
    StreamLogs(stream: ServerDuplexStream<LogStreamMessage, LogStreamControl>) {
      let nodeId: string | null = null;
      let closed = false;
      const clearAssociatedLogStream = () => {
        if (!nodeId) return;
        const connectedNode = deps.registry.getNode(nodeId);
        if (connectedNode?.logStream === stream) {
          connectedNode.logStream = null;
        }
      };

      stream.on('end', () => {
        closed = true;
        logger.debug('Log stream ended', { nodeId });
        clearAssociatedLogStream();
        stream.end();
      });

      stream.on('error', (err) => {
        closed = true;
        logger.warn('Log stream error', { nodeId, error: err.message });
        clearAssociatedLogStream();
      });

      void (async () => {
        // Identify the node from its authorized mTLS client certificate.
        const certIdentity = extractDaemonCertificateIdentity(stream as any);
        if (!certIdentity) {
          logger.warn('Log stream rejected: missing or unauthorized mTLS client certificate');
          stream.end();
          return;
        }
        const authenticatedNodeId = certIdentity.nodeId;
        nodeId = authenticatedNodeId;
        const initialConnectedNode = deps.registry.getNode(authenticatedNodeId);
        const initialConnectionId = initialConnectedNode?.connectionId;
        if (!initialConnectedNode || !initialConnectionId) {
          // A daemon opens its log stream right after it sent Register; the registration may not have finished
          // yet (every Opfield or daemon restart). The daemon opens it again, so this is not worth a warning.
          logger.debug('Log stream rejected: node is not connected yet', { nodeId });
          stream.end();
          return;
        }

        const [node] = await deps.db
          .select({
            certificateSerial: nodes.certificateSerial,
            certificateFingerprint: nodes.certificateFingerprint,
            pendingCertificateSerial: nodes.pendingCertificateSerial,
            pendingCertificateFingerprint: nodes.pendingCertificateFingerprint,
            status: nodes.status,
            type: nodes.type,
          })
          .from(nodes)
          .where(eq(nodes.id, authenticatedNodeId))
          .limit(1);

        if (!node || node.status === 'pending' || !node.certificateSerial) {
          logger.warn('Log stream rejected: node is not enrolled', { nodeId });
          stream.end();
          return;
        }
        // A staged renewal certificate is as valid as the current one until
        // the command stream promotes it.
        if (!matchEnrolledNodeCertificate(node, certIdentity)) {
          logger.warn('Log stream rejected: certificate does not match enrolled node', {
            nodeId,
            presentedSerial: certIdentity.serialNumber,
            storedSerial: normalizeCertificateSerial(node.certificateSerial),
          });
          stream.end();
          return;
        }
        if (closed) return;

        logger.debug('Log stream opened', { nodeId });

        // Associate the log stream with the connected node in the registry.
        const connectedNode = deps.registry.getNode(nodeId);
        if (!connectedNode || connectedNode.connectionId !== initialConnectionId) {
          logger.warn('Log stream rejected: node connection changed during authentication', { nodeId });
          stream.end();
          return;
        }
        if (closed) return;
        connectedNode.logStream = stream as any;
        logger.debug('Log stream associated with node', { nodeId });

        const hostOwnershipCache = new Map<string, HostOwnershipCacheEntry>();
        const isCurrentLogStream = () => !!nodeId && !closed && deps.registry.getNode(nodeId)?.logStream === stream;
        const isHostOwnedByNode = async (hostId: string): Promise<boolean> => {
          if (!UUID_RE.test(hostId)) return false;
          const now = Date.now();
          const cached = hostOwnershipCache.get(hostId);
          if (cached && cached.expiresAt > now) return cached.allowed;
          if (cached) hostOwnershipCache.delete(hostId);
          if (hostOwnershipCache.size >= MAX_HOST_OWNERSHIP_CACHE_SIZE) hostOwnershipCache.clear();

          try {
            const rows = await deps.db
              .select({ id: proxyHosts.id })
              .from(proxyHosts)
              .where(and(eq(proxyHosts.id, hostId), eq(proxyHosts.nodeId, authenticatedNodeId)))
              .limit(1);
            const allowed = rows.length > 0;
            hostOwnershipCache.set(hostId, { allowed, expiresAt: now + HOST_OWNERSHIP_CACHE_TTL_MS });
            return allowed;
          } catch (error) {
            logger.warn('Failed to verify nginx log host ownership', {
              nodeId: authenticatedNodeId,
              hostId,
              error: error instanceof Error ? error.message : String(error),
            });
            return false;
          }
        };

        const handleLogStreamMessage = async (msg: LogStreamMessage) => {
          if (!isCurrentLogStream()) {
            closed = true;
            stream.end();
            return;
          }
          if (msg.subscribeAck) {
            const hostId = msg.subscribeAck.hostId;
            if (!(await isHostOwnedByNode(hostId))) {
              logger.warn('Rejected nginx log subscribe ack for host not owned by node', {
                nodeId: authenticatedNodeId,
                hostId,
              });
              return;
            }
            if (!isCurrentLogStream()) return;
            logger.debug('Log subscribe ack', { nodeId: authenticatedNodeId, hostId });
            logRelay.emit(NGINX_LOG_SUBSCRIBE_ACK_EVENT, { nodeId: authenticatedNodeId, hostId });
          } else if (msg.entry) {
            const hostId = msg.entry.hostId;
            if (!(await isHostOwnedByNode(hostId))) {
              logger.warn('Rejected nginx log entry for host not owned by node', {
                nodeId: authenticatedNodeId,
                hostId,
              });
              return;
            }
            if (!isCurrentLogStream()) return;
            // Relay log entry to SSE consumers via the in-memory relay.
            logRelay.emit('log', {
              nodeId: authenticatedNodeId,
              hostId,
              timestamp: msg.entry.timestamp,
              remoteAddr: msg.entry.remoteAddr,
              method: msg.entry.method,
              path: msg.entry.path,
              status: msg.entry.status,
              bodyBytesSent: msg.entry.bodyBytesSent,
              raw: msg.entry.raw,
              logType: msg.entry.logType || 'access',
              level: msg.entry.level || '',
            });
          }
        };

        stream.on('data', (msg: LogStreamMessage) => {
          handleLogStreamMessage(msg).catch((error) => {
            logger.warn('Failed to handle nginx log stream message', {
              nodeId: authenticatedNodeId,
              error: error instanceof Error ? error.message : String(error),
            });
          });
        });
      })().catch((err) => {
        logger.error('Log stream authentication failed', { error: (err as Error).message });
        stream.end();
      });
    },
  };
}
