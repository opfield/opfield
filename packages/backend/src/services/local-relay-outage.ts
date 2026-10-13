/**
 * Every daemon and every remote relay supervisor reaches Opfield's control plane through the local relay's published
 * port, so the local relay going down (an update or the pool's takeover recreating it, a crash, automatic recovery,
 * an operator's restart) ends every control stream at once while their data moves to remote relays. Such a drop says
 * nothing about the nodes and relays themselves: while the local relay does not serve, and for a reconnect grace
 * after it serves again, a node that dropped is reconnecting, not offline, and a remote relay keeps its placement.
 * A node still away after the grace is handled as offline then, so a real outage that coincides is reported later.
 */

/**
 * How long nodes get to come back once the local relay serves again. Daemons retry their control session at most
 * every 10 s plus jitter (15 s), so a current fleet is back within seconds; daemons from before that cap waited up to
 * 60 s plus jitter (90 s). Two minutes covers both with room for a busy Opfield to register them all.
 */
export const LOCAL_RELAY_RECONNECT_GRACE_MS = 2 * 60_000;
/**
 * Opfield sees the local relay down up to a probe interval and a probe timeout after it went down, and a remote relay
 * reports every 5 s: a remote relay last seen this long before the outage was seen was still up when it began.
 */
export const LOCAL_RELAY_OUTAGE_SLACK_MS = 30_000;
/** While the local relay does not serve, a node's offline decision is looked at again this often. */
export const LOCAL_RELAY_OUTAGE_RECHECK_MS = 5_000;

/** The last time the local relay stopped serving, as the relay supervisor saw it. */
export interface LocalRelayOutage {
  /** When Opfield first saw the local relay not serving, or when an update began recreating it. */
  since: number;
  /** When it served again; null while it still does not. */
  servingAgainAt: number | null;
  /** Recreated by an update or the pool's takeover rather than found down. */
  planned: boolean;
}

/**
 * `restarting`: the local relay does not serve. `reconnecting`: it serves again and nodes are within their reconnect
 * grace. Null when there was no outage or its grace is over.
 */
export type LocalRelayOutagePhase = 'restarting' | 'reconnecting';

export interface LocalRelayOutageSignal {
  /** The last outage of the local relay, over or not; null when there was none. */
  latestOutage(): LocalRelayOutage | null;
  /** Checks the local relay now and records what it finds; at most one check runs at a time. */
  confirmLocalRelay(): Promise<void>;
}

export function localRelayOutagePhase(
  outage: LocalRelayOutage | null | undefined,
  now = Date.now()
): LocalRelayOutagePhase | null {
  if (!outage) return null;
  if (outage.servingAgainAt === null) return 'restarting';
  return now < outage.servingAgainAt + LOCAL_RELAY_RECONNECT_GRACE_MS ? 'reconnecting' : null;
}

/**
 * How long a node that dropped stays reconnecting from now: null when no outage covers it, a recheck interval while
 * the local relay still does not serve (its end is not known yet), else what is left of the reconnect grace.
 */
export function localRelayOutageWaitMs(outage: LocalRelayOutage | null | undefined, now = Date.now()): number | null {
  const phase = localRelayOutagePhase(outage, now);
  if (!phase || !outage) return null;
  if (phase === 'restarting') return LOCAL_RELAY_OUTAGE_RECHECK_MS;
  return Math.max(1_000, outage.servingAgainAt! + LOCAL_RELAY_RECONNECT_GRACE_MS - now);
}

/** Whether a remote relay last seen at `lastSeenAt` was up when the local relay went down. */
export function upWhenLocalRelayWentDown(lastSeenAt: number, outage: LocalRelayOutage | null | undefined): boolean {
  return Boolean(outage && lastSeenAt >= outage.since - LOCAL_RELAY_OUTAGE_SLACK_MS);
}
