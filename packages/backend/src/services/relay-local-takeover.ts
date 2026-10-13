import { and, eq, inArray, ne } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import {
  relayEndpointAssignmentGenerations,
  relayEndpointAssignments,
  relayEndpoints,
  relayInstances,
  relayRoutes,
} from '@/db/schema/index.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import type { EventBusService } from './event-bus.service.js';
import type { RelayPolicyService } from './relay-policy.service.js';
import { drainDeadline, relayDrainGraceMs, relaySessionSplit } from './relay-stream-resume.js';

/**
 * A Relay Pool update recreates the local Compose relay last. When another relay can carry the local relay's
 * workloads, the update drains it like a remote relay first, so its sessions move instead of dropping when the
 * container is recreated. Only the update drains the local relay; an operator cannot.
 *
 * Built-in local services (the internal registry, subject kind `local_service`) are served only by the local relay.
 * A relay that advertises LOCAL_RELAY_DRAIN_CAPABILITY keeps admitting their tunnels while it drains, so they neither
 * move nor count toward the drain; an older relay refuses them too, and is not drained.
 */

type RelayInstanceRow = typeof relayInstances.$inferSelect;

/** The relay refuses only workload tunnels while it drains and keeps serving its built-in local services. */
export const LOCAL_RELAY_DRAIN_CAPABILITY = 'drain_keeps_local_services_v1';
const LOCAL_SERVICE_SUBJECT_KIND = 'local_service';
const EVACUATION_POLL_MS = 2_000;

/**
 * The workloads the local relay carries sessions for: endpoints of its active assignments that some route targets,
 * built-in local services aside.
 */
async function localRelayRoutedEndpoints(db: DrizzleClient, localInstanceId: string) {
  const assigned = await db
    .selectDistinct({ id: relayEndpoints.id })
    .from(relayEndpointAssignments)
    .innerJoin(
      relayEndpointAssignmentGenerations,
      eq(relayEndpointAssignments.assignmentGenerationId, relayEndpointAssignmentGenerations.id)
    )
    .innerJoin(relayEndpoints, eq(relayEndpointAssignmentGenerations.endpointId, relayEndpoints.id))
    .where(
      and(
        eq(relayEndpointAssignments.relayInstanceId, localInstanceId),
        eq(relayEndpointAssignmentGenerations.state, 'active'),
        eq(relayEndpoints.status, 'active'),
        ne(relayEndpoints.subjectKind, LOCAL_SERVICE_SUBJECT_KIND)
      )
    );
  if (!assigned.length) return [];
  const routed = await db
    .selectDistinct({ id: relayRoutes.targetEndpointId })
    .from(relayRoutes)
    .where(
      inArray(
        relayRoutes.targetEndpointId,
        assigned.map(({ id }) => id)
      )
    );
  const routedIds = new Set(routed.map(({ id }) => id));
  return assigned.filter(({ id }) => routedIds.has(id));
}

/** Why the first update of a local relay without the drain capability interrupts its sessions once: planned. */
export const LOCAL_RELAY_DRAIN_UNSUPPORTED =
  'the running local relay cannot keep serving the internal registry while it drains (it can from the next update on)';

/**
 * Why no other relay can carry the local relay's workloads while an update recreates it, or null when one can: the
 * running local relay keeps its built-in local services through a drain, a connected remote relay is ready with a
 * valid policy (every pool member is its own fault domain), and every workload with a route can move to it. Paths
 * with a daemon without Relay Pool support are served only by the local relay, and a workload whose node reaches no
 * relay off the Opfield host cannot move; a drain would refuse their new sessions for the whole drain instead of
 * dropping the open ones for a second.
 */
export async function localRelayTakeoverBlocker(
  db: DrizzleClient,
  policy: Pick<RelayPolicyService, 'isRemoteInstanceConnected' | 'poolIncapableEndpointIds'>,
  pool: { instances: RelayInstanceRow[]; opfieldHostOnlyEndpointIds: ReadonlySet<string> },
  localInstanceId: string,
  now = Date.now()
): Promise<string | null> {
  const local = pool.instances.find(({ id }) => id === localInstanceId);
  if (!local) return 'the local relay is not in the Relay Pool';
  if (!local.capabilities?.features?.includes(LOCAL_RELAY_DRAIN_CAPABILITY)) return LOCAL_RELAY_DRAIN_UNSUPPORTED;
  const takeover = pool.instances.some(
    (instance) =>
      instance.kind === 'remote' &&
      instance.state === 'ready' &&
      Boolean(instance.capabilities?.features?.includes('relay_pool_v1')) &&
      Boolean(instance.policyExpiresAt && instance.policyExpiresAt.getTime() > now) &&
      Boolean(instance.nodeId && policy.isRemoteInstanceConnected(instance.nodeId))
  );
  if (!takeover) return 'no other relay was ready to take its workloads over';
  const endpoints = await localRelayRoutedEndpoints(db, local.id);
  const endpointIds = endpoints.map(({ id }) => id);
  const legacy = endpointIds.length ? await policy.poolIncapableEndpointIds(endpointIds) : new Set<string>();
  if (legacy.size) {
    return `${legacy.size} workload(s) have a daemon without Relay Pool support on their path, which only the local relay serves`;
  }
  const hostOnly = endpointIds.filter((id) => pool.opfieldHostOnlyEndpointIds.has(id)).length;
  if (hostOnly) return `${hostOnly} workload(s) reach no relay outside the Opfield host`;
  return null;
}

