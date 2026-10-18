/**
 * Relays whose port change runs now (RelayPoolService.changeInstanceServicePort). Their worker restarts on purpose
 * while they are drained, so the runtime status they send meanwhile (offline while the worker restarts, ready on the
 * new port before the change resumed them) does not change their state: they stay draining, are never listed or
 * alerted as offline, and return to the pool when the change resumes them (stand 2.12.6-rc.2, O-10).
 */
const running = new Set<string>();

export function beginPlannedPortChange(instanceId: string): void {
  running.add(instanceId);
}

export function endPlannedPortChange(instanceId: string): void {
  running.delete(instanceId);
}

export function inPlannedPortChange(instanceId: string): boolean {
  return running.has(instanceId);
}

/** The state Opfield records for a relay's runtime report: draining while its planned port change runs. */
export function recordedRelayState<State extends string>(instanceId: string, reported: State): State | 'draining' {
  return running.has(instanceId) ? 'draining' : reported;
}
