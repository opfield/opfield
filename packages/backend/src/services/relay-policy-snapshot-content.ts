import { createHash } from 'node:crypto';
import type { relayEndpoints, relayGrantSigningKeys, relayRoutes } from '@/db/schema/index.js';
import type { RelayPublishedPolicyKey } from './relay-policy-signing-key.service.js';
import { RELAY_POLICY_KEY_VALID_FROM_SKEW_MS } from './relay-policy-signing-key.service.js';
import {
  effectiveRelayMaxConcurrentSessions,
  type RelaySessionLimits,
  type RelaySessionLimitTarget,
} from './relay-session-limits.js';

export interface RelayPolicySnapshotInput {
  opfieldInstanceId: string;
  poolId: string;
  relayInstanceId: string;
  grantKeys: Array<Pick<typeof relayGrantSigningKeys.$inferSelect, 'keyId' | 'publicKey'>>;
  assignments: Array<{ endpointId: string; assignmentGeneration: number }>;
  endpoints: Array<typeof relayEndpoints.$inferSelect>;
  routes: Array<typeof relayRoutes.$inferSelect>;
  admission: {
    adaptiveAdmissionEnabled: boolean;
    proxyTargetPressurePercent: number;
    databaseReservePercent: number;
    hardPressurePercent: number;
  };
  policyKeys: RelayPublishedPolicyKey[];
  routePolicy: (ownerKind: string, target?: RelaySessionLimitTarget) => Record<string, unknown>;
  /** Connection limits of the managed databases behind endpoints; their links take the database's limit. */
  sessionLimits?: RelaySessionLimits;
  /** What the relay instance supports that changes classes and caps (its reported features). */
  limitTarget?: RelaySessionLimitTarget;
  /** Availability lease gate ids of lease-mode endpoints and routes. */
  leaseGate: { endpoints: Map<string, string>; routes: Map<string, string> } | null;
  /** Availability lease blocks and key rotations carried by every relay envelope. */
  lease: { leaseBlocks: unknown[]; leaseKeyRotations: unknown[] } | null;
}

const byText = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

/**
 * Everything a relay policy snapshot carries except its revision and lease, in a stable order.
 * Two builds from the same policy produce the same content, whatever order the database returned.
 */
export function relayPolicySnapshotContent(input: RelayPolicySnapshotInput) {
  const endpointById = new Map(input.endpoints.map((endpoint) => [endpoint.id, endpoint]));
  const assignments = [...input.assignments].sort(
    (left, right) => byText(left.endpointId, right.endpointId) || left.assignmentGeneration - right.assignmentGeneration
  );
  const routes = [...input.routes].sort((left, right) => byText(left.id, right.id));
  // Grouped once (in id order): filtering every route per assignment cost assignments x routes per build.
  const routesByEndpoint = new Map<string, typeof routes>();
  for (const route of routes) {
    const group = routesByEndpoint.get(route.targetEndpointId) ?? [];
    group.push(route);
    routesByEndpoint.set(route.targetEndpointId, group);
  }
  return {
    schemaVersion: 2,
    opfieldInstanceId: input.opfieldInstanceId,
    poolId: input.poolId,
    relayInstanceId: input.relayInstanceId,
    grantPublicKeys: [...input.grantKeys]
      .sort((left, right) => byText(left.keyId, right.keyId))
      .map((key) => ({ keyId: key.keyId, publicKey: Buffer.from(key.publicKey, 'base64') })),
    endpoints: assignments.flatMap((assignment) => {
      const endpoint = endpointById.get(assignment.endpointId);
      if (!endpoint) return [];
      return [
        {
          endpointId: endpoint.id,
          generation: String(endpoint.generation),
          subjectKind: endpoint.subjectKind,
          subjectId: endpoint.subjectId,
          certificateSha256: endpoint.certificateSha256,
          maxConcurrentSessions: effectiveRelayMaxConcurrentSessions(endpoint, input.sessionLimits, input.limitTarget),
          poolId: input.poolId,
          relayInstanceId: input.relayInstanceId,
          assignmentGeneration: String(assignment.assignmentGeneration),
          ...(input.leaseGate?.endpoints.get(endpoint.id)
            ? { leasePolicyId: input.leaseGate.endpoints.get(endpoint.id) }
            : {}),
          // A relay-local endpoint (an availability set's Keeper witness): served by the relay itself on its loopback.
          ...(endpoint.relayLocalPort ? { relayLocalPort: endpoint.relayLocalPort } : {}),
        },
      ];
    }),
    routes: assignments.flatMap((assignment) =>
      (routesByEndpoint.get(assignment.endpointId) ?? []).map((route) => ({
        routeId: route.id,
        generation: String(route.generation),
        sourceKind: route.sourceKind,
        sourceId: route.sourceId,
        sourceCertificateSha256: route.sourceCertificateSha256,
        targetEndpointId: route.targetEndpointId,
        maxConcurrentSessions: effectiveRelayMaxConcurrentSessions(route, input.sessionLimits, input.limitTarget),
        maxFrameBytes: route.maxFrameBytes,
        ...input.routePolicy(route.ownerKind, input.limitTarget),
        assignmentGeneration: String(assignment.assignmentGeneration),
        ...(input.leaseGate?.routes.get(route.id) ? { leasePolicyId: input.leaseGate.routes.get(route.id) } : {}),
      }))
    ),
    admissionPolicy: {
      enabled: input.admission.adaptiveAdmissionEnabled,
      proxyTargetPressurePercent: input.admission.proxyTargetPressurePercent,
      databaseReservePercent: input.admission.databaseReservePercent,
      hardPressurePercent: input.admission.hardPressurePercent,
    },
    capabilities: ['relay_pool_v1'],
    policySigningKeys: [...input.policyKeys]
      .sort((left, right) => byText(left.keyId, right.keyId))
      .map((key) => ({
        keyId: key.keyId,
        publicKey: key.publicKey,
        publicKeyFingerprint: key.fingerprint,
        status: key.status === 'pending' ? 'active' : key.status,
        // Relays check validFrom against their own clock; start it early by the skew they allow.
        validFromUnix: String(
          key.activatedAt ? Math.floor((key.activatedAt.getTime() - RELAY_POLICY_KEY_VALID_FROM_SKEW_MS) / 1000) : 0
        ),
        verifyUntilUnix: String(key.verifyUntil ? Math.floor(key.verifyUntil.getTime() / 1000) : 0),
      })),
    ...(input.lease ? { leaseBlocks: input.lease.leaseBlocks, leaseKeyRotations: input.lease.leaseKeyRotations } : {}),
  };
}

export type RelayPolicySnapshotContent = ReturnType<typeof relayPolicySnapshotContent>;

/**
 * Identifies snapshot content, its signer and the lease length the relay gets. The revision and
 * the lease's issue and expiry times are deliberately not part of it.
 */
export function relayPolicySnapshotKey(
  content: RelayPolicySnapshotContent,
  signingKeyId: string,
  leaseSeconds: number
): string {
  const stable = JSON.stringify({ content, signingKeyId, leaseSeconds }, (_key, value) =>
    value && typeof value === 'object' && value.type === 'Buffer' && Array.isArray(value.data)
      ? Buffer.from(value.data).toString('base64')
      : value
  );
  return createHash('sha256').update(stable).digest('hex');
}
