import type { AppFamily } from './app-families.js';
import { familyOfMemberType } from './app-families.js';
import type { AppMember } from './app-members.service.js';
import type { AppHealth } from './apps.service.js';

/** A database or storage disk at least this full is a warning. */
export const DISK_ALERT_PERCENT = 80;
/** At least this share of route requests failing with 5xx (over ROUTE_ERROR_WINDOW_MS) is a warning. */
export const ERROR_ALERT_PERCENT = 2;
/** Fewer requests than this in the window prove nothing about the error share (one failed request of three). */
export const ERROR_ALERT_MIN_REQUESTS = 10;
export const ROUTE_ERROR_WINDOW_MS = 5 * 60 * 1000;
/** A running container or deployment restarted at least this often within REPEATED_RESTARTS_WINDOW_MS is degraded. */
export const REPEATED_RESTARTS = 3;
export const REPEATED_RESTARTS_WINDOW_MS = 60 * 60 * 1000;
/**
 * A running container or deployment that Docker restarted at least CRASH_LOOP_RESTARTS times within
 * CRASH_LOOP_WINDOW_MS is in a restart loop and fails: it keeps exiting on its own (a process that crashes some
 * seconds after each start is `running` nearly all the time, as Docker restarts it at once).
 */
export const CRASH_LOOP_RESTARTS = 3;
export const CRASH_LOOP_WINDOW_MS = 10 * 60 * 1000;
/**
 * A node offline at least this long is unreachable: its members are no longer reported from the last snapshot it sent
 * (a short reconnect, such as a daemon update, does not count).
 */
export const NODE_UNREACHABLE_AFTER_MS = 60 * 1000;
/** A route certificate expiring within this many days is a warning (automatic renewal starts 30 days before). */
export const CERT_WARNING_DAYS = 14;

/** How an environment's health is computed, for the API and MCP docs. */
export const APP_HEALTH_RULES = `Environment health (the Apps list and the overview compute it the same way): unknown without members; failing when a member fails; degraded when a member is degraded or a warning is open; else healthy. Every failing member is a destructive alert and every degraded member or warning a warning alert, so the alerts always explain the health. Containers, deployments and Compose projects: stopped on request (through Opfield, the API, MCP or docker stop: exit 0, 130 or 143, or 137 without an OOM kill; a deployment or Compose project stopped through Opfield) is "stopped", shown but neutral, while something else of the environment runs; when every one of them is stopped the environment is degraded (nothing runs). Crashed (another exit code, OOM-killed, dead, in a restart loop: restarted by Docker ${CRASH_LOOP_RESTARTS}+ times in the last ${CRASH_LOOP_WINDOW_MS / 60_000} minutes) is failing; running but restarted ${REPEATED_RESTARTS}+ times in the last hour is degraded; a Compose project with only some services up is degraded; a health check that has not reported yet is neutral ("starting"). Routes: disabled or in maintenance is neutral, but when no route of the environment is enabled and serving it is degraded; a route whose target member was stopped on request is degraded ("its target is stopped"), not failing; an expired certificate fails the route, one whose renewal failed or that expires within ${CERT_WARNING_DAYS} days is degraded. Managed databases and storage stopped or paused are degraded (dependencies). Pages: with a route, degraded unless an enabled route serves an active deployment; without a route, healthy with a ready deployment that has a preview URL, neutral ("not started") before the first deployment is ready, else degraded. A member whose node has been offline for ${NODE_UNREACHABLE_AFTER_MS / 1000} s is degraded ("node unreachable"). Warnings: a database or storage disk at least ${DISK_ALERT_PERCENT}% full; at least ${ERROR_ALERT_PERCENT}% of the routes' requests over the last 5 minutes failing with 5xx (from ${ERROR_ALERT_MIN_REQUESTS} requests on).`;

/**
 * A member's state: `stopped` when it was stopped on request (neutral: it shows, but does not change the health),
 * `none` when it does not count (a disabled route, a route in maintenance, a health check that has not reported).
 */
