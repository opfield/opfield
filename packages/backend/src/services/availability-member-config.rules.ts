import type { AvailabilityMemberConfig } from '@/grpc/generated/types.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Why a node's member runtime refuses this configuration (memberha.Config.Validate on the daemon), or null when it
 * takes it. The vectors in proto/testdata/availability-member-config-v1.json are checked against both, so Opfield
 * never sends a configuration the node is bound to refuse.
 */
export function availabilityMemberConfigError(config: AvailabilityMemberConfig): string | null {
  if (!UUID.test(config.setId) || !UUID.test(config.memberId)) {
    return 'availability member set and member ids must be UUIDs';
  }
  const self = config.members.find((peer) => peer.memberId === config.memberId);
  if (!self?.nodeId || !config.engine) return 'availability member node and engine are required';
  if (config.mode === 'automatic') {
    if (!UUID.test(config.leasePolicyId ?? '')) return "an automatic availability member needs its set's lease policy";
  } else if (config.mode === 'manual') {
    if (config.leasePolicyId) return 'a manual availability member has no lease policy';
  } else {
    return `unknown availability mode "${String(config.mode)}"`;
  }
  return null;
}
