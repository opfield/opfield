import { promises as dns } from 'node:dns';
import net from 'node:net';
import { and, eq } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { notificationAlertStates, notificationWebhooks } from '@/db/schema/index.js';
import { isAlwaysBlockedOutboundIp, isPrivateIp, normalizeIp } from '@/lib/ip-cidr.js';
import { createChildLogger } from '@/lib/logger.js';
import type { NotificationDispatcherService } from './notification-dispatcher.service.js';
import type { NotificationEvaluatorService } from './notification-evaluator.service.js';

const logger = createChildLogger('OpfieldOutboundMonitor');

/** Resource key of the "Gateway lost outbound connectivity" alert (category gateway, event outbound.unavailable). */
export const OPFIELD_OUTBOUND_RESOURCE_ID = 'opfield-outbound';
export const OUTBOUND_CHECK_INTERVAL_MS = 20_000;
const PROBE_TIMEOUT_MS = 5_000;
/** Public endpoints checked besides the webhook targets: a name to resolve and a port to connect to. */
const WELL_KNOWN_TARGETS: OutboundTarget[] = [
  { host: 'one.one.one.one', port: 443 },
  { host: 'dns.google', port: 443 },
];
const MAX_WEBHOOK_TARGETS = 4;

export interface OutboundTarget {
  host: string;
  port: number;
}

/** One target's check: reached, failed (why), or skipped (it resolves to a private address, so it says nothing). */
export type OutboundProbeResult = { reached: true } | { reached: false; error: string } | { skipped: true };
export type OutboundProbe = (target: OutboundTarget) => Promise<OutboundProbeResult>;

function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Resolve the host the way webhook sends do (the system resolver), then open and close a TCP connection. */
export async function probeOutboundTarget(target: OutboundTarget): Promise<OutboundProbeResult> {
  try {
    const literal = normalizeIp(target.host);
    const addresses = literal
      ? [literal]
      : (
          await withTimeout(
            dns.lookup(target.host, { all: true, verbatim: true }),
            PROBE_TIMEOUT_MS,
            `${target.host} did not resolve in time`
          )
        ).map((record) => record.address);
    const publicAddresses = addresses.filter((ip) => !isPrivateIp(ip) && !isAlwaysBlockedOutboundIp(ip));
    if (publicAddresses.length === 0)
      return addresses.length > 0 ? { skipped: true } : { reached: false, error: `${target.host} did not resolve` };
    await new Promise<void>((resolve, reject) => {
      const socket = net.connect({ host: publicAddresses[0], port: target.port });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`${target.host}:${target.port} did not answer in time`));
      }, PROBE_TIMEOUT_MS);
      socket.once('connect', () => {
        clearTimeout(timer);
        socket.end();
        resolve();
      });
      socket.once('error', (error) => {
        clearTimeout(timer);
        socket.destroy();
        reject(error);
      });
    });
    return { reached: true };
  } catch (error) {
    return { reached: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Gateway's own outbound connectivity, checked every OUTBOUND_CHECK_INTERVAL_MS: the hosts of the enabled webhooks and
 * WELL_KNOWN_TARGETS are resolved and connected to. Outbound connectivity is lost when none of the public ones can be
 * reached (webhooks on private addresses say nothing about it and are skipped). It is observed as the gateway event
 * outbound.unavailable ("Gateway lost outbound connectivity"); route alerts whose probes from Gateway failed without an
 * answer fold under that alert while it fires (see NotificationEvaluatorService.foldingParent).
 *
 * A Gateway that never reached any of them since it started (an air-gapped install) is not reported as lost, unless
 * the alert was already firing when it started. When connectivity returns, webhooks paused on unreachable targets send
 * their queues right away.
 */
export class OpfieldOutboundMonitor {
  private reachedSinceStart = false;
  private lost = false;

  constructor(
    private readonly db: DrizzleClient,
    private readonly evaluator: Pick<NotificationEvaluatorService, 'observeStatefulEvent'>,
    private readonly dispatcher: Pick<NotificationDispatcherService, 'resumePausedWebhooks'>,
    private readonly probe: OutboundProbe = probeOutboundTarget
  ) {}

  async run(): Promise<void> {
    const targets = await this.targets();
    const results = await Promise.all(targets.map(async (target) => ({ target, result: await this.probe(target) })));
    const checked = results.filter((entry) => !('skipped' in entry.result));
    const reached = checked.some((entry) => 'reached' in entry.result && entry.result.reached);
    const resource = { type: 'opfield', id: OPFIELD_OUTBOUND_RESOURCE_ID, name: 'Opfield' };

    if (reached || checked.length === 0) {
      this.reachedSinceStart ||= reached;
      const wasLost = this.lost;
      this.lost = false;
      await this.evaluator.observeStatefulEvent(
        'opfield',
        'ok',
        resource,
        {},
        ['outbound.unavailable'],
        OUTBOUND_CHECK_INTERVAL_MS
      );
      if (wasLost) {
        logger.info('Opfield has outbound connectivity again');
        await this.dispatcher.resumePausedWebhooks();
      }
      return;
    }

    if (!this.reachedSinceStart && !(await this.alertFiring())) return;
    if (!this.lost) {
      logger.warn('Opfield cannot reach any outbound target', {
        targets: checked.map((entry) => `${entry.target.host}:${entry.target.port}`),
      });
    }
    this.lost = true;
    const failure = checked.find((entry) => 'error' in entry.result)?.result as { error?: string } | undefined;
    await this.evaluator.observeStatefulEvent(
      'opfield',
      'outbound.unavailable',
      resource,
      { targets: checked.map((entry) => entry.target.host).join(', '), error: failure?.error ?? null },
      ['outbound.unavailable'],
      OUTBOUND_CHECK_INTERVAL_MS
    );
  }

  private async targets(): Promise<OutboundTarget[]> {
    const webhooks = await this.db
      .select({ url: notificationWebhooks.url })
      .from(notificationWebhooks)
      .where(eq(notificationWebhooks.enabled, true));
    const targets = new Map<string, OutboundTarget>();
    for (const { url } of webhooks) {
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue;
        const host = parsed.hostname.replace(/^\[|\]$/g, '');
        const port = Number(parsed.port) || (parsed.protocol === 'https:' ? 443 : 80);
        if (targets.size < MAX_WEBHOOK_TARGETS) targets.set(`${host}:${port}`, { host, port });
      } catch {
        /* not a URL; the webhook's deliveries fail on it */
      }
    }
    for (const target of WELL_KNOWN_TARGETS) targets.set(`${target.host}:${target.port}`, target);
    return [...targets.values()];
  }

  private async alertFiring(): Promise<boolean> {
    const [state] = await this.db
      .select({ id: notificationAlertStates.id })
      .from(notificationAlertStates)
      .where(
        and(
          eq(notificationAlertStates.resourceType, 'opfield'),
          eq(notificationAlertStates.resourceId, OPFIELD_OUTBOUND_RESOURCE_ID),
          eq(notificationAlertStates.status, 'firing')
        )
      )
      .limit(1);
    return !!state;
  }
}
