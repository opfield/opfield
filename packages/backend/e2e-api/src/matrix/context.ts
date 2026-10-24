import type { MatrixConfig } from './config.js';
import { Failure, type MatrixClient, Skip } from './http.js';
import { excerpt, type Report, type Severity } from './report.js';
import type { Rng } from './rng.js';

export const FLEET_ROLES = ['nginx', 'docker', 'storage', 'builder', 'monitoring', 'relay'] as const;
export type FleetRole = (typeof FLEET_ROLES)[number];

export type FleetNode = {
  role: FleetRole;
  nodeId: string;
  name: string;
  operationId?: string;
  resourceId?: string;
  address?: string;
  image?: string;
  /** How the node joined the fleet in this run. */
  origin: 'ordered' | 'installed-existing' | 'reused';
  /** Online and connected after its operation; runtime steps skip nodes that never got there. */
  ready: boolean;
  /** Final hosting operation phase seen by the runner. */
  phase?: string;
};

export type TrackedAsync = {
  kind: string;
  label: string;
  /** Returns the current state and whether it is terminal. */
  poll: () => Promise<{ state: string; terminal: boolean }>;
  startedAt: number;
  deadlineMs: number;
  lastState?: string;
  terminal?: boolean;
};

export type ChaosEvent = { nodeId: string; role: string; at: number; recoveredAt?: number; action: string };

export class MatrixContext {
  readonly fleet = new Map<FleetRole, FleetNode>();
  /** Fleet VMs beyond one per role (install-on-existing); torn down with the fleet. */
  readonly extraFleet: FleetNode[] = [];
  readonly cleanups: Array<{ label: string; run: () => Promise<void> }> = [];
  readonly asyncs: TrackedAsync[] = [];
  readonly chaos: ChaosEvent[] = [];
  /** Every request path template the runner itself used outside the OpenAPI document. */
  readonly undocumentedUsed = new Set<string>();

  constructor(
    readonly config: MatrixConfig,
    readonly client: MatrixClient,
    readonly report: Report,
    readonly rng: Rng
  ) {}

  name(suffix: string) {
    return `${this.config.prefix}${suffix}`
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .slice(0, 60);
  }

  /** The role's fleet node when it is ready, else undefined. */
  node(role: FleetRole) {
    const node = this.fleet.get(role);
    return node?.ready ? node : undefined;
  }

  requireNode(role: FleetRole) {
    const node = this.fleet.get(role);
    if (!node) throw new Skip(`no ${role} node in the fleet`);
    if (!node.ready) throw new Skip(`the fleet ${role} node never became ready`);
    return node;
  }

  onCleanup(label: string, run: () => Promise<void>) {
    this.cleanups.push({ label, run });
  }

  track(entry: Omit<TrackedAsync, 'startedAt'>) {
    this.asyncs.push({ ...entry, startedAt: Date.now() });
  }

  /** Chaos events that overlapped `since`..now, for context in a finding. */
  chaosContext(since: number) {
    const overlapping = this.chaos.filter((event) => (event.recoveredAt ?? Date.now()) >= since);
    return overlapping.length
      ? ` (chaos during this step: ${overlapping.map((event) => `${event.action} ${event.role} at ${new Date(event.at).toISOString()}`).join('; ')})`
      : '';
  }

  /** Runs one named check: a thrown Skip marks it skipped, anything else becomes a finding. Never throws. */
  async step<T>(
    operation: string,
    run: () => Promise<T>,
    options: { invariant?: string; severity?: Severity } = {}
  ): Promise<T | undefined> {
    const started = Date.now();
    try {
      const value = await run();
      this.report.cover(operation, 'exercised', options.invariant ?? 'lifecycle');
      console.log(`  ✓ ${operation} (${Math.round((Date.now() - started) / 1000)}s)`);
      return value;
    } catch (error) {
      if (error instanceof Skip) {
        this.report.cover(operation, 'skipped', undefined, error.message);
        console.log(`  - ${operation}: skipped (${error.message})`);
        return undefined;
      }
      this.report.cover(
        operation,
        'failed',
        options.invariant ?? 'lifecycle',
        error instanceof Error ? error.message.slice(0, 200) : String(error)
      );
      const failure = error instanceof Failure ? error : undefined;
      this.report.add({
        severity: options.severity ?? 'high',
        invariant: options.invariant ?? 'runtime-lifecycle',
        title: `${operation}: ${(error instanceof Error ? error.message : String(error)).split('\n')[0]!.slice(0, 220)}`,
        dedupeKey: `${options.invariant ?? 'runtime-lifecycle'}|${operation}`,
        request: failure?.request
          ? {
              method: failure.request.method,
              path: failure.request.path,
              body: failure.request.body === undefined ? undefined : excerpt(failure.request.body, '', 400),
            }
          : undefined,
        response: failure?.response
          ? { status: failure.response.status, excerpt: excerpt(failure.response.body, failure.response.text) }
          : undefined,
        detail:
          `${error instanceof Error && !(error instanceof Failure) && error.stack ? error.stack.split('\n').slice(0, 3).join(' | ') : ''}${this.chaosContext(started)}`.trim() ||
          undefined,
      });
      return undefined;
    }
  }
}
