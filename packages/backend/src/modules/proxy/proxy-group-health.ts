/**
 * Health of a route served by an ingress group. Daemon probes (Secure Link and Pages routes) run through every
 * member; a direct upstream is probed once from Opfield and the members' own ingress health is folded in. The route
 * is `online` when every member serves it, `degraded` when some member fails, and `offline` when none does.
 */
export type MemberProbeStatus = 'online' | 'offline' | 'skipped' | 'deferred' | 'unknown';

export interface MemberProbeOutcome {
  nodeId: string;
  status: MemberProbeStatus;
  responseMs?: number;
  error?: string;
}

export type GroupRouteHealthStatus = 'online' | 'degraded' | 'offline' | 'skipped' | 'deferred' | 'unknown';

export interface GroupRouteHealth {
  status: GroupRouteHealthStatus;
  responseMs?: number;
  members: Array<{ nodeId: string; status: MemberProbeStatus; error?: string }>;
}

/**
 * Combines per-member probe outcomes. Members whose probe could not run this time (`skipped`: daemon busy,
 * `deferred`: reconnecting after an Opfield start) do not count; when nothing could run the sample is skipped (or
 * deferred). A member whose probe is `unknown` (the probe is unavailable there) does not count either.
 */
export function aggregateMemberOutcomes(outcomes: readonly MemberProbeOutcome[]): GroupRouteHealth {
  const members = outcomes.map(({ nodeId, status, error }) => ({ nodeId, status, ...(error ? { error } : {}) }));
  const decided = outcomes.filter((outcome) => outcome.status === 'online' || outcome.status === 'offline');
  if (decided.length === 0) {
    const status: GroupRouteHealthStatus = outcomes.some((outcome) => outcome.status === 'skipped')
      ? 'skipped'
      : outcomes.some((outcome) => outcome.status === 'deferred')
        ? 'deferred'
        : 'unknown';
    return { status, members };
  }
  const online = decided.filter((outcome) => outcome.status === 'online');
  const times = online.map((outcome) => outcome.responseMs).filter((value): value is number => value != null);
  return {
    status: online.length === decided.length ? 'online' : online.length > 0 ? 'degraded' : 'offline',
    ...(times.length > 0
      ? { responseMs: Math.round(times.reduce((sum, value) => sum + value, 0) / times.length) }
      : {}),
    members,
  };
}

/**
 * A direct upstream is probed once from Opfield; the route still depends on every member serving it. A member that
 * is disconnected or whose ingress health endpoint reports it is not serving makes an `online` route `degraded`. A
 * disconnected member expected back (`reconnecting`: its stream just closed, or the local relay restarts) is not
 * judged yet.
 */
export function withMemberIngressHealth(
  status: 'online' | 'offline',
  members: ReadonlyArray<{ nodeId: string; connected: boolean; serving: boolean | null; reconnecting?: boolean }>
): GroupRouteHealth {
  const outcomes = members.map((member) => ({
    nodeId: member.nodeId,
    status: (!member.connected && member.reconnecting
      ? 'deferred'
      : member.connected && member.serving !== false
        ? status
        : 'offline') as MemberProbeStatus,
    ...(!member.connected
      ? { error: 'The ingress node is not connected' }
      : member.serving === false
        ? { error: 'The ingress node reports that it is not serving' }
        : {}),
  }));
  if (status === 'offline') return { status: 'offline', members: outcomes };
  return aggregateMemberOutcomes(outcomes);
}