/**
 * The assignment state a relay candidate is issued with. A draining relay's candidates are draining, so sources open
 * no new tunnels through it, except the local relay's for its built-in local services while it keeps admitting them:
 * it is their only relay, and a draining candidate left every internal registry pull without a relay for the whole
 * drain (stand rc.20).
 */
export function candidateAssignmentState(
  assignment: { state: 'active' | 'staging' | 'draining'; instanceState: string; kind: 'local' | 'remote' },
  endpointSubjectKind: string,
  relayCapabilities: readonly string[]
): 'active' | 'staging' | 'draining' {
  if (assignment.instanceState !== 'draining') return assignment.state;
  const keepsServing =
    assignment.kind === 'local' &&
    endpointSubjectKind === LOCAL_SERVICE_SUBJECT_KIND &&
    relayCapabilities.includes(LOCAL_RELAY_DRAIN_CAPABILITY);
  return keepsServing ? assignment.state : 'draining';
}

/** Endpoints of the built-in local services, whose tunnels a draining local relay keeps admitting. */
export async function localServiceEndpointIds(db: DrizzleClient): Promise<Set<string>> {
  const rows = await db
    .select({ id: relayEndpoints.id })
    .from(relayEndpoints)
    .where(eq(relayEndpoints.subjectKind, LOCAL_SERVICE_SUBJECT_KIND));
  return new Set(rows.map(({ id }) => id));
}

/** A drained relay's tunnels that still have to end: all of them but those to the `kept` endpoints. */
export function drainingTunnels(
  health: { activeTunnels?: number; assignmentTunnels?: Array<{ endpointId: string; activeTunnels: number }> } | null,
  kept?: ReadonlySet<string>
): number {
  const total = Number(health?.activeTunnels ?? 0);
  if (!kept?.size) return total;
  const keptTunnels = (health?.assignmentTunnels ?? [])
    .filter(({ endpointId }) => kept.has(endpointId))
    .reduce((sum, { activeTunnels }) => sum + Number(activeTunnels), 0);
  return Math.max(0, total - keptTunnels);
}

/**
 * Waits until the drained local relay carries no workload with a route any more, the evacuation having moved them
 * to other relays. False at the deadline: some workload could not move, and the drain must not refuse its sessions.
 */
export async function waitForLocalRelayEvacuation(
  db: DrizzleClient,
  localInstanceId: string,
  timeoutMs: number,
  throwIfAbandoned: () => void
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    throwIfAbandoned();
    if (!(await localRelayRoutedEndpoints(db, localInstanceId)).length) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, EVACUATION_POLL_MS));
  }
}

interface LocalRelayDrainDeps {
  db: DrizzleClient;
  policy: Pick<RelayPolicyService, 'setLocalInstanceDrain' | 'reconcileAndSync'> &
    Partial<Pick<RelayPolicyService, 'relayStreamReports' | 'migrateOpfieldStreams'>>;
  audit: Pick<AuditService, 'log'>;
  events: Pick<EventBusService, 'publish'>;
}

/** Drains or resumes the local relay for an update. The command goes first: a relay that refused it is left as it was. */
export async function setLocalRelayUpdateDrain(
  deps: LocalRelayDrainDeps,
  instance: RelayInstanceRow,
  userId: string | null,
  enabled: boolean
): Promise<void> {
  // Resumable sources pace their moves to the drain's deadline; built-in local services stay and do not count.
  const drainDeadlineAt = enabled
    ? drainDeadline(
        instance,
        await relayDrainGraceMs(
          deps.db,
          instance.id,
          'update',
          relaySessionSplit(deps.policy.relayStreamReports?.() ?? [], instance.id).legacy
        )
      )
    : null;
  await deps.policy.setLocalInstanceDrain(enabled);
  // The relay's health reports carry the state from now on; an unavailable relay keeps its own state.
  await deps.db
    .update(relayInstances)
    .set({
      state: enabled ? 'draining' : 'ready',
      drainForcedAt: enabled ? instance.drainForcedAt : null,
      drainDeadlineAt,
      updatedAt: new Date(),
    })
    .where(and(eq(relayInstances.id, instance.id), inArray(relayInstances.state, ['ready', 'draining'])));
  await deps.policy.reconcileAndSync();
  if (enabled) deps.policy.migrateOpfieldStreams?.(instance.id, drainDeadlineAt);
  await deps.audit.log({
    userId,
    action: enabled ? 'relay.instance.drain' : 'relay.instance.resume',
    resourceType: 'relay_instance',
    resourceId: instance.id,
    details: {},
  });
  deps.events.publish('system.relay.health.changed', { poolId: instance.poolId, instanceId: instance.id });
}