export type MemberHealth = 'healthy' | 'degraded' | 'failing' | 'stopped' | 'none';
/** Why a member that does not count is shown anyway. */
export type NeutralState = 'disabled' | 'maintenance' | 'starting' | 'not_started';

/** A member's health with the reason a person reads in its alert (degraded or failing) or its neutral badge. */
export interface MemberAssessment {
  health: MemberHealth;
  reason?: string;
  neutral?: NeutralState;
}

/** Alert tones, the same words the console's Notice uses. */
export const APP_OVERVIEW_ALERT_TONES = ['destructive', 'warning'] as const;
export type AppOverviewAlertTone = (typeof APP_OVERVIEW_ALERT_TONES)[number];
export type AppOverviewAlert = {
  tone: AppOverviewAlertTone;
  title: string;
  detail: string;
  href?: string;
  actionLabel?: string;
};

/** What an environment's warnings are computed from, read once per request for the Apps list and the overview. */
export interface MemberSignal {
  /** Database or storage: how full its disk is (latest overview sample). */
  diskPercent?: number | null;
  /** Route: requests and 5xx responses over the last ROUTE_ERROR_WINDOW_MS. */
  requests?: number;
  errors?: number;
}

/** What assessEnvironment needs of a member: the member and its assessed state. */
export interface AssessedMember extends MemberAssessment {
  member: Pick<AppMember, 'type' | 'id' | 'name'>;
}

export type IssueState = 'failing' | 'degraded' | 'stopped' | NeutralState;
export interface EnvironmentIssue {
  family: AppFamily;
  state: IssueState;
  count: number;
}

export interface EnvironmentAssessment {
  health: AppHealth;
  issues: EnvironmentIssue[];
  alerts: AppOverviewAlert[];
  running: number;
  failing: number;
  degraded: number;
  stopped: number;
}

/** failing beats degraded beats healthy; stopped and uncounted members do not change it; no member is healthy. */
export function combineHealth(states: readonly MemberHealth[]): 'healthy' | 'degraded' | 'failing' {
  if (states.includes('failing')) return 'failing';
  if (states.includes('degraded')) return 'degraded';
  return 'healthy';
}

/** The worse of two assessments (failing, degraded, healthy, stopped, none). */
export function worse(left: MemberAssessment, right: MemberAssessment): MemberAssessment {
  const rank: Record<MemberHealth, number> = { failing: 4, degraded: 3, healthy: 2, stopped: 1, none: 0 };
  return rank[right.health] > rank[left.health] ? right : left;
}

/**
 * Warnings that are not one member's state: a database or storage disk at least DISK_ALERT_PERCENT full, and at least
 * ERROR_ALERT_PERCENT of the routes' requests over the last five minutes failing with 5xx (from
 * ERROR_ALERT_MIN_REQUESTS requests on).
 */
export function environmentAlerts(input: {
  envName: string;
  disks: ReadonlyArray<{ name: string; diskPercent: number | null }>;
  routeRequests: number | null;
  routeErrors: number | null;
}): AppOverviewAlert[] {
  const alerts: AppOverviewAlert[] = [];
  for (const entry of input.disks) {
    if (entry.diskPercent != null && entry.diskPercent >= DISK_ALERT_PERCENT) {
      alerts.push({
        tone: 'warning',
        title: `${entry.name} disk is ${Math.round(entry.diskPercent)}% full`,
        detail: 'Free space or grow the volume',
      });
    }
  }
  const { routeRequests, routeErrors } = input;
  if (routeRequests && routeRequests >= ERROR_ALERT_MIN_REQUESTS && routeErrors !== null) {
    const share = (routeErrors / routeRequests) * 100;
    if (share >= ERROR_ALERT_PERCENT) {
      alerts.push({
        tone: 'warning',
        title: `${Math.round(share * 10) / 10}% of requests fail with 5xx`,
        detail: `Routes of ${input.envName}, last 5 minutes`,
      });
    }
  }
  return alerts;
}

