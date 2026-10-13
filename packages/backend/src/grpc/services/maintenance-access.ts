import * as grpc from '@grpc/grpc-js';
import { eq } from 'drizzle-orm';
import { container } from '@/container.js';
import { nodes } from '@/db/schema/index.js';
import { ProxyMaintenanceAccessService } from '@/modules/proxy/proxy-maintenance-access.service.js';
import { extractDaemonCertificateIdentity } from '../interceptors/auth.js';
import { matchEnrolledNodeCertificate } from '../node-certificate.js';
import type { GrpcServerDeps } from '../server.js';

async function nginxNodeId(call: grpc.ServerUnaryCall<any, any>, deps: GrpcServerDeps): Promise<string | null> {
  const identity = extractDaemonCertificateIdentity(call);
  if (!identity) return null;
  const [node] = await deps.db
    .select({
      type: nodes.type,
      certificateSerial: nodes.certificateSerial,
      certificateFingerprint: nodes.certificateFingerprint,
      pendingCertificateSerial: nodes.pendingCertificateSerial,
      pendingCertificateFingerprint: nodes.pendingCertificateFingerprint,
      status: nodes.status,
    })
    .from(nodes)
    .where(eq(nodes.id, identity.nodeId))
    .limit(1);
  if (!node || node.type !== 'nginx' || node.status === 'pending' || !node.certificateSerial) return null;
  return matchEnrolledNodeCertificate(node, identity) ? identity.nodeId : null;
}

export function createMaintenanceAccessHandlers(deps: GrpcServerDeps) {
  const service = container.resolve(ProxyMaintenanceAccessService);
  return {
    Redeem: async (
      call: grpc.ServerUnaryCall<{ hostId?: string; code?: string }, any>,
      callback: grpc.sendUnaryData<any>
    ) => {
      try {
        const nodeId = await nginxNodeId(call, deps);
        if (!nodeId) return callback({ code: grpc.status.PERMISSION_DENIED, message: 'Enrolled nginx node required' });
        const token = await service.redeem(
          call.request.hostId ?? '',
          nodeId,
          String(
            call.metadata.get('x-opfield-maintenance-host')[0] ??
              // legacy-name: nginx daemons before 2.12.1 send x-gateway-maintenance-host — remove once every node reports none
              call.metadata.get('x-gateway-maintenance-host')[0] ??
              ''
          ),
          call.request.code ?? ''
        );
        callback(null, { allowed: !!token, sessionToken: token ?? '' });
      } catch {
        callback({ code: grpc.status.INTERNAL, message: 'Maintenance access unavailable' });
      }
    },
  };
}