const WORKLOAD_TYPES: ReadonlySet<string> = new Set(['container', 'deployment', 'compose']);

/**
 * The health of one environment, the same for the Apps list and the overview. The alerts are its single source: a
 * destructive alert per failing member, a warning per degraded member and per open warning (a nearly full disk, 5xx
 * errors, nothing running, no route serving). Health is failing with a destructive alert, degraded with a warning,
 * else healthy; unknown without members. Issues count members per family and state, neutral ones included.
 */
export function assessEnvironment(input: {
  envName: string;
  statuses: readonly AssessedMember[];
  signals: ReadonlyMap<string, MemberSignal>;
}): EnvironmentAssessment {
  const { statuses } = input;
  const issues = new Map<string, EnvironmentIssue>();
  const alerts: AppOverviewAlert[] = [];
  const familyOf = (status: AssessedMember) => familyOfMemberType(status.member.type);
  for (const status of statuses) {
    const state: IssueState | null =
      status.health === 'failing' || status.health === 'degraded' || status.health === 'stopped'
        ? status.health
        : status.health === 'none'
          ? (status.neutral ?? null)
          : null;
    if (state) {
      const family = familyOf(status);
      const key = `${family}:${state}`;
      const entry = issues.get(key) ?? { family, state, count: 0 };
      entry.count += 1;
      issues.set(key, entry);
    }
    if (status.health === 'failing') {
      alerts.push({
        tone: 'destructive',
        title: `${status.member.name} is failing`,
        detail: status.reason ?? `${familyOf(status)} member of ${input.envName}`,
      });
    } else if (status.health === 'degraded') {
      alerts.push({
        tone: 'warning',
        title: `${status.member.name} is degraded`,
        detail: status.reason ?? `${familyOf(status)} member of ${input.envName}`,
      });
    }
  }
  const signalOf = (status: AssessedMember) => input.signals.get(memberSignalKey(status.member));
  const routes = statuses.filter((status) => status.member.type === 'route');
  const counted = routes.filter((status) => status.neutral !== 'disabled' && status.neutral !== 'maintenance');
  const requests = counted.map((status) => signalOf(status)?.requests).filter((value) => value !== undefined);
  const errors = counted.map((status) => signalOf(status)?.errors).filter((value) => value !== undefined);
  alerts.push(
    ...environmentAlerts({
      envName: input.envName,
      disks: statuses
        .filter((status) => status.member.type === 'database' || status.member.type === 'storage')
        .map((status) => ({ name: status.member.name, diskPercent: signalOf(status)?.diskPercent ?? null })),
      routeRequests: requests.length ? requests.reduce((sum, value) => sum + value, 0) : null,
      routeErrors: errors.length ? errors.reduce((sum, value) => sum + value, 0) : null,
    })
  );
  const workloads = statuses.filter((status) => WORKLOAD_TYPES.has(status.member.type));
  if (workloads.length > 0 && workloads.every((status) => status.health === 'stopped')) {
    alerts.push({
      tone: 'warning',
      title: 'Nothing runs',
      detail: `Every container, deployment and Compose project of ${input.envName} is stopped`,
    });
  }
  if (routes.length > 0 && counted.length === 0) {
    alerts.push({
      tone: 'warning',
      title: 'No route serves traffic',
      detail: `Every route of ${input.envName} is disabled or in maintenance`,
    });
  }
  const health: AppHealth =
    statuses.length === 0
      ? 'unknown'
      : alerts.some((alert) => alert.tone === 'destructive')
        ? 'failing'
        : alerts.length > 0
          ? 'degraded'
          : 'healthy';
  return {
    health,
    issues: [...issues.values()],
    alerts,
    running: statuses.filter((status) => status.health === 'healthy').length,
    failing: statuses.filter((status) => status.health === 'failing').length,
    degraded: statuses.filter((status) => status.health === 'degraded').length,
    stopped: statuses.filter((status) => status.health === 'stopped').length,
  };
}

export function memberSignalKey(member: { type: string; id: string }): string {
  return `${member.type}:${member.id}`;
}
